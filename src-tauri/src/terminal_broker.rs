use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

use crate::models::{SessionManager, StatusEvent};
use crate::terminal_command::protocol::{self as nip, InputMode};
use crate::terminal_command::{
    journal::SubmissionJournal,
    state::{
        CommandEvent, CommandIdentity, CommandIntent, CommandLifecycle, CommandPhase,
        ExecutionPlan, FullInputProof,
    },
};
use crate::terminal_integration::{TerminalIntegrationControlEvent, TerminalShellKind};
use crate::terminal_screen::{TerminalScreenModel, TerminalScreenSnapshot};

pub(crate) const TERMINAL_BROKER_FLAG_NAME: &str = "terminal_broker";
pub(crate) const TERMINAL_BROKER_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_BROKER";
pub(crate) const TERMINAL_BROKER_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_SHELL_INTEGRATION_FLAG_NAME: &str = "terminal_shell_integration";
pub(crate) const TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_SHELL_INTEGRATION";
pub(crate) const TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_EXECUTE_FLAG_NAME: &str = "terminal_execute";
pub(crate) const TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE: &str = "SHELLSPAN_TERMINAL_EXECUTE";
pub(crate) const TERMINAL_EXECUTE_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME: &str = "terminal_remote_bound_terminal";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_BOUND_TERMINAL";
pub(crate) const TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME: &str = "terminal_interactive_tools";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_INTERACTIVE_TOOLS";
pub(crate) const TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool =
    cfg!(any(target_os = "macos", target_os = "windows"));
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME: &str =
    "terminal_remote_interactive_tools";
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE: &str =
    "SHELLSPAN_TERMINAL_REMOTE_INTERACTIVE_TOOLS";
pub(crate) const TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED: bool = false;
const DEFAULT_REPLAY_MAX_FRAMES: usize = 512;
const DEFAULT_REPLAY_MAX_BYTES: usize = 1_048_576;
const DEFAULT_CAPTURE_MAX_BYTES: usize = 262_144;
const DEFAULT_CLOSED_SESSION_CAPACITY: usize = 256;
const MAX_FRAME_BYTES: usize = 262_144;
const TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES: u64 = 64;
const TERMINAL_MAX_DIMENSION: u32 = 1_000;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const USER_OWNER_ID: &str = "interactive-user";
const SYSTEM_OWNER_ID: &str = "shellspan-runtime";
#[path = "terminal_command/coordinator.rs"]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "NIP adapter is exercised by real P1 tests; production transport wiring is P2"
    )
)]
mod native_input_coordinator;
pub(crate) use native_input_coordinator::NativeInputCoordinator;

mod types;
pub(crate) use types::*;
use types::{DisplayCommandLifecycle, TerminalRolloutCounters};

mod operation;
pub(crate) use operation::TerminalCommandOperation;
use operation::{command_observation, command_snapshot, next_command_revision};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalInputKind {
    Text,
    Executable,
    NativePrepare,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "NIP private control admission is wired to production in P2"
        )
    )]
    NativeControl,
    NativeDraftClear,
    Binary,
    Key,
    Paste,
    Interrupt,
    SystemControl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalBrokerInputSource {
    User,
    Agent {
        agent_session_id: String,
        task_id: String,
        operation_id: String,
    },
    System {
        operation_id: String,
    },
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalInputRequest {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) lease_id: String,
    pub(crate) input_sequence: u64,
    pub(crate) source: TerminalBrokerInputSource,
    pub(crate) input_kind: TerminalInputKind,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalInputReceipt {
    pub(crate) terminal_session_id: String,
    pub(crate) terminal_generation: u64,
    pub(crate) lease_id: String,
    pub(crate) input_sequence: u64,
    pub(crate) source_owner_id: String,
    pub(crate) accepted_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalReplayBatch {
    pub(crate) frames: Vec<TerminalRawOutputFrame>,
    pub(crate) through_sequence: u64,
    pub(crate) has_more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalWaitReason {
    ScreenChanged,
    OutputObserved,
    LifecycleObserved,
    TextFound,
    Idle,
    Closed,
    TimedOut,
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalWaitRequest {
    pub(crate) after_screen_version: Option<u64>,
    pub(crate) after_output_sequence: Option<u64>,
    pub(crate) after_lifecycle_sequence: Option<u64>,
    pub(crate) text: Option<String>,
    pub(crate) case_sensitive: bool,
    pub(crate) idle: Option<Duration>,
    pub(crate) timeout: Duration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalWaitResult {
    pub(crate) reason: TerminalWaitReason,
    pub(crate) lifecycle_sequence: u64,
    pub(crate) open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot: Option<TerminalScreenSnapshot>,
}

mod session_record;
use session_record::{
    InteractiveInput, SessionRecord, SessionSlot, TerminalBrokerConfig, TransportAttachment,
};

#[derive(Debug)]
struct BrokerState {
    jobs: HashMap<String, crate::terminal_jobs::NativeShellJob>,
    prepared_job_commands: HashMap<String, crate::terminal_jobs::PreparedShellJob>,
    rollout: TerminalBrokerRolloutDecision,
    shell_integration_rollout: TerminalFeatureRolloutDecision,
    terminal_execute_rollout: TerminalFeatureRolloutDecision,
    remote_bound_terminal_rollout: TerminalFeatureRolloutDecision,
    interactive_tools_rollout: TerminalFeatureRolloutDecision,
    remote_interactive_tools_rollout: TerminalFeatureRolloutDecision,
    sessions: HashMap<String, Arc<SessionSlot>>,
    transports: HashMap<String, TransportAttachment>,
    closed_session_order: VecDeque<String>,
}

impl Default for BrokerState {
    fn default() -> Self {
        let rollout = TerminalBrokerRolloutDecision::default();
        Self {
            jobs: HashMap::new(),
            prepared_job_commands: HashMap::new(),
            shell_integration_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_SHELL_INTEGRATION_FLAG_NAME,
                TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                rollout.enabled,
                TerminalBrokerRolloutSource::Default,
                "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
            ),
            terminal_execute_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_EXECUTE_FLAG_NAME,
                TERMINAL_EXECUTE_DEFAULT_ENABLED,
                TERMINAL_EXECUTE_DEFAULT_ENABLED,
                rollout.enabled && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "stopNewRoutingNeverReplayInflightCommands",
            ),
            remote_bound_terminal_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME,
                TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
                TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
                rollout.enabled
                    && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED
                    && TERMINAL_EXECUTE_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "releaseAgentLeasesAndMarkIncompleteCommandsUncertain",
            ),
            interactive_tools_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME,
                TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                rollout.enabled && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "removeToolsRevokeAgentLeasesAndRejectLaterInput",
            ),
            remote_interactive_tools_rollout: TerminalFeatureRolloutDecision::new(
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME,
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                rollout.enabled
                    && TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED
                    && TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED
                    && TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
                TerminalBrokerRolloutSource::Default,
                "removeRemoteToolsRevokeAgentLeasesAndRejectLaterInput",
            ),
            rollout,
            sessions: HashMap::new(),
            transports: HashMap::new(),
            closed_session_order: VecDeque::new(),
        }
    }
}

mod signal;
use signal::BrokerSignal;

#[derive(Clone)]
pub(crate) struct TerminalSessionBroker {
    state: Arc<Mutex<BrokerState>>,
    changed: Arc<BrokerSignal>,
    counters: Arc<TerminalRolloutCounters>,
    submission_journal: SubmissionJournal,
    config: TerminalBrokerConfig,
}

impl Default for TerminalSessionBroker {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::default(),
            config: TerminalBrokerConfig::default(),
        }
    }
}

impl TerminalSessionBroker {
    pub(crate) fn configure_submission_journal(
        &self,
        root: &std::path::Path,
    ) -> Result<(), String> {
        self.submission_journal.configure(root)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn unresolved_submissions(
        &self,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.unresolved()
    }
    pub(crate) fn check_submission_replay(
        &self,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        self.submission_journal
            .ensure_new_operation(agent, task, operation)
    }
    pub(crate) fn submission_recovery_for_agent(
        &self,
        agent: &str,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.unresolved_for_agent(Some(agent))
    }
    pub(crate) fn recovered_submissions_for_agent(
        &self,
        agent: &str,
    ) -> Result<Vec<crate::terminal_command::journal::SubmissionIntent>, String> {
        self.submission_journal.recovered_for_agent(agent)
    }

    #[cfg(test)]
    pub(crate) fn prepare_executable(
        &self,
        transport: &str,
        agent: &str,
        task: &str,
        operation: &str,
    ) -> Result<(), String> {
        let command = {
            let state = self.lock()?;
            let attachment = current_attachment(&state, transport)?.clone();
            let mut record_guard = current_record_mut(&state, transport, &attachment)?;
            let record = &mut *record_guard;
            let command = record
                .active_command
                .clone()
                .ok_or("TERMINAL_COMMAND_NOT_FOUND")?;
            let data = command.lock()?;
            let id = &data.intent.identity;
            if id.agent_session_id != agent || id.task_id != task || id.operation_id != operation {
                return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
            }
            drop(data);
            command
        };
        command.record_submission_intent(&self.submission_journal)
    }

    pub(crate) fn settle_submission(
        &self,
        operation: &TerminalCommandOperation,
    ) -> Result<(), String> {
        let identity = {
            let data = operation.lock()?;
            let cancelled_draft = data.native_protocol
                && data.lifecycle.phase() == CommandPhase::Cancelled
                && data.lifecycle.draft_cleared()
                && !data.lifecycle.may_have_submitted();
            if !data.submission_intent_recorded
                || (!data.lifecycle.ended()
                    && !data.lifecycle.source_rejected()
                    && !cancelled_draft)
            {
                return Ok(());
            }
            data.intent.identity.clone()
        };
        self.submission_journal.settle(&identity)
    }

    #[cfg(test)]
    pub(crate) fn disabled_for_test() -> Self {
        let broker = Self::default();
        broker
            .apply_trusted_rollout(
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .expect("the disabled test rollout must be valid");
        broker
    }

    #[cfg(test)]
    pub(crate) fn set_remote_visible_rollout_for_test(&self, enabled: bool) -> Result<(), String> {
        self.apply_trusted_rollout(
            true,
            TerminalBrokerRolloutSource::Test,
            true,
            TerminalBrokerRolloutSource::Test,
            true,
            TerminalBrokerRolloutSource::Test,
            enabled,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
        )
    }

    pub(crate) fn configure_from_trusted_environment(&self) -> Result<(), String> {
        let (broker, broker_source) = trusted_rollout_value(
            TERMINAL_BROKER_ENVIRONMENT_VARIABLE,
            TERMINAL_BROKER_DEFAULT_ENABLED,
        )?;
        let (integration, integration_source) = trusted_rollout_value(
            TERMINAL_SHELL_INTEGRATION_ENVIRONMENT_VARIABLE,
            TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
        )?;
        let (execute, execute_source) = trusted_rollout_value(
            TERMINAL_EXECUTE_ENVIRONMENT_VARIABLE,
            TERMINAL_EXECUTE_DEFAULT_ENABLED,
        )?;
        let (remote_bound_terminal, remote_bound_terminal_source) = trusted_rollout_value(
            TERMINAL_REMOTE_BOUND_TERMINAL_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
        )?;
        let (interactive_tools, interactive_tools_source) = trusted_rollout_value(
            TERMINAL_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE,
            TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
        )?;
        let (remote_interactive_tools, remote_interactive_tools_source) = trusted_rollout_value(
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_ENVIRONMENT_VARIABLE,
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
        )?;
        self.apply_trusted_rollout(
            broker,
            broker_source,
            integration,
            integration_source,
            execute,
            execute_source,
            remote_bound_terminal,
            remote_bound_terminal_source,
            interactive_tools,
            interactive_tools_source,
            remote_interactive_tools,
            remote_interactive_tools_source,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_trusted_rollout(
        &self,
        broker: bool,
        broker_source: TerminalBrokerRolloutSource,
        integration: bool,
        integration_source: TerminalBrokerRolloutSource,
        execute: bool,
        execute_source: TerminalBrokerRolloutSource,
        remote_bound_terminal: bool,
        remote_bound_terminal_source: TerminalBrokerRolloutSource,
        interactive_tools: bool,
        interactive_tools_source: TerminalBrokerRolloutSource,
        remote_interactive_tools: bool,
        remote_interactive_tools_source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.rollout.enabled && !broker {
            close_all_open_generations(
                &mut state,
                TerminalGenerationCloseReason::BrokerShutdown,
                self.config.closed_session_capacity,
            )?;
        } else if state.shell_integration_rollout.enabled && !(broker && integration) {
            for slot in state.sessions.values() {
                let mut record = slot.lock()?;
                if record.open {
                    degrade_record(&mut record, "shellIntegrationRollback")?;
                    drop(record);
                    slot.notify();
                }
            }
        } else if state.terminal_execute_rollout.enabled && !(broker && integration && execute) {
            for slot in state.sessions.values() {
                let record = slot.lock()?;
                if record.open {
                    if let Some(command) = &record.active_command {
                        settle_command_uncertain(
                            command,
                            record.next_output_sequence.saturating_sub(1),
                        );
                    }
                    drop(record);
                    slot.notify();
                }
            }
        } else if state.remote_bound_terminal_rollout.enabled
            && !(broker && integration && execute && remote_bound_terminal)
        {
            for slot in state.sessions.values() {
                let mut record = slot.lock()?;
                if record.open && record.transport_kind == TerminalTransportKind::SshPty {
                    if let Some(command) = &record.active_command {
                        settle_command_uncertain(
                            command,
                            record.next_output_sequence.saturating_sub(1),
                        );
                    }
                    let agent_lease_revision = record.lease.as_ref().and_then(|lease| {
                        matches!(lease.owner, TerminalLeaseOwner::Agent { .. })
                            .then_some(lease.revision)
                    });
                    if let Some(revision) = agent_lease_revision {
                        let revision = revision.checked_add(1).ok_or_else(counter_exhausted)?;
                        if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
                            return Err(counter_exhausted());
                        }
                        record.lease = Some(user_lease(revision));
                    }
                    drop(record);
                    slot.notify();
                }
            }
        }
        state.rollout = TerminalBrokerRolloutDecision {
            enabled: broker,
            source: broker_source,
            ..TerminalBrokerRolloutDecision::default()
        };
        state.shell_integration_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_SHELL_INTEGRATION_FLAG_NAME,
            integration,
            TERMINAL_SHELL_INTEGRATION_DEFAULT_ENABLED,
            broker,
            integration_source,
            "invalidateIntegrationAndMarkIncompleteCommandsUncertain",
        );
        state.terminal_execute_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_EXECUTE_FLAG_NAME,
            execute,
            TERMINAL_EXECUTE_DEFAULT_ENABLED,
            broker && integration,
            execute_source,
            "stopNewRoutingNeverReplayInflightCommands",
        );
        state.remote_bound_terminal_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_REMOTE_BOUND_TERMINAL_FLAG_NAME,
            remote_bound_terminal,
            TERMINAL_REMOTE_BOUND_TERMINAL_DEFAULT_ENABLED,
            broker && integration && execute,
            remote_bound_terminal_source,
            "releaseAgentLeasesAndMarkIncompleteCommandsUncertain",
        );
        state.interactive_tools_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_INTERACTIVE_TOOLS_FLAG_NAME,
            interactive_tools,
            TERMINAL_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
            broker && integration,
            interactive_tools_source,
            "removeToolsRevokeAgentLeasesAndRejectLaterInput",
        );
        state.remote_interactive_tools_rollout = TerminalFeatureRolloutDecision::new(
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_FLAG_NAME,
            remote_interactive_tools,
            TERMINAL_REMOTE_INTERACTIVE_TOOLS_DEFAULT_ENABLED,
            broker && integration && execute && remote_bound_terminal && interactive_tools,
            remote_interactive_tools_source,
            "removeRemoteToolsRevokeAgentLeasesAndRejectLaterInput",
        );
        Ok(())
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn apply_trusted_phase3_rollout(
        &self,
        broker: bool,
        broker_source: TerminalBrokerRolloutSource,
        integration: bool,
        integration_source: TerminalBrokerRolloutSource,
        execute: bool,
        execute_source: TerminalBrokerRolloutSource,
    ) -> Result<(), String> {
        self.apply_trusted_rollout(
            broker,
            broker_source,
            integration,
            integration_source,
            execute,
            execute_source,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
            false,
            TerminalBrokerRolloutSource::Test,
        )
    }

    pub(crate) fn attach_transport(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        self.attach_transport_with_mode(
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
            InputMode::Raw,
        )
    }

    /// Explicit future adapter entry; no Tauri/production creation path selects
    /// native mode in P1. The choice is immutable for this transport generation.
    pub(crate) fn attach_transport_with_mode(
        &self,
        transport_session_id: &str,
        predecessor_transport_session_id: Option<&str>,
        transport_kind: TerminalTransportKind,
        geometry: TerminalGeometry,
        input_mode: InputMode,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        validate_identifier(transport_session_id, "transport session id")?;
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let record = new_transport_record(
            &state,
            transport_session_id,
            predecessor_transport_session_id,
            transport_kind,
            geometry,
            input_mode,
        )?;
        install_transport_record(&mut state, record, predecessor_transport_session_id).map(Some)
    }

    pub(crate) fn prepare_ssh_native_terminal(
        &self,
        transport: &str,
        predecessor: Option<&str>,
        geometry: TerminalGeometry,
    ) -> Result<PendingSshTerminal, String> {
        validate_identifier(transport, "transport session id")?;
        let state = self.lock()?;
        if !state.remote_bound_terminal_rollout.enabled {
            return Err("TERMINAL_NATIVE_INITIALIZATION_REJECTED".into());
        }
        let record = new_transport_record(
            &state,
            transport,
            predecessor,
            TerminalTransportKind::SshPty,
            geometry,
            InputMode::NativeInline,
        )?;
        Ok(PendingSshTerminal {
            record,
            predecessor: predecessor.map(str::to_owned),
        })
    }

    pub(crate) fn commit_started_ssh_terminal(
        &self,
        sessions: &SessionManager,
        transport: &str,
        predecessor: Option<&str>,
        geometry: TerminalGeometry,
        pending: Option<PendingSshTerminal>,
    ) -> Result<StatusEvent, String> {
        validate_identifier(transport, "transport session id")?;
        // Input admission enqueues through SessionManager under the Broker lock.
        // Take the same locks in the same order when committing a replacement.
        let mut state = self.lock()?;
        let record = if let Some(mut pending) = pending {
            if !state.remote_bound_terminal_rollout.enabled
                || pending.record.transport_session_id != transport
                || pending.predecessor.as_deref() != predecessor
                || pending.record.geometry != geometry
            {
                return Err("TERMINAL_NATIVE_INITIALIZATION_REJECTED".into());
            }
            let interactive_tools =
                effective_interactive_tools_for_transport(&state, TerminalTransportKind::SshPty);
            pending.record.screen_model =
                interactive_tools.then(|| TerminalScreenModel::new(geometry));
            Some(pending.record)
        } else if state.rollout.enabled {
            Some(new_transport_record(
                &state,
                transport,
                predecessor,
                TerminalTransportKind::SshPty,
                geometry,
                InputMode::Raw,
            )?)
        } else {
            None
        };
        let event = sessions.commit_connection_ready(transport, || {
            crate::connection::terminal_deadline::complete()?;
            if let Some(record) = record {
                install_transport_record(&mut state, record, predecessor)?;
            }
            Ok(())
        })?;
        self.changed.notify_all();
        Ok(event)
    }

    pub(crate) fn is_replacement_transport(
        &self,
        previous: &str,
        current: &str,
    ) -> Result<bool, String> {
        let (_, slot) = self.lookup_session_slot(current)?;
        let record = slot.lock()?;
        Ok(record.open
            && record
                .predecessor_transport_session_ids
                .iter()
                .any(|id| id == previous))
    }

    pub(crate) fn attachment_for_transport(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<TerminalBrokerAttachment>, String> {
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        Ok(state
            .transports
            .get(transport_session_id)
            .filter(|attachment| attachment.active)
            .map(|attachment| TerminalBrokerAttachment {
                terminal_session_id: attachment.terminal_session_id.clone(),
                terminal_generation: attachment.terminal_generation,
            }))
    }

    pub(crate) fn close_transport(
        &self,
        transport_session_id: &str,
        reason: TerminalGenerationCloseReason,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(false);
        }
        let Some(attachment) = state.transports.get(transport_session_id).cloned() else {
            return Ok(false);
        };
        let slot = {
            let Some(slot) = state.sessions.get(&attachment.terminal_session_id).cloned() else {
                return Ok(false);
            };
            let mut record = slot.lock()?;
            if !attachment.active
                || !record.open
                || record.terminal_generation != attachment.terminal_generation
                || record.transport_session_id != transport_session_id
            {
                return Ok(false);
            }
            record.close(reason)?;
            drop(record);
            slot
        };
        if let Some(attachment) = state.transports.get_mut(transport_session_id) {
            attachment.active = false;
        }
        remember_closed_session(
            &mut state,
            &attachment.terminal_session_id,
            self.config.closed_session_capacity,
        );
        slot.notify();
        self.changed.notify_all();
        Ok(true)
    }

    fn lookup_session_slot(
        &self,
        transport_session_id: &str,
    ) -> Result<(TransportAttachment, Arc<SessionSlot>), String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let slot = state
            .sessions
            .get(&attachment.terminal_session_id)
            .cloned()
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        Ok((attachment, slot))
    }

    fn lookup_enabled_session_slot(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<(TransportAttachment, Arc<SessionSlot>)>, String> {
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let slot = state
            .sessions
            .get(&attachment.terminal_session_id)
            .cloned()
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        Ok(Some((attachment, slot)))
    }

    fn lookup_session_slot_by_id(
        &self,
        terminal_session_id: &str,
    ) -> Result<Option<Arc<SessionSlot>>, String> {
        let state = self.lock()?;
        Ok(state.sessions.get(terminal_session_id).cloned())
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn attach_local_sandbox_binding(
        &self,
        transport_session_id: &str,
        binding: crate::models::LocalSandboxPtyBinding,
        blocked_domains: Option<Arc<Mutex<Vec<String>>>>,
    ) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Err("TERMINAL_BROKER_UNAVAILABLE".into());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        record.sandbox_binding = Some(binding);
        #[cfg(target_os = "macos")]
        {
            record.sandbox_blocked_domains = blocked_domains;
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = blocked_domains;
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn drain_local_sandbox_blocked_domains(
        &self,
        transport_session_id: &str,
    ) -> Vec<String> {
        let Ok(Some((attachment, slot))) = self.lookup_enabled_session_slot(transport_session_id)
        else {
            return Vec::new();
        };
        let Ok(record) = slot.lock_current(transport_session_id, &attachment) else {
            return Vec::new();
        };
        let Some(handle) = record.sandbox_blocked_domains.as_ref() else {
            return Vec::new();
        };
        handle
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default()
    }

    pub(crate) fn local_sandbox_binding(
        &self,
        transport_session_id: &str,
    ) -> Result<Option<crate::models::LocalSandboxPtyBinding>, String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(None);
        };
        let record = slot.lock_current(transport_session_id, &attachment)?;
        Ok(record.sandbox_binding.clone())
    }

    pub(crate) fn active_sandbox_transports_for_agent(
        &self,
        agent_session_id: &str,
    ) -> Result<Vec<(String, crate::models::LocalSandboxPtyBinding)>, String> {
        let slots: Vec<Arc<SessionSlot>> = {
            let state = self
                .state
                .lock()
                .map_err(|_| "terminal broker state lock poisoned".to_string())?;
            state.sessions.values().cloned().collect()
        };
        let mut matches = Vec::new();
        for slot in slots {
            let Ok(record) = slot.record.lock() else {
                continue;
            };
            if !record.open {
                continue;
            }
            if let Some(binding) = &record.sandbox_binding {
                if binding.agent_session_id == agent_session_id {
                    matches.push((record.transport_session_id.clone(), binding.clone()));
                }
            }
        }
        Ok(matches)
    }

    #[cfg(unix)]
    pub(crate) fn attach_local_echo_probe(
        &self,
        transport_session_id: &str,
        probe: crate::local_terminal_input::PtyEchoProbe,
    ) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        record.echo_probe = Some(probe);
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn detach_local_echo_probe(&self, transport_session_id: &str) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        record.echo_probe = None;
        Ok(())
    }

    #[cfg(any(
        test,
        not(all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        ))
    ))]
    pub(crate) fn observe_raw_output_discard(
        &self,
        transport_session_id: &str,
        bytes: &[u8],
    ) -> Result<bool, String> {
        if bytes.is_empty() {
            return Ok(false);
        }
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(false);
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        let latency_sample_started =
            (record.next_output_sequence % TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES == 1)
                .then(Instant::now);
        let frame = TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            frame_type: "rawOutput",
            sequence: record.next_output_sequence,
            byte_offset: record.next_byte_offset,
            bytes: bytes.to_vec(),
        };
        let accepted = matches!(
            accept_raw_frame(&mut record, frame, self.config, &self.counters)?,
            RawFrameAcceptance::Accepted
        );
        if accepted {
            if let Some(started) = latency_sample_started {
                self.counters.observe_transport_latency(started.elapsed());
            }
        }
        drop(record);
        slot.notify();
        Ok(accepted)
    }

    pub(crate) fn observe_raw_output(
        &self,
        transport_session_id: &str,
        bytes: &[u8],
    ) -> Result<Option<TerminalRawOutputFrame>, String> {
        if bytes.is_empty() {
            return Ok(None);
        }
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(None);
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        let latency_sample_started =
            (record.next_output_sequence % TRANSPORT_LATENCY_SAMPLE_INTERVAL_FRAMES == 1)
                .then(Instant::now);
        let frame = TerminalRawOutputFrame {
            protocol_version: 1,
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            frame_type: "rawOutput",
            sequence: record.next_output_sequence,
            byte_offset: record.next_byte_offset,
            bytes: bytes.to_vec(),
        };
        let accepted =
            match accept_raw_frame(&mut record, frame.clone(), self.config, &self.counters)? {
                RawFrameAcceptance::Accepted => Some(frame),
                RawFrameAcceptance::Duplicate => None,
            };
        if let (Some(_), Some(started)) = (&accepted, latency_sample_started) {
            self.counters.observe_transport_latency(started.elapsed());
        }
        drop(record);
        slot.notify();
        Ok(accepted)
    }

    pub(crate) fn resize(
        &self,
        transport_session_id: &str,
        geometry: TerminalGeometry,
    ) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        record.geometry = geometry;
        if let Some(screen) = &mut record.screen_model {
            screen.resize(geometry)?;
        }
        if let Some(screen) = &mut record.display_screen {
            screen.resize(geometry)?;
        }
        drop(record);
        slot.notify();
        Ok(())
    }

    pub(crate) fn arm_display_recovery(&self, transport: &str, token: &str) -> Result<(), String> {
        if token.is_empty() {
            return Ok(());
        }
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let mut record = slot.lock_current(transport, &attachment)?;
        let geometry = record.geometry;
        record
            .display_screen
            .get_or_insert_with(|| TerminalScreenModel::new(geometry))
            .arm_display_recovery(token);
        if let Some(screen) = record.screen_model.as_mut() {
            screen.arm_display_recovery(token);
        }
        Ok(())
    }

    pub(crate) fn observe_display_output(
        &self,
        transport_session_id: &str,
        text: &str,
    ) -> Result<Option<TerminalDisplayFrame>, String> {
        let (attachment, slot) = {
            let state = self.lock()?;
            if !state.rollout.enabled || !state.transports.contains_key(transport_session_id) {
                return Ok(None);
            }
            let attachment = current_attachment(&state, transport_session_id)?.clone();
            let slot = state
                .sessions
                .get(&attachment.terminal_session_id)
                .cloned()
                .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
            (attachment, slot)
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        let sequence = record
            .display_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        let geometry = record.geometry;
        let text = record
            .display_screen
            .get_or_insert_with(|| TerminalScreenModel::new(geometry))
            .observe_display(sequence, text);
        record.display_sequence = sequence;
        Ok(Some(TerminalDisplayFrame {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            sequence,
            text,
        }))
    }

    pub(crate) fn terminal_display_snapshot(
        &self,
        transport_session_id: &str,
        terminal_session_id: &str,
        terminal_generation: u64,
    ) -> Result<TerminalDisplaySnapshot, String> {
        let (attachment, slot) = self.lookup_session_slot(transport_session_id)?;
        let record = slot.lock_current(transport_session_id, &attachment)?;
        if record.terminal_session_id != terminal_session_id
            || record.terminal_generation != terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let (through_sequence, contents) = record
            .display_screen
            .as_ref()
            .map(TerminalScreenModel::format_display)
            .transpose()?
            .unwrap_or_default();
        Ok(TerminalDisplaySnapshot {
            through_sequence,
            rows: record.geometry.rows,
            columns: record.geometry.columns,
            contents,
        })
    }

    pub(crate) fn set_vim_attached(
        &self,
        transport_session_id: &str,
        editor: Option<crate::terminal_vim_bridge::EditorKind>,
    ) -> Result<bool, String> {
        let (attachment, slot) = self.lookup_session_slot(transport_session_id)?;
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        if record.transport_kind != TerminalTransportKind::SshPty {
            return Err("Vim bridge requires an SSH PTY".into());
        }
        let editor = if record.prompt_ready { None } else { editor };
        let attached = editor.is_some();
        if record.vim_attached != attached || record.vim_editor != editor {
            record.vim_attached = attached;
            record.vim_editor = editor;
            advance_integration_state_revision(&mut record)?;
            drop(record);
            slot.notify();
            return Ok(true);
        }
        Ok(false)
    }

    pub(crate) fn mark_output_ready(&self, transport_session_id: &str) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.output_listener_ready = true;
            Ok(())
        })
    }

    pub(crate) fn set_output_paused(
        &self,
        transport_session_id: &str,
        paused: bool,
    ) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        let entered_backpressure = paused && !record.output_paused;
        record.output_paused = paused;
        if entered_backpressure {
            TerminalRolloutCounters::increment(&self.counters.backpressure);
        }
        Ok(())
    }

    pub(crate) fn shell_integration_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.shell_integration_rollout.enabled)
    }

    pub(crate) fn interactive_tools_enabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.interactive_tools_rollout.enabled)
    }

    pub(crate) fn screen_snapshot(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalScreenSnapshot, String> {
        let slot = {
            let state = self.lock()?;
            if !state.interactive_tools_rollout.enabled {
                return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
            }
            let attachment = current_attachment(&state, transport_session_id)?;
            state
                .sessions
                .get(&attachment.terminal_session_id)
                .cloned()
                .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?
        };
        let record = slot.lock()?;
        record
            .screen_model
            .as_ref()
            .map(|screen| screen.snapshot(&record.terminal_session_id, record.terminal_generation))
            .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())
    }

    pub(crate) fn bracketed_paste_enabled(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        let slot = {
            let state = self.lock()?;
            if !state.interactive_tools_rollout.enabled {
                return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
            }
            let attachment = current_attachment(&state, transport_session_id)?;
            state
                .sessions
                .get(&attachment.terminal_session_id)
                .cloned()
                .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?
        };
        let record = slot.lock()?;
        record
            .screen_model
            .as_ref()
            .map(TerminalScreenModel::bracketed_paste)
            .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())
    }

    pub(crate) fn credential_prompt_active(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        let slot = {
            let state = self.lock()?;
            let attachment = current_attachment(&state, transport_session_id)?;
            state
                .sessions
                .get(&attachment.terminal_session_id)
                .cloned()
                .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?
        };
        let record = slot.lock()?;
        Ok(record.credential_prompt_active())
    }

    pub(crate) fn execution_capabilities(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalExecutionCapabilities, String> {
        let (_, slot) = self.lookup_session_slot(transport_session_id)?;
        let record = slot.lock()?;
        Ok(TerminalExecutionCapabilities {
            terminal_generation: record.terminal_generation,
            open: record.open,
            shell: record.integration_shell,
            prompt_ready: record.prompt_ready,
            integration_capabilities: record.integration_capabilities(),
            input_recovery_required: record.native_recovery_required
                || record.native_clear_pending.is_some(),
        })
    }

    #[cfg(test)]
    pub(crate) fn native_input_enabled(&self, transport_session_id: &str) -> Result<bool, String> {
        let (_, slot) = self.lookup_session_slot(transport_session_id)?;
        let record = slot.lock()?;
        Ok(record.integration_state == TerminalIntegrationState::Ready
            && record.native_input
            && record.native_checkpoints
            && (!matches!(
                record.integration_shell,
                Some(TerminalShellKind::Bash | TerminalShellKind::Zsh)
            ) || record.native_private_control)
            && !record.native_recovery_required)
    }

    pub(crate) fn command_shell(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalShellKind, String> {
        let (_, slot) = self.lookup_session_slot(transport_session_id)?;
        let record = slot.lock()?;
        record
            .integration_shell
            .ok_or_else(|| "TERMINAL_INTEGRATION_NOT_READY".to_string())
    }

    pub(crate) fn native_comments_enabled(
        &self,
        transport_session_id: &str,
    ) -> Result<bool, String> {
        let (_, slot) = self.lookup_session_slot(transport_session_id)?;
        let record = slot.lock()?;
        Ok(record.native_comments)
    }

    #[cfg(test)]
    pub(crate) fn wait_terminal(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
    ) -> Result<TerminalWaitResult, String> {
        self.wait_terminal_observed_inner(transport_session_id, request, true, || {})
    }

    pub(crate) fn wait_terminal_slice(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
        record_timeout: bool,
    ) -> Result<TerminalWaitResult, String> {
        self.wait_terminal_observed_inner(transport_session_id, request, record_timeout, || {})
    }

    #[cfg(test)]
    fn wait_terminal_observed(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
        on_attached: impl FnOnce(),
    ) -> Result<TerminalWaitResult, String> {
        self.wait_terminal_observed_inner(transport_session_id, request, true, on_attached)
    }

    fn wait_terminal_observed_inner(
        &self,
        transport_session_id: &str,
        request: TerminalWaitRequest,
        record_timeout: bool,
        on_attached: impl FnOnce(),
    ) -> Result<TerminalWaitResult, String> {
        let deadline = Instant::now() + request.timeout;
        let state = self.lock()?;
        if !state.interactive_tools_rollout.enabled {
            return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let terminal_session_id = attachment.terminal_session_id;
        let terminal_generation = attachment.terminal_generation;
        let slot = state
            .sessions
            .get(&terminal_session_id)
            .cloned()
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        drop(state);
        on_attached();
        let needle_lower = (!request.case_sensitive)
            .then(|| request.text.as_deref().map(str::to_lowercase))
            .flatten();
        let mut last_checked_screen_version: Option<u64> = None;
        let mut record = slot.lock()?;
        loop {
            if record.terminal_generation != terminal_generation || !record.open {
                return Ok(TerminalWaitResult {
                    reason: TerminalWaitReason::Closed,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: false,
                    snapshot: None,
                });
            }
            let screen = record
                .screen_model
                .as_ref()
                .ok_or_else(|| "TERMINAL_SCREEN_UNAVAILABLE".to_string())?;
            let screen_version = screen.version();
            let through_output_sequence = screen.through_output_sequence();
            let mut snapshot: Option<TerminalScreenSnapshot> = None;
            if let Some(text) = request.text.as_deref() {
                if last_checked_screen_version != Some(screen_version) {
                    last_checked_screen_version = Some(screen_version);
                    let built = screen.snapshot(&terminal_session_id, terminal_generation);
                    if terminal_wait_text_matches(
                        &built,
                        text,
                        request.case_sensitive,
                        needle_lower.as_deref(),
                    ) {
                        return Ok(TerminalWaitResult {
                            reason: TerminalWaitReason::TextFound,
                            lifecycle_sequence: record.integration_event_sequence,
                            open: true,
                            snapshot: Some(built),
                        });
                    }
                    snapshot = Some(built);
                }
            }
            if let Some(reason) = terminal_wait_scalar_reason(
                &record,
                through_output_sequence,
                screen_version,
                &request,
            ) {
                let snapshot = snapshot
                    .unwrap_or_else(|| screen.snapshot(&terminal_session_id, terminal_generation));
                return Ok(TerminalWaitResult {
                    reason,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: true,
                    snapshot: Some(snapshot),
                });
            }
            let now = Instant::now();
            if now >= deadline {
                let snapshot = snapshot
                    .unwrap_or_else(|| screen.snapshot(&terminal_session_id, terminal_generation));
                if record_timeout {
                    TerminalRolloutCounters::increment(&self.counters.timeout);
                }
                return Ok(TerminalWaitResult {
                    reason: TerminalWaitReason::TimedOut,
                    lifecycle_sequence: record.integration_event_sequence,
                    open: true,
                    snapshot: Some(snapshot),
                });
            }
            let mut remaining = deadline.saturating_duration_since(now);
            if let Some(idle) = request.idle {
                remaining = remaining.min(idle.saturating_sub(record.last_output_at.elapsed()));
            }
            let (next, _) = slot
                .changed
                .wait_timeout(record, remaining)
                .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())?;
            record = next;
        }
    }

    pub(crate) fn visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.scoped_visible_command_route(transport_session_id)
    }

    pub(crate) fn remote_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        self.scoped_visible_command_route(transport_session_id)
    }

    fn scoped_visible_command_route(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalVisibleCommandRoute, String> {
        let state = self.lock()?;
        if state.terminal_execute_rollout.enabled {
            if let Ok(attachment) = current_attachment(&state, transport_session_id) {
                if let Some(slot) = state.sessions.get(&attachment.terminal_session_id) {
                    let record = slot.lock()?;
                    let transport_eligible = record.transport_kind != TerminalTransportKind::SshPty
                        || state.remote_bound_terminal_rollout.enabled;
                    if transport_eligible
                        && record.integration_state == TerminalIntegrationState::Ready
                        && record.prompt_ready
                        && record.active_command.is_none()
                        && record.lease.as_ref().is_some_and(|lease| {
                            matches!(lease.owner, TerminalLeaseOwner::User { .. })
                        })
                    {
                        return Ok(TerminalVisibleCommandRoute::TerminalExecute);
                    }
                }
            }
        }
        Ok(TerminalVisibleCommandRoute::Unavailable)
    }

    pub(crate) fn register_integration_channel(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        shell: TerminalShellKind,
    ) -> Result<(), String> {
        validate_identifier(integration_id, "integration id")?;
        let state = self.lock()?;
        if !state.shell_integration_rollout.enabled {
            return Err("TERMINAL_SHELL_INTEGRATION_DISABLED".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        if record.input_mode == InputMode::NativeInline {
            return Err("TERMINAL_NATIVE_MODE_NOT_LEGACY".into());
        }
        if !shell.supported() {
            record.integration_shell = Some(shell);
            degrade_record(record, "unsupportedShell")?;
            drop(record_guard);
            notify_session(&state, &attachment.terminal_session_id);
            self.changed.notify_all();
            return Ok(());
        }
        record.integration_state = TerminalIntegrationState::Initializing;
        if record.native_clear_pending.is_none() {
            record.native_clear_sequence = 0;
            record.native_clear_confirmed = None;
            record.native_clear_scope = None;
        }
        record.integration_id = Some(integration_id.to_string());
        record.integration_shell = Some(shell);
        record.integration_reason = None;
        record.integration_event_sequence = 0;
        record.prompt_started = false;
        record.prompt_ready = false;
        record.native_input = false;
        record.native_checkpoints = false;
        record.native_typing = false;
        record.native_private_control = false;
        record.native_jobs = false;
        record.native_comments = false;
        advance_integration_state_revision(record)?;
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn mark_integration_degraded(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.integration_shell = Some(shell);
            degrade_record(record, reason)
        })
    }

    pub(crate) fn mark_integration_unavailable(
        &self,
        transport_session_id: &str,
        shell: TerminalShellKind,
        reason: &str,
    ) -> Result<(), String> {
        self.with_current_record_mut(transport_session_id, |record| {
            record.integration_shell = Some(shell);
            record.integration_state = TerminalIntegrationState::Unavailable;
            record.integration_reason = Some(reason.to_string());
            record.integration_id = None;
            record.prompt_ready = false;
            record.prompt_started = false;
            if let Some(command) = &record.active_command {
                settle_command_uncertain(command, record.next_output_sequence.saturating_sub(1));
            }
            advance_integration_state_revision(record)
        })
    }

    pub(crate) fn accept_integration_event(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        event: TerminalIntegrationControlEvent,
    ) -> Result<(), String> {
        let integration_became_ready =
            matches!(&event, TerminalIntegrationControlEvent::Ready { .. });
        let mut state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        if let TerminalIntegrationControlEvent::Job {
            handle,
            state: observed,
            exit_code,
        } = &event
        {
            let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
            let record = &mut *record_guard;
            if record.integration_id.as_deref() != Some(integration_id) {
                return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
            }
            require_ready_integration(record)?;
            let sequence = record.next_output_sequence.saturating_sub(1);
            let active_command = record
                .active_command
                .as_ref()
                .map(|operation| {
                    let data = operation.lock()?;
                    Ok::<_, String>((
                        data.intent.identity.operation_id.clone(),
                        data.lifecycle.started(),
                        data.state(),
                    ))
                })
                .transpose()?;
            let active_operation = active_command
                .as_ref()
                .map(|(operation, _, _)| operation.as_str());
            let command_accepted = active_command.as_ref().is_some_and(|(_, started, state)| {
                *started
                    && matches!(
                        state,
                        TerminalCommandState::Running | TerminalCommandState::CancelRequested
                    )
            });
            let fresh_control = command_accepted
                && active_operation
                    .and_then(|operation| {
                        state
                            .prepared_job_commands
                            .get(operation)
                            .map(|prepared| (operation, prepared))
                    })
                    .is_some_and(|(operation, prepared)| {
                        prepared.job.process_handle == *handle
                            && prepared.job.operation_id != operation
                            && prepared.source == prepared.line
                    });
            drop(record_guard);
            let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
            if job.transport_session_id != transport_session_id
                || job.terminal_generation != attachment.terminal_generation
                || job.terminal_session_id != attachment.terminal_session_id
                || job.integration_id.as_deref() != Some(integration_id)
            {
                return Err("TERMINAL_JOB_IDENTITY_MISMATCH".into());
            }
            if matches!(job.state.as_str(), "exited" | "rejected")
                || job.native_active == Some(false)
                || job.control_lost
                || !command_accepted
                || (active_operation != Some(job.operation_id.as_str()) && !fresh_control)
                || (job.state == "uncertain" && !fresh_control)
            {
                return Ok(());
            }
            job.observed_output_sequence = sequence;
            job.observed_at_unix_ms = crate::terminal_jobs::observation_time();
            job.observation_revision = job
                .observation_revision
                .checked_add(1)
                .filter(|revision| *revision <= JAVASCRIPT_MAX_SAFE_INTEGER)
                .ok_or_else(counter_exhausted)?;
            match observed.as_str() {
                "running" | "queued" => {
                    if !job.launch_confirmed
                        && active_operation != Some(job.operation_id.as_str())
                        && !fresh_control
                    {
                        return Err("TERMINAL_JOB_START_UNCONFIRMED".into());
                    }
                    job.launch_confirmed = true;
                    job.native_active = Some(true);
                    job.state = observed.clone();
                }
                "finished" => {
                    job.exit_code = *exit_code;
                    job.launch_confirmed = true;
                }
                "stopRequested" => {
                    job.launch_confirmed = true;
                    job.native_active = Some(true);
                    job.stop_requested = true;
                    job.state = observed.clone();
                }
                "settled" => {
                    job.native_active = Some(false);
                    if job.exit_code.is_none() {
                        job.exit_code = *exit_code;
                    }
                    job.state = if job.exit_code.is_some() {
                        "exited"
                    } else {
                        "uncertain"
                    }
                    .into();
                    if job.exit_code.is_none() {
                        job.cleanup_reason = Some(
                            "native job no longer active; original exit status unavailable".into(),
                        );
                    }
                }
                "terminated" => {
                    job.native_active = Some(false);
                    job.state = "exited".into();
                }
                other => {
                    job.native_active = match other {
                        "stopped" => Some(true),
                        "rejected" => Some(false),
                        _ => None,
                    };
                    if !matches!(job.state.as_str(), "exited" | "rejected") {
                        job.state = other.into();
                    }
                    if other == "uncertain"
                        && job.stop_requested
                        && matches!(
                            job.shell,
                            TerminalShellKind::WindowsPowerShell | TerminalShellKind::PowerShell7
                        )
                    {
                        job.cleanup_reason = Some("PowerShell stop remains uncertain; native descendant termination has not been established".into());
                    }
                }
            }
            notify_session(&state, &attachment.terminal_session_id);
            self.changed.notify_all();
            return Ok(());
        }
        let job_submission_event =
            if let TerminalIntegrationControlEvent::CommandStart { command_line, .. }
            | TerminalIntegrationControlEvent::InputRejected { command_line, .. } = &event
            {
                let operation = current_record_mut(&state, transport_session_id, &attachment)?
                    .active_command
                    .as_ref()
                    .map(|operation| {
                        Ok::<_, String>(operation.lock()?.intent.identity.operation_id.clone())
                    })
                    .transpose()?;
                operation.as_ref().and_then(|operation| {
                    state
                        .prepared_job_commands
                        .get(operation)
                        .filter(|prepared| prepared.job.operation_id == *operation)
                        .map(|prepared| {
                            (
                                prepared.job.process_handle.clone(),
                                command_line.clone(),
                                matches!(
                                    &event,
                                    TerminalIntegrationControlEvent::InputRejected { .. }
                                ),
                            )
                        })
                })
            } else {
                None
            };
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        if record.integration_id.as_deref() != Some(integration_id) {
            return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
        }
        let event_sequence = record
            .integration_event_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if event_sequence > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let through_output_sequence = record.next_output_sequence.saturating_sub(1);
        let confirms_prompt = matches!(&event, TerminalIntegrationControlEvent::PromptEnd);
        match event {
            TerminalIntegrationControlEvent::NativeTyping { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && (!record.native_input || !record.native_checkpoints))
                {
                    return Err("TERMINAL_NATIVE_TYPING_OUT_OF_ORDER".into());
                }
                record.native_typing = enabled;
            }
            TerminalIntegrationControlEvent::NativePrivateControl { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && !record.native_input)
                {
                    return Err("TERMINAL_PRIVATE_CONTROL_OUT_OF_ORDER".into());
                }
                record.native_private_control = enabled;
            }
            TerminalIntegrationControlEvent::NativePrivateReady => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id == record.integration_id
                        && data.state() == TerminalCommandState::Submitted
                        && data.native_empty_confirmed
                        && record.native_private_control
                        && data.native_private_ready == Some(false)
                    {
                        data.native_private_ready = Some(true);
                        drop(data);
                        command.notify();
                    }
                }
            }
            TerminalIntegrationControlEvent::NativePrivateCheckpoint { descriptor, buffer } => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if data.state() == TerminalCommandState::Submitted {
                        if let Some((expected, expected_buffer, acknowledged)) =
                            data.native_private_checkpoint.take()
                        {
                            // A descriptor from a cancelled/retired operation
                            // must not acknowledge or quarantine its successor.
                            if descriptor.len() != 65 || descriptor.get(33..) != expected.get(33..)
                            {
                                data.native_private_checkpoint =
                                    Some((expected, expected_buffer, acknowledged));
                                return Ok(());
                            }
                            let matched = descriptor == expected
                                && buffer == expected_buffer
                                && data.native_empty_confirmed
                                && record.native_private_control;
                            data.native_private_checkpoint =
                                Some((expected, expected_buffer, matched));
                            if matched {
                                data.confirm_editor(&buffer)?;
                            }
                            if matched && matches!(data.plan.method,crate::terminal_command::state::ExecutionMethod::NativeJobControl) {
                                data.input_proof=Some(FullInputProof::verify_legacy_control(&data.intent,&data.plan,&descriptor,&buffer)?);
                                data.lifecycle.apply(CommandEvent::ConfirmInput)?;
                                data.revision=next_command_revision(data.revision)?;
                            }
                            if !matched {
                                data.lifecycle.apply(CommandEvent::InputLost)?;
                                data.revision = next_command_revision(data.revision)?;
                                data.input_rejection =
                                    Some("TERMINAL_PRIVATE_CONTROL_MISMATCH".into());
                                record.native_recovery_required = true;
                                record.command_input_pending = true;
                                record.native_input = false;
                            }
                            drop(data);
                            command.notify();
                        }
                    }
                }
            }
            TerminalIntegrationControlEvent::NativeCleared { sequence, buffer } => {
                require_ready_integration(record)?;
                if let Some((operation, integration, expected, queued)) =
                    record.native_clear_pending.clone()
                {
                    if integration != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if queued && sequence == expected && sequence > record.native_clear_sequence {
                        record.native_clear_sequence = sequence;
                        record.native_clear_pending = None;
                        record.native_clear_scope = None;
                        if buffer.is_empty() {
                            record.native_clear_confirmed = Some(operation.clone());
                            record.prompt_started = false;
                            record.prompt_ready = true;
                            record.command_input_pending = record.native_recovery_required;
                            if let Some(command) = &record.active_command {
                                let mut data = command.lock()?;
                                if data.intent.identity.operation_id == operation
                                    && data.lifecycle.phase() == CommandPhase::CancelRequested
                                    && !data.lifecycle.may_have_submitted()
                                {
                                    data.lifecycle.apply(CommandEvent::DraftCleared)?;
                                    data.revision = next_command_revision(data.revision)?;
                                    drop(data);
                                    command.notify();
                                }
                            }
                        } else {
                            record.native_recovery_required = true;
                            record.command_input_pending = true;
                            record.native_input = false;
                        }
                    }
                } else if sequence > record.native_clear_sequence {
                    record.native_clear_sequence = sequence;
                }
            }
            TerminalIntegrationControlEvent::NativeCheckpointMode { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || (enabled && !record.native_input)
                {
                    return Err("TERMINAL_NATIVE_CHECKPOINT_OUT_OF_ORDER".into());
                }
                record.native_checkpoints = enabled;
            }
            TerminalIntegrationControlEvent::NativeCheckpoint { buffer } => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.integration_id != record.integration_id {
                        return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
                    }
                    if data.state() == TerminalCommandState::Submitted {
                        if data.native_read_only_probe && data.native_probe_refresh {
                            // Drain the old read-only request before issuing a
                            // new one after Q. Its late A cannot authorize data.
                            data.native_probe_outstanding = false;
                            drop(data);
                            command.notify();
                        } else if let Some((expected, _)) = data.native_checkpoint.take() {
                            if data.native_read_only_probe {
                                data.native_probe_outstanding = false;
                            }
                            let initial = expected.is_empty() && !data.native_empty_confirmed;
                            let matched = expected == buffer;
                            data.native_checkpoint = Some((expected, matched));
                            if matched {
                                data.confirm_editor(&buffer)?;
                                if initial {
                                    data.native_empty_confirmed = true;
                                    record.native_clear_scope = Some((
                                        data.intent.identity.operation_id.clone(),
                                        record.integration_id.clone(),
                                    ));
                                }
                            } else if initial {
                                data.lifecycle.apply(CommandEvent::PreparationFailed)?;
                                data.revision = next_command_revision(data.revision)?;
                                record.prompt_ready = true;
                                record.command_input_pending = false;
                            } else {
                                data.lifecycle.apply(CommandEvent::InputLost)?;
                                data.revision = next_command_revision(data.revision)?;
                                record.native_input = false;
                                record.native_recovery_required = true;
                                record.command_input_pending = true;
                            }
                            drop(data);
                            command.notify();
                        }
                    }
                }
            }
            TerminalIntegrationControlEvent::NativeJobs { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started {
                    return Err("TERMINAL_JOB_CAPABILITY_OUTSIDE_PROMPT".into());
                }
                record.native_jobs = enabled && record.native_private_control;
            }
            TerminalIntegrationControlEvent::Job { .. } => unreachable!("job event handled above"),
            TerminalIntegrationControlEvent::Ready { shell } => {
                if record.integration_state != TerminalIntegrationState::Initializing
                    || record.integration_shell != Some(shell)
                {
                    degrade_record(record, "shellIdentityMismatch")?;
                    return Err("TERMINAL_INTEGRATION_SHELL_IDENTITY_MISMATCH".into());
                }
                record.integration_state = TerminalIntegrationState::Ready;
                record.integration_reason = None;
            }
            TerminalIntegrationControlEvent::PromptStart { cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                let (read_only_probe, source_may_be_enqueued) =
                    if let Some(command) = &record.active_command {
                        let mut data = command.lock()?;
                        let safe = data.state() == TerminalCommandState::Submitted
                            && data.native_read_only_probe
                            && !data.source_may_be_enqueued;
                        if safe {
                            data.native_probe_refresh = true;
                            data.native_probe_waiting_prompt = true;
                            data.native_empty_confirmed = false;
                            data.native_checkpoint = Some((String::new(), false));
                            record.native_clear_scope = None;
                        }
                        (safe, data.source_may_be_enqueued)
                    } else {
                        (false, false)
                    };
                if (record.command_input_pending || source_may_be_enqueued)
                    && !read_only_probe
                    && record.active_command.as_ref().is_some_and(|command| {
                        command
                            .lock()
                            .is_ok_and(|data| data.state() == TerminalCommandState::Submitted)
                    })
                {
                    record.native_recovery_required = true;
                    record.command_input_pending = true;
                    record.native_input = false;
                    degrade_record(
                        record,
                        if source_may_be_enqueued {
                            "promptDuringUnsubmittedInput:sourceMayBeEnqueued"
                        } else {
                            "promptDuringUnsubmittedInput:sourceNotEnqueued"
                        },
                    )?;
                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: shell prompt changed while command input was pending; reconnect before retrying".into());
                }
                if record.prompt_started {
                    return Err("TERMINAL_PROMPT_START_OUT_OF_ORDER".into());
                }
                record.current_directory = Some(cwd);
                record.prompt_started = true;
                record.prompt_ready = false;
                record.prompt_start_input_sequence = if record.interactive_input.is_none() {
                    record.next_input_sequence
                } else {
                    record.prompt_next_input_sequence
                };
                record.native_input = false;
                record.native_checkpoints = false;
                record.native_typing = false;
                record.native_private_control = false;
                record.native_jobs = false;
                record.native_comments = false;
            }
            TerminalIntegrationControlEvent::NativeInput { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started || record.prompt_ready {
                    return Err("TERMINAL_NATIVE_INPUT_OUT_OF_ORDER".into());
                }
                record.native_input = enabled;
            }
            TerminalIntegrationControlEvent::NativeComments { enabled } => {
                require_ready_integration(record)?;
                if !record.prompt_started
                    || record.prompt_ready
                    || record.integration_shell != Some(TerminalShellKind::Zsh)
                {
                    return Err("TERMINAL_NATIVE_INPUT_OUT_OF_ORDER".into());
                }
                record.native_comments = enabled;
            }
            TerminalIntegrationControlEvent::InputRejected {
                command_line,
                reason,
            } => {
                require_ready_integration(record)?;
                if !matches!(
                    reason.as_str(),
                    "TERMINAL_INPUT_UNSUPPORTED" | "TERMINAL_BACKGROUND_UNSUPPORTED"
                ) {
                    return Err("TERMINAL_INTEGRATION_INVALID_INPUT_REJECTION".into());
                }
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    let matches_prepared_submission = job_submission_event.is_some()
                        && data
                            .has_submission_envelope
                            .then(|| data.plan.submitted_line())
                            == Some(command_line.as_str());
                    if (data.intent.source() != command_line && !matches_prepared_submission)
                        || !matches!(
                            data.state(),
                            TerminalCommandState::Submitted
                                | TerminalCommandState::Running
                                | TerminalCommandState::CancelRequested
                        )
                    {
                        drop(data);
                        degrade_record(record, "invalidInputRejection")?;
                        return Err("TERMINAL_COMMAND_LINE_MISMATCH".into());
                    }
                    if data.lifecycle.requested_settlement().is_none() {
                        data.input_rejection = Some(reason);
                    }
                    data.lifecycle.apply(CommandEvent::ParserRejected)?;
                    data.revision = next_command_revision(data.revision)?;
                    data.capture_end_sequence = Some(through_output_sequence);
                    drop(data);
                    command.notify();
                }
                record.command_input_pending = true;
            }
            TerminalIntegrationControlEvent::InterruptUncertain => {
                require_ready_integration(record)?;
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    data.interrupt_uncertain = true;
                    data.revision = next_command_revision(data.revision)?;
                    drop(data);
                    command.notify();
                }
            }
            TerminalIntegrationControlEvent::PromptEnd => {
                require_ready_integration(record)?;
                if !record.prompt_started {
                    return Err("TERMINAL_PROMPT_END_OUT_OF_ORDER".into());
                }
                record.prompt_started = false;
                record.prompt_ready = true;
                record.vim_attached = false;
                record.vim_editor = None;
                record.prompt_next_input_sequence = record.prompt_start_input_sequence;
                record.command_input_pending =
                    record.native_recovery_required || record.native_clear_pending.is_some();
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if !data.native_protocol
                        && data.lifecycle.phase() == CommandPhase::CancelRequested
                        && data
                            .lifecycle
                            .apply(CommandEvent::LegacyEditReturned)
                            .is_ok()
                    {
                        data.revision = next_command_revision(data.revision)?;
                        command.notify();
                    }
                    if data.native_read_only_probe && data.native_probe_refresh {
                        data.native_probe_waiting_prompt = false;
                        drop(data);
                        command.notify();
                    }
                }
            }
            TerminalIntegrationControlEvent::CommandStart { command_line, cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.prompt_ready = false;
                record.prompt_started = false;
                record.current_directory = Some(cwd.clone());
                record.report_display_command(&cwd, None);
                if let Some(input) = record.interactive_input.take() {
                    record.interactive_input = Some(match input {
                        InteractiveInput::Submitted { line, through } if line == command_line => {
                            InteractiveInput::Running { through }
                        }
                        _ => InteractiveInput::Unconfirmed,
                    });
                }
                if let Some(command) = &record.active_command {
                    let mut data = command.lock()?;
                    if data.native_protocol
                        || data.lifecycle.submission_revoked()
                            && !data.lifecycle.may_have_submitted()
                    {
                        return Ok(());
                    }
                    if !matches!(
                        data.state(),
                        TerminalCommandState::Submitted | TerminalCommandState::CancelRequested
                    ) {
                        drop(data);
                        degrade_record(record, "unexpectedCommandStart")?;
                        return Err("TERMINAL_COMMAND_START_OUT_OF_ORDER".into());
                    }
                    if command_line != data.plan.submitted_line() {
                        data.lifecycle.apply(CommandEvent::ControlLost)?;
                        data.revision = next_command_revision(data.revision)?;
                        data.capture_end_sequence = Some(through_output_sequence);
                        TerminalRolloutCounters::increment(&self.counters.uncertainty);
                        drop(data);
                        command.notify();
                        degrade_record(record, "exactCommandLineMismatch")?;
                        return Err("TERMINAL_COMMAND_LINE_MISMATCH".into());
                    }
                    data.lifecycle.apply(CommandEvent::LegacyStarted)?;
                    record.native_clear_scope = None;
                    record.command_input_pending = false;
                    data.revision = next_command_revision(data.revision)?;
                    data.cwd = Some(cwd);
                    data.capture_start_sequence = data
                        .capture_start_sequence
                        .min(through_output_sequence.saturating_add(1));
                    drop(data);
                    command.notify();
                }
            }
            TerminalIntegrationControlEvent::CommandEnd { exit_code, cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.prompt_ready = false;
                record.prompt_started = false;
                record.current_directory = Some(cwd.clone());
                if matches!(record.interactive_input, Some(InteractiveInput::Running { through }) if through == record.next_input_sequence)
                {
                    record.interactive_input = None;
                    record.interactive_guard_buffer.clear();
                }
                if let Some(command) = &record.active_command {
                    settle_command_from_integration(
                        command,
                        exit_code,
                        cwd.clone(),
                        through_output_sequence,
                    )?;
                }
                record.report_display_command(&cwd, Some(exit_code));
            }
            TerminalIntegrationControlEvent::DirectoryChanged { cwd } => {
                require_ready_integration(record)?;
                validate_cwd(&cwd)?;
                record.current_directory = Some(cwd);
            }
        }
        record.integration_event_sequence = event_sequence;
        advance_integration_state_revision(record)?;
        if confirms_prompt {
            record.prompt_ready_revision = record.integration_state_revision;
        }
        drop(record_guard);
        if let Some((handle, line, rejected)) = job_submission_event {
            if let Some(job) = state.jobs.get_mut(&handle) {
                if rejected {
                    job.state = "rejected".into();
                    job.native_active = Some(false);
                    job.cleanup_reason =
                        Some("native parser refused source before starting a job".into());
                } else {
                    job.accepted_command_line = Some(line);
                }
            }
        }
        TerminalRolloutCounters::increment(&self.counters.lifecycle_matched);
        if integration_became_ready {
            TerminalRolloutCounters::increment(&self.counters.integration_ready);
        }
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn take_display_command_events(
        &self,
        transport_session_id: &str,
    ) -> Result<Vec<TerminalCommandLifecycleEvent>, String> {
        let state = self.lock()?;
        let Ok(attachment) = current_attachment(&state, transport_session_id).cloned() else {
            return Ok(Vec::new());
        };
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        Ok(record.display_command_lifecycle.pending.drain(..).collect())
    }

    pub(crate) fn integration_channel_closed(
        &self,
        transport_session_id: &str,
        integration_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(());
        }
        let attachment = match current_attachment(&state, transport_session_id) {
            Ok(attachment) => attachment.clone(),
            Err(_) => return Ok(()),
        };
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        if record.integration_id.as_deref() != Some(integration_id) {
            return Ok(());
        }
        degrade_record(record, reason)?;
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn begin_command(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_with_submission(transport_session_id, operation_id, command_line, None)
    }

    #[cfg(test)]
    pub(crate) fn begin_command_with_submission(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_with_context(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn begin_command_with_context(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_record(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            authorization,
            false,
            false,
            None,
        )
    }

    pub(crate) fn begin_waiting_command_with_context(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        handoff_to_user: bool,
        expected_agent: &str,
        expected_task: &str,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        self.begin_command_record(
            transport_session_id,
            operation_id,
            command_line,
            submitted_command_line,
            authorization,
            true,
            handoff_to_user,
            Some((expected_agent, expected_task)),
        )
    }

    fn begin_command_record(
        &self,
        transport_session_id: &str,
        operation_id: &str,
        command_line: &str,
        submitted_command_line: Option<&str>,
        authorization: Option<crate::terminal_command::state::IntentAuthorization>,
        awaiting_ready: bool,
        handoff_to_user: bool,
        expected_owner: Option<(&str, &str)>,
    ) -> Result<Arc<TerminalCommandOperation>, String> {
        validate_identifier(operation_id, "operation id")?;
        let prior_owner = {
            let state = self.lock()?;
            if state.terminal_execute_rollout.enabled {
                let attachment = current_attachment(&state, transport_session_id)?.clone();
                let mut record_guard =
                    current_record_mut(&state, transport_session_id, &attachment)?;
                let record = &mut *record_guard;
                record.lease.as_ref().and_then(|lease| match &lease.owner {
                    TerminalLeaseOwner::Agent {
                        agent_session_id,
                        task_id,
                        operation_id: expected,
                        ..
                    } if expected == operation_id => {
                        Some((agent_session_id.clone(), task_id.clone()))
                    }
                    _ => None,
                })
            } else {
                None
            }
        };
        if let Some((agent, task)) = prior_owner {
            self.check_submission_replay(&agent, &task, operation_id)?;
        }
        let state = self.lock()?;
        if !state.terminal_execute_rollout.enabled {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let prepared_job = state.prepared_job_commands.get(operation_id).cloned();
        if prepared_job.is_some() && submitted_command_line.is_none() {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        if record.transport_kind == TerminalTransportKind::SshPty && !remote_visible_command_enabled
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.integration_state != TerminalIntegrationState::Ready || !record.prompt_ready {
            return Err("TERMINAL_INTEGRATION_NOT_READY".into());
        }
        if record.native_recovery_required || record.native_clear_pending.is_some() {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native edit was not confirmed; reconnect before any further input".into());
        }
        if handoff_to_user
            && (record.input_mode != InputMode::NativeInline
                || !record
                    .native_profile
                    .as_ref()
                    .is_some_and(|profile| profile.capture_fence()))
        {
            return Err(
                "TERMINAL_HANDOFF_UNAVAILABLE: this terminal cannot observe the foreground screen"
                    .into(),
            );
        }
        if record.input_mode == InputMode::NativeInline && submitted_command_line.is_none() {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        if let Some(submitted) = submitted_command_line {
            let job_matches = prepared_job.as_ref().is_some_and(|prepared| {
                prepared.source == command_line
                    && if record.input_mode == InputMode::NativeInline {
                        prepared_native_job(prepared)
                            .and_then(|job| {
                                nip::native_shell_job_plan(
                                    command_line,
                                    crate::terminal_command::registration::shell_family(
                                        prepared.job.shell,
                                    )?,
                                    &job,
                                )
                                .map_err(|_| "TERMINAL_NATIVE_PLAN_INVALID".into())
                            })
                            .is_ok_and(|expected| expected == submitted)
                    } else {
                        prepared.line == submitted
                    }
            });
            if let Some(prepared) = &prepared_job {
                validate_prepared_shell_job(record, prepared, operation_id)?;
            }
            let expected_bash = if record.input_mode == InputMode::NativeInline {
                nip::native_foreground_plan(
                    command_line,
                    crate::terminal_command::registration::shell_family(
                        record
                            .integration_shell
                            .ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?,
                    )?,
                )
                .map_err(|_| "TERMINAL_NATIVE_SUBMISSION_MISMATCH")?
            } else {
                crate::terminal_integration::bash_native_submission(command_line)?
            };
            let bash_source_matches = (record.input_mode == InputMode::NativeInline
                || record.integration_shell == Some(TerminalShellKind::Bash))
                && submitted == expected_bash
                && (record.native_input
                    || (command_line.len() <= 512 && !command_line.contains(['\n', '\r', '\t'])));
            // A short Bash eval submission uses ordinary Readline typing and
            // does not require the complete-script receiver (notably Bash 3).
            // Prepared background jobs still require their native capability.
            if (job_matches && !record.native_input) || (!job_matches && !bash_source_matches) {
                return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
            }
        }
        if record.active_command.is_some() {
            return Err("TERMINAL_COMMAND_BUSY".into());
        }
        let lease = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        if !matches!(
            &lease.owner,
            TerminalLeaseOwner::Agent {
                operation_id: expected,
                ..
            } if expected == operation_id
        ) {
            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
        }
        let (agent_session_id, task_id) = match &lease.owner {
            TerminalLeaseOwner::Agent {
                agent_session_id,
                task_id,
                ..
            } => (agent_session_id.clone(), task_id.clone()),
            _ => return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into()),
        };
        if expected_owner.is_some_and(|(agent, task)| agent != agent_session_id || task != task_id)
        {
            return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());
        }
        let identity = CommandIdentity {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            lease_id: lease.lease_id.clone(),
            lease_generation: lease.revision,
            agent_session_id,
            task_id,
            operation_id: operation_id.into(),
            command_id: opaque_id("command"),
            source_revision: 1,
        };
        let intent =
            CommandIntent::new(identity, command_line.into())?.with_authorization(authorization);
        intent.validate_authorization_binding(transport_session_id, prepared_job.as_ref())?;
        use crate::terminal_command::state::ExecutionMethod;
        let method = if record.input_mode == InputMode::NativeInline {
            ExecutionMethod::NativeInline
        } else if prepared_job.is_some() {
            if submitted_command_line == Some(command_line) {
                ExecutionMethod::NativeJobControl
            } else {
                ExecutionMethod::NativeJobLaunch
            }
        } else {
            ExecutionMethod::LegacyEditor
        };
        let mut plan = ExecutionPlan::new(
            &intent,
            submitted_command_line.unwrap_or(command_line).into(),
            record.integration_shell,
            method,
        );
        if record.input_mode == InputMode::NativeInline {
            plan.native_job = prepared_job.as_ref().map(prepared_native_job).transpose()?;
        }
        let operation = Arc::new(TerminalCommandOperation::from_intent(
            intent,
            plan,
            submitted_command_line.is_some(),
            record.integration_id.clone(),
            record.next_output_sequence,
            self.config.capture_max_bytes,
            Arc::clone(&self.counters),
            awaiting_ready,
            Arc::downgrade(&self.state),
        ));
        if record.input_mode == InputMode::NativeInline {
            let mut data = operation.lock()?;
            data.native_protocol = true;
            data.requires_complete_proof = true;
            data.native_capabilities_confirmed = record.native_display_negotiated;
            if handoff_to_user {
                data.handoff_screen = Some(TerminalScreenModel::new(record.geometry));
            }
        }
        record.active_command = Some(Arc::clone(&operation));
        record.native_clear_scope = None;
        if !awaiting_ready {
            record.prompt_ready = false;
        }
        advance_integration_state_revision(record)?;
        Ok(operation)
    }

    pub(crate) fn activate_waiting_command(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let operation_id = operation.lock()?.intent.identity.operation_id.clone();
        let prepared = state.prepared_job_commands.get(&operation_id).cloned();
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        require_ready_integration(record)?;
        let mut data = operation.lock()?;
        if data.integration_id != record.integration_id {
            return Err("TERMINAL_INTEGRATION_IDENTITY_MISMATCH".into());
        }
        if let Some(prepared) = &prepared {
            validate_prepared_shell_job(record, prepared, &operation_id)?;
        }
        if !record.lease.as_ref().is_some_and(|lease| {
            lease.lease_id == data.intent.identity.lease_id
                && lease.revision == data.intent.identity.lease_generation
        }) {
            return Err("TERMINAL_BROKER_STALE_LEASE".into());
        }
        if record.native_recovery_required || record.native_clear_pending.is_some() {
            return Err("TERMINAL_INPUT_RECOVERY_REQUIRED".into());
        }
        data.lifecycle.apply(CommandEvent::Ready)?;
        data.revision = next_command_revision(data.revision)?;
        record.prompt_ready = false;
        advance_integration_state_revision(record)?;
        Ok(())
    }

    pub(crate) fn prepare_shell_job(
        &self,
        transport: &str,
        target: &crate::agent_runtime::AgentToolTargetNative,
        agent: &str,
        task: &str,
        operation: &str,
        source: &str,
    ) -> Result<crate::terminal_jobs::NativeShellJob, String> {
        let mut state = self.lock()?;
        if state.jobs.len() >= 4096 {
            let BrokerState { jobs, sessions, .. } = &mut *state;
            jobs.retain(|_, job| {
                let terminal_state = job.state == "exited" || job.state == "rejected";
                !terminal_state
                    || sessions
                        .get(&job.terminal_session_id)
                        .is_some_and(|slot| slot.lock().is_ok_and(|record| record.open))
            });
            if state.jobs.len() >= 4096 {
                if let Some(oldest_terminal_key) = state
                    .jobs
                    .iter()
                    .filter(|(_, job)| job.state == "exited" || job.state == "rejected")
                    .min_by_key(|(_, job)| job.observed_at_unix_ms)
                    .map(|(handle, _)| handle.clone())
                {
                    state.jobs.remove(&oldest_terminal_key);
                }
            }
            if state.jobs.len() >= 4096 {
                return Err("TERMINAL_JOB_CAPACITY_REACHED".into());
            }
        }
        if state.jobs.values().any(|job| {
            job.owner_target_id == target.target_id()
                && job.agent_session_id == agent
                && job.task_id == task
                && job.operation_id == operation
        }) {
            return Err("TERMINAL_JOB_LAUNCH_ALREADY_REGISTERED: do not replay; retain the original opaque handle".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        require_ready_integration(record)?;
        if !record.native_input
            || !record.native_checkpoints
            || record.native_recovery_required
            || !record.native_jobs
            || !matches!(
                record.integration_shell,
                Some(
                    TerminalShellKind::Bash
                        | TerminalShellKind::Zsh
                        | TerminalShellKind::WindowsPowerShell
                        | TerminalShellKind::PowerShell7
                )
            )
        {
            return Err("TERMINAL_BACKGROUND_UNSUPPORTED: the current shell has not advertised nativeJobControl; no input was sent".into());
        }
        let handle = format!("job-{}", Uuid::new_v4().simple());
        let shell = record
            .integration_shell
            .ok_or("TERMINAL_INTEGRATION_SHELL_UNKNOWN")?;
        let submitted = crate::terminal_jobs::shell_submission(source, &handle, shell)?;
        let job = crate::terminal_jobs::NativeShellJob {
            process_handle: handle.clone(),
            owner_target_id: target.target_id().into(),
            agent_session_id: agent.into(),
            task_id: task.into(),
            integration_id: record.integration_id.clone(),
            frozen_target: target.clone(),
            transport_session_id: transport.into(),
            terminal_session_id: attachment.terminal_session_id,
            terminal_generation: attachment.terminal_generation,
            shell,
            operation_id: operation.into(),
            command_line: source.into(),
            submitted_command_line: submitted.clone(),
            accepted_command_line: None,
            control_lost: false,
            native_active: None,
            state: "starting".into(),
            exit_code: None,
            observed_output_sequence: record.next_output_sequence.saturating_sub(1),
            observed_at_unix_ms: crate::terminal_jobs::observation_time(),
            observation_revision: 0,
            capture_start_sequence: record.next_output_sequence,
            cleanup_reason: None,
            stop_requested: false,
            launch_confirmed: false,
        };
        drop(record_guard);
        state.prepared_job_commands.insert(
            operation.into(),
            crate::terminal_jobs::PreparedShellJob {
                native_control_nonce: None,
                job: job.clone(),
                source: source.into(),
                line: submitted,
            },
        );
        state.jobs.insert(handle, job.clone());
        Ok(job)
    }

    pub(crate) fn native_job_plan(
        &self,
        transport: &str,
        operation: &str,
        source: &str,
        line: &str,
    ) -> Result<String, String> {
        let state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .ok_or("TERMINAL_JOB_SUBMISSION_UNREGISTERED")?
            .clone();
        if source != prepared.source || line != prepared.line {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        validate_prepared_shell_job_binding(record, &prepared, operation, false)?;
        nip::native_shell_job_plan(
            source,
            crate::terminal_command::registration::shell_family(prepared.job.shell)?,
            &prepared_native_job(&prepared)?,
        )
        .map_err(|_| "TERMINAL_NATIVE_PLAN_INVALID".into())
    }

    pub(crate) fn native_job_started(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .filter(|prepared| prepared.job.operation_id == operation)
            .cloned();
        if let Some(prepared) = prepared {
            let attachment = current_attachment(&state, transport)?;
            if attachment.terminal_generation != prepared.job.terminal_generation {
                return Err("TERMINAL_JOB_STALE_BINDING".into());
            }
            let job = state
                .jobs
                .get_mut(&prepared.job.process_handle)
                .ok_or("TERMINAL_JOB_UNKNOWN")?;
            job.accepted_command_line = Some(prepared.line);
        }
        Ok(())
    }

    pub(crate) fn shell_job(
        &self,
        handle: &str,
        owner: &str,
        agent: &str,
        task: &str,
    ) -> Result<crate::terminal_jobs::NativeShellJob, String> {
        let mut state = self.lock()?;
        let job = state
            .jobs
            .get(handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?
            .clone();
        if job.owner_target_id != owner || job.agent_session_id != agent || job.task_id != task {
            return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
        }
        let live = state
            .sessions
            .get(&job.terminal_session_id)
            .is_some_and(|slot| {
                slot.lock().is_ok_and(|record| {
                    record.open
                        && record.terminal_generation == job.terminal_generation
                        && record.integration_state == TerminalIntegrationState::Ready
                        && record.integration_id == job.integration_id
                })
            });
        if !live {
            let job = state.jobs.get_mut(handle).expect("job exists");
            job.control_lost = true;
            if job.native_active != Some(false) {
                job.native_active = None;
            }
            if !matches!(job.state.as_str(), "exited" | "rejected") {
                job.state = "uncertain".into();
            }
        }
        Ok(state.jobs.get(handle).expect("job exists").clone())
    }

    pub(crate) fn prepare_shell_job_control(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        operation: &str,
        stop: bool,
    ) -> Result<String, String> {
        let mut state = self.lock()?;
        let current = state
            .jobs
            .get(&job.process_handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?;
        if current.owner_target_id != job.owner_target_id
            || current.agent_session_id != job.agent_session_id
            || current.task_id != job.task_id
            || current.frozen_target != job.frozen_target
            || current.terminal_generation != job.terminal_generation
            || current.integration_id != job.integration_id
        {
            return Err("TERMINAL_JOB_OWNER_MISMATCH".into());
        }
        let job = current.clone();
        if job.control_lost
            || job.native_active == Some(false)
            || matches!(job.state.as_str(), "rejected" | "exited")
            || (job.state == "starting" && job.accepted_command_line.is_none())
        {
            return Err("TERMINAL_JOB_NOT_CONTROLLABLE".into());
        }
        let line = crate::terminal_jobs::control_submission(&job.process_handle, job.shell, stop)?;
        state.prepared_job_commands.insert(
            operation.into(),
            crate::terminal_jobs::PreparedShellJob {
                native_control_nonce: Some(Uuid::new_v4().simple().to_string()),
                job: job.clone(),
                source: line.clone(),
                line: line.clone(),
            },
        );
        Ok(line)
    }

    pub(crate) fn validate_shell_job_input(
        &self,
        transport: &str,
        operation: &str,
        source: &str,
        line: &str,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let prepared = state
            .prepared_job_commands
            .get(operation)
            .ok_or("TERMINAL_JOB_SUBMISSION_UNREGISTERED")?
            .clone();
        if source != prepared.source || line != prepared.line {
            return Err("TERMINAL_NATIVE_SUBMISSION_MISMATCH".into());
        }
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        validate_prepared_shell_job(record, &prepared, operation)
    }

    pub(crate) fn discard_shell_job_submission(&self, operation: &str) -> Result<(), String> {
        self.lock()?.prepared_job_commands.remove(operation);
        Ok(())
    }

    pub(crate) fn require_native_input_recovery(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        if !record.lease.as_ref().is_some_and(|lease|matches!(&lease.owner,TerminalLeaseOwner::Agent{operation_id,..}|TerminalLeaseOwner::Revoking{operation_id,..} if operation_id==operation)) {return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into());}
        if let Some(command) = &record.active_command {
            let mut data = command.lock()?;
            if data.intent.identity.operation_id != operation {
                return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
            }
            if data.native_protocol && data.lifecycle.phase() == CommandPhase::CancelRequested {
                // A requested stop is not a private completion receipt. Retain
                // possible submission and allow a genuine late result while
                // making the unknown outcome visible in the authoritative DTO.
                data.lifecycle.apply(CommandEvent::StopUnconfirmed)?;
                data.revision = next_command_revision(data.revision)?;
                drop(data);
                command.notify();
            }
        }
        record.native_recovery_required = true;
        record.command_input_pending = true;
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Used by the P1 native adapter; production transport wiring is P2"
        )
    )]
    pub(crate) fn close_native_protocol(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
        input_safe: bool,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        record.integration_state = TerminalIntegrationState::Degraded;
        record.integration_reason = Some("nativeControlClosed".into());
        record.integration_id = None;
        record.native_input = false;
        record.prompt_ready = false;
        if !input_safe {
            record.native_recovery_required = true;
            record.command_input_pending = true;
        } else {
            record.command_input_pending =
                record.native_recovery_required || record.native_clear_pending.is_some();
        }
        advance_integration_state_revision(record)?;
        operation.finalize_capture(record.next_output_sequence.saturating_sub(1))?;
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn expect_native_clear(
        &self,
        transport: &str,
        operation: &str,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        require_ready_integration(record)?;
        if !record.native_checkpoints||!matches!(record.integration_shell,Some(TerminalShellKind::Bash|TerminalShellKind::Zsh))||!record.native_clear_scope.as_ref().is_some_and(|(expected,integration)|expected==operation&&integration==&record.integration_id)||!record.lease.as_ref().is_some_and(|lease|matches!(&lease.owner,TerminalLeaseOwner::Agent{operation_id,..}|TerminalLeaseOwner::Revoking{operation_id,..}if operation_id==operation)) {return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native clear is not bound to an unsubmitted, confirmed-empty editor/lease".into());}
        if record.native_clear_pending.is_some() {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: an earlier clear is still pending".into(),
            );
        }
        let sequence = record
            .native_clear_sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(counter_exhausted)?;
        record.native_clear_pending = Some((
            operation.into(),
            record.integration_id.clone(),
            sequence,
            false,
        ));
        record.native_clear_confirmed = None;
        record.command_input_pending = true;
        record.prompt_ready = false;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn wait_native_clear(
        &self,
        transport: &str,
        operation: &str,
        timeout: Duration,
    ) -> Result<bool, String> {
        let (attachment, slot) = self.lookup_session_slot(transport)?;
        let record = slot.lock_current(transport, &attachment)?;
        let integration = record.integration_id.clone();
        let (record, _) = slot
            .changed
            .wait_timeout_while(record, timeout, |record| {
                record.terminal_generation == attachment.terminal_generation
                    && record.integration_id == integration
                    && record
                        .native_clear_pending
                        .as_ref()
                        .is_some_and(|(expected, _, _, _)| expected == operation)
            })
            .map_err(|_| "TERMINAL_INPUT_RECOVERY_REQUIRED")?;
        Ok(record.open
            && record.terminal_generation == attachment.terminal_generation
            && record.integration_id == integration
            && record.native_clear_confirmed.as_deref() == Some(operation))
    }

    /// Called only with execution-layer proof that accept-line was never
    /// attempted. Preparation and a stale transport are not launch evidence.
    pub(crate) fn reject_shell_job_before_submission(
        &self,
        prepared: &crate::terminal_jobs::NativeShellJob,
        reason: &str,
    ) -> Result<bool, String> {
        let mut state = self.lock()?;
        let job = state
            .jobs
            .get_mut(&prepared.process_handle)
            .ok_or("TERMINAL_JOB_UNKNOWN")?;
        if job.owner_target_id != prepared.owner_target_id
            || job.agent_session_id != prepared.agent_session_id
            || job.task_id != prepared.task_id
            || job.operation_id != prepared.operation_id
            || job.frozen_target != prepared.frozen_target
            || job.terminal_session_id != prepared.terminal_session_id
            || job.terminal_generation != prepared.terminal_generation
            || job.integration_id != prepared.integration_id
        {
            return Err("TERMINAL_JOB_IDENTITY_MISMATCH".into());
        }
        if job.launch_confirmed || job.accepted_command_line.is_some() || job.state == "exited" {
            return Ok(false);
        }
        job.state = "rejected".into();
        job.native_active = Some(false);
        job.cleanup_reason = Some(crate::redaction::redact_sensitive_text(reason));
        state.prepared_job_commands.remove(&prepared.operation_id);
        self.changed.notify_all();
        Ok(true)
    }

    pub(crate) fn mark_shell_job_uncertain(&self, handle: &str) -> Result<(), String> {
        let mut state = self.lock()?;
        let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
        if !matches!(job.state.as_str(), "exited" | "rejected") {
            job.state = "uncertain".into();
        }
        Ok(())
    }

    pub(crate) fn shell_jobs_for_cleanup(
        &self,
        task: Option<&str>,
    ) -> Result<Vec<crate::terminal_jobs::NativeShellJob>, String> {
        Ok(self
            .lock()?
            .jobs
            .values()
            .filter(|job| {
                task.is_none_or(|task| task == job.task_id)
                    && !matches!(job.state.as_str(), "exited" | "rejected")
                    && !job.control_lost
                    && job.native_active != Some(false)
            })
            .cloned()
            .collect())
    }

    #[cfg(all(test, unix))]
    pub(crate) fn has_active_shell_jobs(&self, transport: &str) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?;
        let integration_id = state
            .sessions
            .get(&attachment.terminal_session_id)
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?
            .lock()?
            .integration_id
            .clone();
        Ok(state.jobs.values().any(|job| {
            job.terminal_session_id == attachment.terminal_session_id
                && job.terminal_generation == attachment.terminal_generation
                && job.integration_id == integration_id
                && !job.control_lost
                && job.native_active != Some(false)
                && !matches!(job.state.as_str(), "exited" | "rejected")
        }))
    }

    pub(crate) fn record_shell_job_cleanup(
        &self,
        handle: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        let job = state.jobs.get_mut(handle).ok_or("TERMINAL_JOB_UNKNOWN")?;
        if matches!(job.state.as_str(), "exited" | "rejected") || job.native_active == Some(false) {
            return Ok(());
        }
        job.cleanup_reason = Some(reason.into());
        if job.state != "exited" {
            job.state = "uncertain".into();
        }
        Ok(())
    }

    pub(crate) fn wait_shell_job_prompt(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        timeout: Duration,
    ) -> Result<bool, String> {
        let Some(slot) = self.lookup_session_slot_by_id(&job.terminal_session_id)? else {
            return Ok(false);
        };
        let matches = |record: &SessionRecord| {
            record.open
                && record.terminal_generation == job.terminal_generation
                && record.integration_id == job.integration_id
        };
        let record = slot.lock()?;
        let (record, _) = slot
            .changed
            .wait_timeout_while(record, timeout, |record| {
                matches(record) && (!record.prompt_ready || record.active_command.is_some())
            })
            .map_err(|_| "TERMINAL_JOB_PROMPT_WAIT_UNAVAILABLE")?;
        Ok(matches(&record) && record.prompt_ready && record.active_command.is_none())
    }

    pub(crate) fn wait_shell_job_change(
        &self,
        job: &crate::terminal_jobs::NativeShellJob,
        timeout: Duration,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let _ = self
            .changed
            .wait_timeout_while(state, timeout, |state| {
                state.jobs.get(&job.process_handle).is_some_and(|current| {
                    current.state == job.state
                        && current.observation_revision == job.observation_revision
                        && current.accepted_command_line == job.accepted_command_line
                        && current.control_lost == job.control_lost
                })
            })
            .map_err(|_| "TERMINAL_JOB_OBSERVATION_UNAVAILABLE")?;
        Ok(())
    }

    pub(crate) fn wait_command_prompt(
        &self,
        operation: &TerminalCommandOperation,
        timeout: Duration,
    ) -> Result<bool, String> {
        let data = operation.lock()?;
        let terminal_id = data.intent.identity.terminal_session_id.clone();
        let generation = data.intent.identity.terminal_generation;
        let integration = data.integration_id.clone();
        drop(data);
        let matches = |record: &SessionRecord| {
            record.open
                && record.terminal_generation == generation
                && record.integration_id == integration
        };
        let Some(slot) = self.lookup_session_slot_by_id(&terminal_id)? else {
            return Ok(false);
        };
        let record = slot.lock()?;
        let (record, _) = slot
            .changed
            .wait_timeout_while(record, timeout, |record| {
                matches(record) && (!record.prompt_ready || record.active_command.is_some())
            })
            .map_err(|_| "TERMINAL_COMMAND_UNAVAILABLE")?;
        Ok(matches(&record) && record.prompt_ready && record.active_command.is_none())
    }

    pub(crate) fn mark_command_uncertain(
        &self,
        transport_session_id: &str,
        command_id: &str,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        let Some(command) = &record.active_command else {
            return Ok(false);
        };
        if command.command_id()?.as_str() != command_id {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        Ok(settle_command_uncertain(
            command,
            record.next_output_sequence.saturating_sub(1),
        ))
    }

    pub(crate) fn retire_command(
        &self,
        transport_session_id: &str,
        command_id: &str,
    ) -> Result<(), String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        let Some(command) = record.active_command.as_ref() else {
            return Ok(());
        };
        if command.command_id()?.as_str() != command_id {
            return Err("TERMINAL_COMMAND_IDENTITY_MISMATCH".into());
        }
        {
            let data = command.lock()?;
            if data.lifecycle.phase() == CommandPhase::CancelRequested
                && (!data.lifecycle.may_have_submitted() || data.lifecycle.source_rejected())
                && data.source_may_be_enqueued
            {
                return Ok(());
            }
        }
        command.finalize_capture(record.next_output_sequence.saturating_sub(1))?;
        {
            let data = command.lock()?;
            if data.lifecycle.may_have_submitted()
                && !data.lifecycle.ended()
                && !data.lifecycle.source_rejected()
                && (data.native_protocol
                    || !data.lifecycle.started()
                    || record.integration_state != TerminalIntegrationState::Ready)
            {
                record.native_recovery_required = true;
                record.command_input_pending = true;
            }
            if !data.lifecycle.started() && !record.command_input_pending {
                record.prompt_ready = record.integration_state == TerminalIntegrationState::Ready;
            }
        }
        record.active_command = None;
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(())
    }

    pub(crate) fn acquire_agent_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        self.acquire_agent_lease_for_input(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            false,
        )
    }

    pub(crate) fn acquire_agent_interactive_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        self.acquire_agent_lease_for_input(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            true,
        )
    }

    fn acquire_agent_lease_for_input(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        interactive: bool,
    ) -> Result<Option<TerminalLeaseSnapshot>, String> {
        validate_identifier(agent_session_id, "Agent Session id")?;
        validate_identifier(task_id, "task id")?;
        validate_identifier(operation_id, "operation id")?;
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let interactive_enabled = state.interactive_tools_rollout.enabled;
        let remote_interactive_enabled = state.remote_interactive_tools_rollout.enabled;
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        if record.user_controls_foreground() {
            return Err("TERMINAL_BROKER_LEASE_BUSY".into());
        }
        if interactive {
            if !interactive_enabled
                || (record.transport_kind == TerminalTransportKind::SshPty
                    && !remote_interactive_enabled)
            {
                return Err("TERMINAL_INTERACTIVE_TOOLS_DISABLED".into());
            }
            if !record.open
                || record.integration_state != TerminalIntegrationState::Ready
                || record.active_command.is_some()
            {
                return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
            }
        }
        if record.native_clear_pending.is_some() || record.native_recovery_required {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: edit restoration is not confirmed".into(),
            );
        }
        if record.transport_kind == TerminalTransportKind::SshPty {
            if !remote_visible_command_enabled
                || record.integration_state != TerminalIntegrationState::Ready
            {
                return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
            }
            if !interactive && (!record.prompt_ready || record.active_command.is_some()) {
                return Err("TERMINAL_VISIBLE_COMMAND_BUSY".into());
            }
        }
        let current = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        if !matches!(current.owner, TerminalLeaseOwner::User { .. }) {
            return Err("TERMINAL_BROKER_LEASE_BUSY".into());
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let lease = TerminalLeaseSnapshot {
            lease_id: opaque_id("lease"),
            revision,
            owner: TerminalLeaseOwner::Agent {
                owner_id: agent_session_id.to_string(),
                agent_session_id: agent_session_id.to_string(),
                task_id: task_id.to_string(),
                operation_id: operation_id.to_string(),
            },
        };
        record.lease = Some(lease.clone());
        Ok(Some(lease))
    }

    pub(crate) fn release_agent_lease(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
    ) -> Result<bool, String> {
        self.release_agent_lease_checked(
            transport_session_id,
            agent_session_id,
            task_id,
            operation_id,
            false,
        )
    }

    pub(crate) fn handoff_running_command(
        &self,
        transport: &str,
        operation: &Arc<TerminalCommandOperation>,
    ) -> Result<Option<TerminalCommandSnapshot>, String> {
        let state = self.lock()?;
        let attachment = current_attachment(&state, transport)?.clone();
        let mut record_guard = current_record_mut(&state, transport, &attachment)?;
        let record = &mut *record_guard;
        let mut data = operation.lock()?;
        if data.lifecycle.phase() != CommandPhase::Running
            || data.lifecycle.requested_settlement().is_some()
            || data.takeover_pending
            || !data
                .handoff_screen
                .as_ref()
                .is_some_and(TerminalScreenModel::is_alternate_screen)
        {
            return Ok(None);
        }
        let identity = &data.intent.identity;
        let lease = record
            .lease
            .as_ref()
            .ok_or("TERMINAL_BROKER_LEASE_UNAVAILABLE")?;
        if !record
            .active_command
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, operation))
            || record.integration_id != data.integration_id
            || record.integration_state != TerminalIntegrationState::Ready
            || record.native_recovery_required
            || record.native_clear_pending.is_some()
            || !data.native_protocol
            || !data.submission_intent_recorded
            || lease.lease_id != identity.lease_id
            || lease.revision != identity.lease_generation
            || !matches!(&lease.owner, TerminalLeaseOwner::Agent { agent_session_id, task_id, operation_id, .. }
                if agent_session_id == &identity.agent_session_id && task_id == &identity.task_id && operation_id == &identity.operation_id)
        {
            return Err(
                "TERMINAL_HANDOFF_UNAVAILABLE: foreground command ownership changed".into(),
            );
        }
        let revision = next_command_revision(lease.revision)?;
        advance_integration_state_revision(record)?;
        data.handed_off = true;
        data.handoff_screen = None;
        record.lease = Some(user_lease(revision));
        record.command_input_pending = false;
        let mut snapshot = command_snapshot(&data);
        snapshot.command_observation = Some(command_observation(&data));
        drop(data);
        drop(record_guard);
        notify_session(&state, &attachment.terminal_session_id);
        self.changed.notify_all();
        Ok(Some(snapshot))
    }

    pub(crate) fn release_agent_lease_checked(
        &self,
        transport_session_id: &str,
        agent_session_id: &str,
        task_id: &str,
        operation_id: &str,
        require_confirmed_prompt: bool,
    ) -> Result<bool, String> {
        let state = self.lock()?;
        if !state.rollout.enabled {
            return Ok(false);
        }
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let mut record_guard = current_record_mut(&state, transport_session_id, &attachment)?;
        let record = &mut *record_guard;
        // Use the same critical section as input admission. A check on a
        // detached snapshot would permit another admission before release.
        if require_confirmed_prompt
            && (record.integration_state != TerminalIntegrationState::Ready
                || !record.prompt_ready
                || record.active_command.is_some()
                || record.prompt_next_input_sequence != record.next_input_sequence
                || record.command_input_pending)
        {
            return Err("TERMINAL_INTERACTIVE_NOT_AT_SHELL_BOUNDARY".into());
        }
        let lease = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?;
        match &lease.owner {
            TerminalLeaseOwner::Agent {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                ..
            }
            | TerminalLeaseOwner::Revoking {
                agent_session_id: expected_agent,
                task_id: expected_task,
                operation_id: expected_operation,
                ..
            } if expected_agent == agent_session_id
                && expected_task == task_id
                && expected_operation == operation_id => {}
            TerminalLeaseOwner::User { .. } => return Ok(false),
            _ => return Err("TERMINAL_BROKER_LEASE_IDENTITY_MISMATCH".into()),
        }
        let revision = lease
            .revision
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if revision > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        if let Some(command) = &record.active_command {
            let data = command.lock()?;
            if data.lifecycle.requested_settlement().is_some()
                && data.lifecycle.may_have_submitted()
                && !record.prompt_ready
            {
                record.command_input_pending = true;
            }
        }
        record.lease = Some(user_lease(revision));
        Ok(true)
    }

    pub(crate) fn admit_terminal_input<F>(
        &self,
        transport_session_id: &str,
        source: TerminalBrokerInputSource,
        input_kind: TerminalInputKind,
        bytes: &[u8],
        write: F,
    ) -> Result<Option<TerminalInputReceipt>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.admit_terminal_input_with_turn_guard(
            transport_session_id,
            source,
            input_kind,
            bytes,
            false,
            write,
        )
    }

    pub(crate) fn admit_terminal_input_with_turn_guard<F>(
        &self,
        transport_session_id: &str,
        source: TerminalBrokerInputSource,
        input_kind: TerminalInputKind,
        bytes: &[u8],
        require_foreground_handoff: bool,
        write: F,
    ) -> Result<Option<TerminalInputReceipt>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let state = self.lock()?;
        let looked_up = state
            .transports
            .get(transport_session_id)
            .and_then(|attachment| {
                state
                    .sessions
                    .get(&attachment.terminal_session_id)
                    .map(|slot| (attachment.clone(), slot.clone()))
            });
        let mut record_guard = match looked_up.as_ref() {
            Some((_, slot)) => Some(slot.lock()?),
            None => None,
        };
        if require_foreground_handoff {
            let handoff_active = looked_up.as_ref().zip(record_guard.as_deref()).is_some_and(
                |((attachment, _), record)| {
                    record.open
                        && record.transport_session_id == transport_session_id
                        && record.terminal_generation == attachment.terminal_generation
                        && record.user_controls_foreground()
                },
            );
            if !handoff_active {
                return Err("TERMINAL_INPUT_BLOCKED_BY_AGENT: user input is blocked while an Agent owns the terminal".into());
            }
        }
        // Even a lease release or trusted feature rollback must not expose a
        // partially typed command to a later user Enter. A scoped interrupt is
        // still allowed; only a trusted prompt or a new generation clears it.
        if let Some(record) = record_guard.as_deref() {
            let owned_clear = bytes == [0x18, 0x04]
                && matches!(&source,TerminalBrokerInputSource::System{operation_id}if record.native_clear_pending.as_ref().is_some_and(|(expected,_,_,_)|expected==operation_id));
            let owned_native_clear = input_kind == TerminalInputKind::NativeDraftClear
                && record.active_command.as_ref().is_some_and(|command|command.lock().is_ok_and(|data|
                    data.native_protocol && data.lifecycle.phase()==CommandPhase::CancelRequested && !data.lifecycle.may_have_submitted()
                    && matches!(&source,TerminalBrokerInputSource::Agent {operation_id,..} if operation_id==&data.intent.identity.operation_id)));
            if bytes == [0x18, 0x04]
                && matches!(&source, TerminalBrokerInputSource::System { .. })
                && !owned_clear
            {
                return Err("TERMINAL_BROKER_SYSTEM_CONTROL_NOT_SCOPED".into());
            }
            if record.native_recovery_required
                && bytes != [3]
                && !owned_clear
                && !owned_native_clear
            {
                return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: native editor acknowledgement was lost or mismatched; reconnect before further input".into());
            }
            if record.command_input_pending && bytes != [3] && !owned_clear && !owned_native_clear {
                let continuing_command = matches!(&source, TerminalBrokerInputSource::Agent { .. })
                    && record
                        .active_command
                        .as_ref()
                        .map(|command| {
                            command
                                .lock()
                                .map(|data| data.state() == TerminalCommandState::Submitted)
                        })
                        .transpose()?
                        .unwrap_or(false);
                if !continuing_command {
                    return Err("TERMINAL_INPUT_RECOVERY_REQUIRED: command input was interrupted; wait for the shell prompt or reconnect the terminal".into());
                }
            }
        }
        if !state.rollout.enabled {
            drop(record_guard);
            write()?;
            return Ok(None);
        }
        let remote_visible_command_enabled = state.remote_bound_terminal_rollout.enabled;
        let terminal_execute_enabled = state.terminal_execute_rollout.enabled;
        let prepared_job = match &source {
            TerminalBrokerInputSource::Agent { operation_id, .. }
            | TerminalBrokerInputSource::System { operation_id } => state
                .prepared_job_commands
                .get(operation_id)
                .map(|prepared| (operation_id.clone(), prepared.clone())),
            TerminalBrokerInputSource::User => None,
        };
        let attachment = current_attachment(&state, transport_session_id)?.clone();
        let record = record_guard
            .as_deref_mut()
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        if !record.open {
            return Err("TERMINAL_BROKER_GENERATION_CLOSED".into());
        }
        if record.transport_session_id != transport_session_id
            || record.terminal_generation != attachment.terminal_generation
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let scoped_native_interrupt = matches!(&source,TerminalBrokerInputSource::System{operation_id} if input_kind==TerminalInputKind::Interrupt && bytes==[3] && record.active_command.as_ref().is_some_and(|command|command.lock().is_ok_and(|data|data.native_protocol && data.intent.identity.operation_id==*operation_id && data.lifecycle.may_have_submitted() && !data.lifecycle.ended())));
        if let Some((operation, prepared)) =
            prepared_job.as_ref().filter(|_| !scoped_native_interrupt)
        {
            validate_prepared_shell_job(record, prepared, operation)?;
        }
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && !remote_visible_command_enabled
            && !scoped_native_interrupt
        {
            return Err("TERMINAL_VISIBLE_COMMAND_UNAVAILABLE".into());
        }
        if record.active_command.is_some() && !terminal_execute_enabled && !scoped_native_interrupt
        {
            return Err("TERMINAL_EXECUTE_DISABLED".into());
        }
        if !matches!(&source, TerminalBrokerInputSource::User)
            && record.transport_kind == TerminalTransportKind::SshPty
            && record.integration_state != TerminalIntegrationState::Ready
            && !scoped_native_interrupt
        {
            return Err("TERMINAL_INTEGRATION_NOT_READY".into());
        }
        let lease_id = record
            .lease
            .as_ref()
            .ok_or_else(|| "TERMINAL_BROKER_LEASE_UNAVAILABLE".to_string())?
            .lease_id
            .clone();
        if bytes != [3]
            && matches!(source, TerminalBrokerInputSource::User)
            && record.active_command.as_ref().is_some_and(|command| {
                command.lock().is_ok_and(|data| {
                    data.lifecycle.requested_settlement().is_some()
                        && data.lifecycle.may_have_submitted()
                        && !data.lifecycle.ended()
                })
            })
        {
            return Err(
                "TERMINAL_INPUT_RECOVERY_REQUIRED: stop settlement is not confirmed".into(),
            );
        }
        let receipt = validate_input_fields(
            record,
            &record.terminal_session_id,
            record.terminal_generation,
            &lease_id,
            record.next_input_sequence,
            &source,
            input_kind,
            bytes.len(),
        )?;
        let next_input_sequence = record
            .next_input_sequence
            .checked_add(1)
            .ok_or_else(counter_exhausted)?;
        if next_input_sequence > JAVASCRIPT_MAX_SAFE_INTEGER {
            return Err(counter_exhausted());
        }
        let read_only_probe = bytes == [0x18, 0x01]
            && record.active_command.as_ref().is_some_and(|command| {
                command.lock().is_ok_and(|data| {
                    data.native_read_only_probe
                        && !data.source_may_be_enqueued
                        && data
                            .native_checkpoint
                            .as_ref()
                            .is_some_and(|(prefix, _)| prefix.is_empty())
                })
            });
        let user_submission = matches!(&source, TerminalBrokerInputSource::User)
            && record.prompt_ready
            && (bytes == b"\n" || bytes == b"\r");
        let submitted_agent_line = matches!(&source, TerminalBrokerInputSource::Agent { .. })
            && (bytes == [0x18, 0x05] || bytes == b"\n" || bytes == b"\r");
        let command_input_pending = matches!(&source, TerminalBrokerInputSource::Agent { .. })
            && record
                .active_command
                .as_ref()
                .map(|command| {
                    command
                        .lock()
                        .map(|data| data.state() == TerminalCommandState::Submitted)
                })
                .transpose()?
                .unwrap_or(false);
        // Authorization, transport admission, and input-sequence commit share
        // the broker lock. A rejected transport enqueue therefore consumes no
        // sequence and writes no partial input.
        if matches!(&source, TerminalBrokerInputSource::Agent { .. })
            && bytes != [0x18, 0x01]
            && bytes != [0x18, 0x02]
        {
            if let Some(command) = &record.active_command {
                // Called while the execution registration's submit/cancel/
                // takeover gate is held. Mark before a queue callback can
                // possibly deliver data, including an ambiguous enqueue error.
                let mut data = command.lock()?;
                if input_kind == TerminalInputKind::NativePrepare {
                    record.last_native_prepared = Some(data.intent.identity.clone());
                }
                if input_kind == TerminalInputKind::Executable {
                    if data.takeover_pending {
                        return Err("TERMINAL_LEASE_TAKEN_OVER".into());
                    }
                    if data.native_prepare_rejected {
                        return Err("TERMINAL_NATIVE_SOURCE_REJECTED".into());
                    }
                    if !data.submission_intent_recorded {
                        return Err("TERMINAL_SUBMISSION_INTENT_REQUIRED".into());
                    }
                    if data.native_protocol
                        && (!data.native_capabilities_confirmed || !data.native_commit_armed)
                    {
                        return Err("TERMINAL_NATIVE_COMMIT_NOT_ARMED".into());
                    }
                    if data.requires_complete_proof
                        && !data
                            .input_proof
                            .as_ref()
                            .is_some_and(|proof| proof.matches(&data.intent, &data.plan))
                    {
                        return Err("TERMINAL_INPUT_PROOF_REQUIRED".into());
                    }
                    if data.intent.identity.lease_id != lease_id {
                        return Err("TERMINAL_BROKER_STALE_LEASE".into());
                    }
                    let event = if data.requires_complete_proof {
                        CommandEvent::AttemptSubmission
                    } else {
                        CommandEvent::LegacyAttemptSubmission
                    };
                    data.lifecycle.apply(event)?;
                } else if !matches!(
                    input_kind,
                    TerminalInputKind::NativeControl
                        | TerminalInputKind::NativeDraftClear
                        | TerminalInputKind::NativePrepare
                ) && data.lifecycle.can_edit()
                {
                    data.input_proof = None;
                    data.lifecycle.apply(CommandEvent::BeginInput)?;
                }
                data.source_may_be_enqueued = true;
                data.revision = next_command_revision(data.revision)?;
            }
        }
        let next_interactive_guard_buffer = if record.active_command.is_none()
            && matches!(source, TerminalBrokerInputSource::Agent { .. })
        {
            let (inspected, next_buffer) =
                next_interactive_guard_state(&record.interactive_guard_buffer, bytes, input_kind);
            if !inspected.trim().is_empty() {
                let slice = tail_utf8_slice(&inspected, 8192);
                crate::agent_runtime::reject_destructive(slice, None)?;
                if record.transport_kind == TerminalTransportKind::SshPty {
                    crate::agent_runtime::reject_remote_privilege_command(slice)?;
                }
            }
            Some(next_buffer)
        } else {
            None
        };
        write()?;
        if let Some(next_buffer) = next_interactive_guard_buffer {
            record.interactive_guard_buffer = next_buffer;
        } else if matches!(source, TerminalBrokerInputSource::User)
            && (bytes.contains(&b'\r')
                || bytes.contains(&b'\n')
                || bytes.contains(&0x03)
                || bytes.contains(&0x15))
        {
            record.interactive_guard_buffer.clear();
        }
        if record.active_command.is_none()
            && matches!(source, TerminalBrokerInputSource::Agent { .. })
        {
            let previous = record.interactive_input.take();
            let text = std::str::from_utf8(bytes).ok().filter(|text| {
                input_kind == TerminalInputKind::Text && !text.chars().any(char::is_control)
            });
            record.interactive_input = Some(match (previous, text) {
                (None, Some(text))
                    if record.prompt_ready
                        && record.prompt_next_input_sequence == record.next_input_sequence =>
                {
                    InteractiveInput::Draft(text.into())
                }
                (Some(InteractiveInput::Draft(mut draft)), Some(text))
                    if draft.len().saturating_add(text.len()) <= MAX_FRAME_BYTES =>
                {
                    draft.push_str(text);
                    InteractiveInput::Draft(draft)
                }
                (Some(InteractiveInput::Draft(line)), None)
                    if input_kind == TerminalInputKind::Key && bytes == b"\r" =>
                {
                    InteractiveInput::Submitted {
                        line,
                        through: next_input_sequence,
                    }
                }
                _ => InteractiveInput::Unconfirmed,
            });
        }
        if input_kind == TerminalInputKind::Interrupt
            && bytes == [3]
            && matches!(source, TerminalBrokerInputSource::System { .. })
        {
            if let Some(command) = &record.active_command {
                let mut data = command.lock()?;
                if !data.native_protocol
                    && data.lifecycle.phase() == CommandPhase::CancelRequested
                    && data.lifecycle.submission_revoked()
                    && !data.lifecycle.may_have_submitted()
                {
                    data.lifecycle
                        .apply(CommandEvent::LegacyInterruptEnqueued)?;
                    data.revision = next_command_revision(data.revision)?;
                }
            }
        }
        if bytes == [0x18, 0x04] && matches!(&source, TerminalBrokerInputSource::System { .. }) {
            if let Some((_, _, _, queued)) = &mut record.native_clear_pending {
                *queued = true;
            }
        }
        if command_input_pending && !read_only_probe {
            record.command_input_pending = true;
        }
        if submitted_agent_line {
            record.native_clear_scope = None;
        }
        record.next_input_sequence = next_input_sequence;
        if user_submission {
            record.prompt_ready = false;
            advance_integration_state_revision(record)?;
            drop(record_guard);
            notify_session(&state, &attachment.terminal_session_id);
            self.changed.notify_all();
        }
        Ok(Some(receipt))
    }

    pub(crate) fn snapshot(
        &self,
        transport_session_id: Option<&str>,
    ) -> Result<TerminalBrokerSnapshot, String> {
        if let Some(transport_session_id) = transport_session_id {
            validate_identifier(transport_session_id, "transport session id")?;
        }
        let (
            rollout,
            shell_integration_rollout,
            terminal_execute_rollout,
            remote_bound_terminal_rollout,
            interactive_tools_rollout,
            remote_interactive_tools_rollout,
            slot,
        ) = {
            let state = self.lock()?;
            let slot = transport_session_id
                .and_then(|transport_session_id| state.transports.get(transport_session_id))
                .and_then(|attachment| state.sessions.get(&attachment.terminal_session_id))
                .cloned();
            (
                state.rollout.clone(),
                state.shell_integration_rollout.clone(),
                state.terminal_execute_rollout.clone(),
                state.remote_bound_terminal_rollout.clone(),
                state.interactive_tools_rollout.clone(),
                state.remote_interactive_tools_rollout.clone(),
                slot,
            )
        };
        let session = slot.map(|slot| slot.lock()?.snapshot()).transpose()?;
        Ok(TerminalBrokerSnapshot {
            rollout,
            shell_integration_rollout,
            terminal_execute_rollout,
            remote_bound_terminal_rollout,
            interactive_tools_rollout,
            remote_interactive_tools_rollout,
            counters: self.counters.snapshot(),
            session,
        })
    }

    #[cfg(any(
        test,
        all(
            feature = "native-input-acceptance",
            debug_assertions,
            target_os = "macos",
            target_arch = "aarch64"
        )
    ))]
    pub(crate) fn acceptance_raw_output(
        &self,
        transport_session_id: &str,
    ) -> Result<TerminalAcceptanceRawOutput, String> {
        validate_identifier(transport_session_id, "transport session id")?;
        let state = self.lock()?;
        let attachment = state.transports.get(transport_session_id).ok_or_else(|| {
            if state.sessions.values().any(|slot| {
                slot.lock().is_ok_and(|record| {
                    record
                        .predecessor_transport_session_ids
                        .iter()
                        .any(|previous| previous == transport_session_id)
                })
            }) {
                "TERMINAL_BROKER_STALE_GENERATION".to_string()
            } else {
                "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string()
            }
        })?;
        let slot = state
            .sessions
            .get(&attachment.terminal_session_id)
            .cloned()
            .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
        let attachment = attachment.clone();
        drop(state);
        let record = slot.lock()?;
        if record.terminal_generation != attachment.terminal_generation
            || record.transport_session_id != transport_session_id
        {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        let complete_from_start = match (record.replay.front(), record.replay.back()) {
            (Some(first), Some(last)) => {
                first.sequence == 1
                    && first.byte_offset == 0
                    && record.replay_bytes as u64 == record.next_byte_offset
                    && last.sequence.checked_add(1) == Some(record.next_output_sequence)
            }
            (None, None) => record.next_output_sequence == 1 && record.next_byte_offset == 0,
            _ => false,
        };
        Ok(TerminalAcceptanceRawOutput {
            terminal_session_id: record.terminal_session_id.clone(),
            terminal_generation: record.terminal_generation,
            transport_session_id: record.transport_session_id.clone(),
            open: record.open,
            next_output_sequence: record.next_output_sequence,
            next_byte_offset: record.next_byte_offset,
            complete_from_start,
            captured_bytes: record.capture.clone(),
            capture_truncated: record.capture_truncated,
            capture_complete_from_start: !record.capture_truncated
                && record.capture.len() as u64 == record.next_byte_offset
                && record.subscribers.capture.next_sequence == record.next_output_sequence
                && record.subscribers.capture.observed_frames + 1 == record.next_output_sequence
                && record.subscribers.capture.observed_bytes == record.next_byte_offset,
            captured_frame_count: record.subscribers.capture.observed_frames,
            captured_byte_count: record.subscribers.capture.observed_bytes,
            frames: record.replay.iter().cloned().collect(),
        })
    }

    #[cfg(test)]
    pub(crate) fn replay_output(
        &self,
        terminal_session_id: &str,
        terminal_generation: u64,
        from_sequence: u64,
        max_frames: usize,
        max_bytes: usize,
    ) -> Result<TerminalReplayBatch, String> {
        let slot = self
            .lookup_session_slot_by_id(terminal_session_id)?
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let record = slot.lock()?;
        if record.terminal_generation != terminal_generation {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        replay_from_record(&record, from_sequence, max_frames, max_bytes, self.config)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        close_all_open_generations(
            &mut state,
            TerminalGenerationCloseReason::BrokerShutdown,
            self.config.closed_session_capacity,
        )?;
        self.changed.notify_all();
        Ok(())
    }

    fn with_current_record_mut(
        &self,
        transport_session_id: &str,
        update: impl FnOnce(&mut SessionRecord) -> Result<(), String>,
    ) -> Result<(), String> {
        let Some((attachment, slot)) = self.lookup_enabled_session_slot(transport_session_id)?
        else {
            return Ok(());
        };
        let mut record = slot.lock_current(transport_session_id, &attachment)?;
        update(&mut record)?;
        drop(record);
        slot.notify();
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BrokerState>, String> {
        self.state
            .lock()
            .map_err(|_| "TERMINAL_BROKER_UNAVAILABLE".to_string())
    }

    #[cfg(test)]
    pub(crate) fn enabled_for_test(
        replay_max_frames: usize,
        replay_max_bytes: usize,
        capture: usize,
    ) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                replay_max_frames,
                replay_max_bytes,
                capture_max_bytes: capture,
                closed_session_capacity: DEFAULT_CLOSED_SESSION_CAPACITY,
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase3_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(all(test, unix))]
    pub(crate) fn phase3_with_journal_for_test(capture: usize, root: &std::path::Path) -> Self {
        let mut broker = Self::phase3_enabled_for_test(capture);
        let journal = SubmissionJournal::unconfigured();
        journal.configure(root).unwrap();
        broker.submission_journal = journal;
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase4_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase5_enabled_for_test(capture: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                capture_max_bytes: capture,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    pub(crate) fn phase5_with_journal_for_test(capture: usize, root: &std::path::Path) -> Self {
        let mut broker = Self::phase5_enabled_for_test(capture);
        let journal = SubmissionJournal::unconfigured();
        journal.configure(root).unwrap();
        broker.submission_journal = journal;
        broker
    }

    #[cfg(test)]
    fn enabled_with_closed_capacity_for_test(closed_session_capacity: usize) -> Self {
        let broker = Self {
            state: Arc::new(Mutex::new(BrokerState::default())),
            changed: Arc::new(BrokerSignal::new()),
            counters: Arc::new(TerminalRolloutCounters::default()),
            submission_journal: SubmissionJournal::temporary(),
            config: TerminalBrokerConfig {
                closed_session_capacity,
                ..TerminalBrokerConfig::default()
            },
        };
        broker
            .apply_trusted_rollout(
                true,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
                false,
                TerminalBrokerRolloutSource::Test,
            )
            .unwrap();
        broker
    }

    #[cfg(test)]
    fn ingest_test_frame(
        &self,
        frame: TerminalRawOutputFrame,
    ) -> Result<RawFrameAcceptance, String> {
        let slot = self
            .lookup_session_slot_by_id(&frame.terminal_session_id)?
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let mut record = slot.lock()?;
        if record.terminal_generation != frame.terminal_generation {
            return Err("TERMINAL_BROKER_STALE_GENERATION".into());
        }
        accept_raw_frame(&mut record, frame, self.config, &self.counters)
    }

    #[cfg(test)]
    fn validate_test_input(
        &self,
        request: &TerminalInputRequest,
    ) -> Result<TerminalInputReceipt, String> {
        let slot = self
            .lookup_session_slot_by_id(&request.terminal_session_id)?
            .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
        let record = slot.lock()?;
        validate_input(&record, request)
    }

    #[cfg(test)]
    fn captured_bytes(&self, terminal_session_id: &str) -> Vec<u8> {
        let slot = self
            .state
            .lock()
            .unwrap()
            .sessions
            .get(terminal_session_id)
            .cloned()
            .unwrap();
        let captured = slot.lock().unwrap().capture.clone();
        captured
    }

    #[cfg(test)]
    fn metadata_counts(&self) -> (usize, usize, usize) {
        let state = self.state.lock().unwrap();
        (
            state.sessions.len(),
            state.transports.len(),
            state.closed_session_order.len(),
        )
    }
}

/// Narrow benchmark facade. It exercises the same bounded broker fan-out as
/// production without exposing broker mutation or rollout controls to the UI.
pub struct TerminalBrokerBenchmarkObserver {
    broker: TerminalSessionBroker,
    transport_session_id: &'static str,
}

impl TerminalBrokerBenchmarkObserver {
    pub fn local() -> Result<Self, String> {
        Self::attach("benchmark-local", TerminalTransportKind::LocalPty)
    }

    pub fn ssh() -> Result<Self, String> {
        Self::attach("benchmark-ssh", TerminalTransportKind::SshPty)
    }

    fn attach(
        transport_session_id: &'static str,
        transport_kind: TerminalTransportKind,
    ) -> Result<Self, String> {
        let broker = TerminalSessionBroker::default();
        broker.apply_trusted_rollout(
            true,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
            false,
            TerminalBrokerRolloutSource::Environment,
        )?;
        broker.attach_transport(
            transport_session_id,
            None,
            transport_kind,
            TerminalGeometry::new(120, 30),
        )?;
        Ok(Self {
            broker,
            transport_session_id,
        })
    }

    pub fn observe(&self, bytes: &[u8]) -> Result<(), String> {
        self.broker
            .observe_raw_output(self.transport_session_id, bytes)
            .map(|_| ())
    }
}

fn close_all_open_generations(
    state: &mut BrokerState,
    reason: TerminalGenerationCloseReason,
    closed_session_capacity: usize,
) -> Result<(), String> {
    let mut closing = Vec::new();
    for (terminal_session_id, slot) in &state.sessions {
        let mut record = slot.lock()?;
        if record.open {
            record.close(reason)?;
            drop(record);
            slot.notify();
            closing.push(terminal_session_id.clone());
        }
    }
    for attachment in state.transports.values_mut() {
        attachment.active = false;
    }
    for terminal_session_id in closing {
        remember_closed_session(state, &terminal_session_id, closed_session_capacity);
    }
    Ok(())
}

fn remember_closed_session(
    state: &mut BrokerState,
    terminal_session_id: &str,
    closed_session_capacity: usize,
) {
    state
        .closed_session_order
        .retain(|closed_id| closed_id != terminal_session_id);
    state
        .closed_session_order
        .push_back(terminal_session_id.to_string());
    while state.closed_session_order.len() > closed_session_capacity {
        let Some(evicted_session_id) = state.closed_session_order.pop_front() else {
            break;
        };
        if state
            .sessions
            .get(&evicted_session_id)
            .is_some_and(|slot| slot.lock().is_ok_and(|record| !record.open))
        {
            state.sessions.remove(&evicted_session_id);
            state
                .transports
                .retain(|_, attachment| attachment.terminal_session_id != evicted_session_id);
            state
                .jobs
                .retain(|_, job| job.terminal_session_id != evicted_session_id);
            state
                .prepared_job_commands
                .retain(|_, prepared| prepared.job.terminal_session_id != evicted_session_id);
        }
    }
}

fn effective_interactive_tools_for_transport(
    state: &BrokerState,
    transport_kind: TerminalTransportKind,
) -> bool {
    state.interactive_tools_rollout.enabled
        && (transport_kind != TerminalTransportKind::SshPty
            || (state.remote_bound_terminal_rollout.enabled
                && state.remote_interactive_tools_rollout.enabled))
}

fn transport_predecessor<'a>(
    state: &'a BrokerState,
    transport: &str,
) -> Result<std::sync::MutexGuard<'a, SessionRecord>, String> {
    let attachment = state
        .transports
        .get(transport)
        .ok_or("TERMINAL_BROKER_PREDECESSOR_NOT_FOUND")?;
    let slot = state
        .sessions
        .get(&attachment.terminal_session_id)
        .ok_or("TERMINAL_BROKER_SESSION_NOT_FOUND")?;
    let record = slot.lock()?;
    if record.terminal_generation != attachment.terminal_generation
        || record.transport_session_id != transport
    {
        return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
    }
    Ok(record)
}

fn new_transport_record(
    state: &BrokerState,
    transport: &str,
    predecessor: Option<&str>,
    kind: TerminalTransportKind,
    geometry: TerminalGeometry,
    mode: InputMode,
) -> Result<SessionRecord, String> {
    let (session_id, generation) = if let Some(predecessor) = predecessor {
        let old = transport_predecessor(state, predecessor)?;
        let generation = old
            .terminal_generation
            .checked_add(1)
            .filter(|generation| *generation <= JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(counter_exhausted)?;
        (old.terminal_session_id.clone(), generation)
    } else {
        (format!("terminal-{}", Uuid::new_v4()), 1)
    };
    let mut record = SessionRecord::open(
        session_id,
        generation,
        transport.to_owned(),
        kind,
        geometry,
        effective_interactive_tools_for_transport(state, kind),
    );
    record.input_mode = mode;
    Ok(record)
}

fn install_transport_record(
    state: &mut BrokerState,
    mut record: SessionRecord,
    predecessor: Option<&str>,
) -> Result<TerminalBrokerAttachment, String> {
    let transport = &record.transport_session_id;
    if state
        .transports
        .get(transport)
        .is_some_and(|attachment| attachment.active)
    {
        return Err("TERMINAL_BROKER_TRANSPORT_ALREADY_ATTACHED".into());
    }
    let terminal_session_id = record.terminal_session_id.clone();
    let terminal_generation = record.terminal_generation;
    if let Some(predecessor) = predecessor {
        {
            let mut old = transport_predecessor(state, predecessor)?;
            if old.terminal_session_id != terminal_session_id
                || old.terminal_generation + 1 != terminal_generation
            {
                return Err("TERMINAL_BROKER_STALE_PREDECESSOR".into());
            }
            if old.open {
                old.close(TerminalGenerationCloseReason::Replaced)?;
            }
            record.predecessor_transport_session_ids =
                old.predecessor_transport_session_ids.clone();
        }
        if let Some(old_slot) = state.sessions.get(&terminal_session_id) {
            old_slot.notify();
        }
        record
            .predecessor_transport_session_ids
            .push(predecessor.to_owned());
        if record.predecessor_transport_session_ids.len() > 32 {
            record.predecessor_transport_session_ids.remove(0);
        }
    }
    // Keep only the current or most recently closed transport for each session.
    state
        .transports
        .retain(|_, attachment| attachment.terminal_session_id != terminal_session_id);
    state
        .closed_session_order
        .retain(|closed_id| closed_id != &terminal_session_id);
    state.transports.insert(
        transport.clone(),
        TransportAttachment {
            terminal_session_id: terminal_session_id.clone(),
            terminal_generation,
            active: true,
        },
    );
    state.sessions.insert(
        terminal_session_id.clone(),
        Arc::new(SessionSlot::new(record)),
    );
    Ok(TerminalBrokerAttachment {
        terminal_session_id,
        terminal_generation,
    })
}

fn current_attachment<'a>(
    state: &'a BrokerState,
    transport_session_id: &str,
) -> Result<&'a TransportAttachment, String> {
    let attachment = state
        .transports
        .get(transport_session_id)
        .ok_or_else(|| "TERMINAL_BROKER_TRANSPORT_NOT_FOUND".to_string())?;
    if !attachment.active {
        return Err("TERMINAL_BROKER_STALE_TRANSPORT".into());
    }
    Ok(attachment)
}

fn notify_session(state: &BrokerState, terminal_session_id: &str) {
    if let Some(slot) = state.sessions.get(terminal_session_id) {
        slot.notify();
    }
}

fn current_record_mut<'a>(
    state: &'a BrokerState,
    transport_session_id: &str,
    attachment: &TransportAttachment,
) -> Result<std::sync::MutexGuard<'a, SessionRecord>, String> {
    let slot = state
        .sessions
        .get(&attachment.terminal_session_id)
        .ok_or_else(|| "TERMINAL_BROKER_SESSION_NOT_FOUND".to_string())?;
    slot.lock_current(transport_session_id, attachment)
}

fn tail_utf8_slice(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn next_interactive_guard_state(
    existing: &str,
    bytes: &[u8],
    input_kind: TerminalInputKind,
) -> (String, String) {
    if input_kind == TerminalInputKind::Interrupt {
        return (String::new(), String::new());
    }
    if input_kind == TerminalInputKind::Key {
        if bytes == b"\r" || bytes == b"\n" {
            return (existing.to_string(), String::new());
        }
        if bytes == b"\x7f" || bytes == b"\x08" {
            let mut next = existing.to_string();
            next.pop();
            return (String::new(), next);
        }
        return (String::new(), existing.to_string());
    }
    if !matches!(
        input_kind,
        TerminalInputKind::Text | TerminalInputKind::Paste
    ) {
        return (String::new(), existing.to_string());
    }
    let Ok(mut text) = std::str::from_utf8(bytes) else {
        return (String::new(), existing.to_string());
    };
    if input_kind == TerminalInputKind::Paste {
        text = text
            .strip_prefix("\u{1b}[200~")
            .unwrap_or(text)
            .strip_suffix("\u{1b}[201~")
            .unwrap_or(text);
    }
    let mut current = existing.to_string();
    let mut lines = Vec::new();
    for ch in text.chars() {
        match ch {
            '\u{3}' | '\u{15}' => current.clear(),
            '\u{7f}' | '\u{8}' => {
                current.pop();
            }
            '\r' | '\n' => {
                if !current.trim().is_empty() {
                    lines.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
            }
            '\t' => current.push('\t'),
            other if !other.is_control() => current.push(other),
            _ => {}
        }
    }
    if current.len() > 8192 {
        current = tail_utf8_slice(&current, 8192).to_string();
    }
    if !current.trim().is_empty() {
        lines.push(current.clone());
    }
    (lines.join("\n"), current)
}

mod framing;
use framing::*;

#[cfg(test)]
mod tests {
    include!("tests/terminal_broker.rs");
}
