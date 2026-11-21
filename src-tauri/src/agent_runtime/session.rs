use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::redaction::{redact_json_value, redact_sensitive_text};

use super::tool_pipeline::AgentToolDecisionSettlement;
use super::{
    derive_surface, derive_task, AgentAssistantContentBlock, AgentExecutionSurface, AgentInbox,
    AgentInboxLane, AgentInboxMessage, AgentInboxOperation, AgentMessageSource,
    AgentMessageSourceKind, AgentRecoveryCheckpoint, AgentSessionEvent, AgentSessionEventPayload,
    AgentSessionPermissionMode, AgentSessionStatus, AgentSessionTarget, AgentSubagentSession,
    AgentSurfaceMessage, AgentSurfaceSnapshot, AgentTaskProjection, AgentToolApprovalStatus,
    AgentToolDecision, AgentToolDecisionInput, AgentToolResultStatus, RecordedToolCall,
    AGENT_SESSION_EVENT_VERSION, MAX_AGENT_MESSAGE_BYTES, MAX_AGENT_STREAM_DELTA_BYTES,
};

pub(super) mod stream_chunks;
mod validation;

#[cfg(test)]
use validation::validate_optional_stream_delta;
use validation::{
    validate_capability_scope, validate_collection_allow_empty, validate_inbox_message,
    validate_page_limit, validate_session_target, validate_session_title,
    validate_subagent_session, validate_text,
};
pub(super) use validation::{validate_identifier, validate_subagent_budget, validate_task_plan};

// Leave room for JSON escaping of 128 KiB writes and 240 KiB exact-diff
// approval prompts. Large provider replay still moves to artifacts at 256 KiB.
const MAX_SESSION_EVENT_BYTES: usize = 512 * 1024;
const MAX_INLINE_REPLAY_EVENT_BYTES: usize = 256 * 1024;
const MAX_SESSION_LOG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_SESSION_LOG_BYTES: u64 = 256 * 1024 * 1024;
const SESSION_SETTLEMENT_RESERVE_BYTES: u64 = 64 * 1024;
const TOTAL_SETTLEMENT_RESERVE_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const JOURNAL_WRITE_FAILED: &str = "journalWriteFailed";
const MAX_SESSION_COUNT: usize = 512;
const MAX_RECOVERY_EVIDENCE_FILES: usize = 256;
const MAX_RECOVERY_EVIDENCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSION_PAGE_SIZE: usize = 256;
const MAX_EVENT_PAGE_SIZE: usize = 1_024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SUBMISSION_CONTENT_FINGERPRINT: &str = "submissionContentFingerprint";

type EventPublisher = Arc<dyn Fn(&AgentSessionEvent) + Send + Sync>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionHeader {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model_selection: Option<super::AgentSubagentModel>,
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) continued_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<AgentSessionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<AgentSessionPermissionMode>,
    pub(crate) execution_surface: AgentExecutionSurface,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) capability_scope: Option<super::AgentCapabilityScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subagent: Option<AgentSubagentSession>,
    pub(crate) created_at_unix_ms: u64,
}

impl AgentSessionHeader {
    pub(super) fn delegated_target(&self, target_id: &str) -> Option<&AgentSessionTarget> {
        if self
            .capability_scope
            .as_ref()
            .is_some_and(|scope| !scope.target_ids.iter().any(|id| id == target_id))
        {
            return None;
        }
        self.target
            .iter()
            .chain(self.subagent.iter().flat_map(|child| &child.target_scope))
            .find(|target| target.target_id == target_id)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateAgentSessionRequest {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) continued_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<AgentSessionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<AgentSessionPermissionMode>,
    pub(crate) execution_surface: AgentExecutionSurface,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) capability_scope: Option<super::AgentCapabilityScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subagent: Option<AgentSubagentSession>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentInboxMutation {
    Resume {
        item_id: String,
    },
    Update {
        item_id: String,
        content: String,
    },
    UpdateWithImages {
        item_id: String,
        content: String,
        images: super::images::InboxImageEdit,
    },
    Remove {
        item_id: String,
    },
    Steer {
        item_id: String,
    },
    Reorder {
        lane: AgentInboxLane,
        ordered_item_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentInboxMutationInput {
    pub(crate) session_id: String,
    pub(crate) expected_revision: u64,
    pub(crate) client_operation_id: String,
    pub(crate) mutation: AgentInboxMutation,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionRenameInput {
    pub(crate) session_id: String,
    pub(crate) expected_revision: u64,
    pub(crate) client_operation_id: String,
    pub(crate) title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionSnapshot {
    pub(crate) header: AgentSessionHeader,
    pub(crate) status: AgentSessionStatus,
    pub(crate) ended: bool,
    pub(crate) archived: bool,
    pub(crate) event_count: u64,
    pub(crate) surface: AgentSurfaceSnapshot,
    pub(crate) inbox: AgentInboxProjection,
    pub(crate) task: AgentTaskProjection,
    pub(crate) recovery: AgentRecoveryCheckpoint,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) uncertain_native_effects: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) child_failure_recovery: Option<super::AgentChildFailureRecovery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) child_continuation: Option<super::AgentChildContinuation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentInboxProjection {
    pub(crate) paused_ids: Vec<String>,
    pub(crate) next_turn: Vec<AgentInboxMessage>,
    pub(crate) next_step: Vec<AgentInboxMessage>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionListItem {
    pub(crate) header: AgentSessionHeader,
    pub(crate) status: AgentSessionStatus,
    pub(crate) ended: bool,
    pub(crate) archived: bool,
    pub(crate) event_count: u64,
    pub(crate) pending_turns: usize,
    pub(crate) pending_step_messages: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionListRequest {
    #[serde(default)]
    pub(crate) cursor: Option<String>,
    pub(crate) limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionListPage {
    pub(crate) sessions: Vec<AgentSessionListItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next_cursor: Option<String>,
    pub(crate) recovery_notices: Vec<AgentSessionRecoveryNotice>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionEventsRequest {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) cursor: Option<u64>,
    pub(crate) limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCommittedEventsRequest {
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) after_seq: Option<u64>,
    pub(crate) limit: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionEventPage {
    pub(crate) events: Vec<AgentSessionEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next_cursor: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) storage_fault_at_seq: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct AgentScopedPayload {
    pub(crate) turn_id: Option<String>,
    pub(crate) step_id: Option<String>,
    pub(crate) payload: AgentSessionEventPayload,
}

pub(crate) struct AgentSubagentToolSettlement {
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) status: super::AgentToolResultStatus,
    pub(crate) data: Option<serde_json::Value>,
}

pub(crate) struct AgentClaimedStep {
    pub(crate) messages: Vec<AgentInboxMessage>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentSessionRecoveryAction {
    BadTailDiscarded,
    CorruptLogQuarantined,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionRecoveryNotice {
    pub(crate) file_name: String,
    pub(crate) action: AgentSessionRecoveryAction,
    pub(crate) reason: String,
    pub(crate) evidence_file_name: String,
    pub(crate) recorded_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct AgentSessionRecord {
    header: AgentSessionHeader,
    status: AgentSessionStatus,
    ended: bool,
    storage_fault_at_seq: Option<u64>,
    archived: bool,
    events: Vec<AgentSessionEvent>,
    inbox: AgentInbox,
    driver_metrics: super::driver_metrics::DriverMetrics,
    loop_progress: super::driver_progress::LoopProgress,
    snapshot_cache: Arc<OnceLock<AgentSessionSnapshot>>,
}

impl AgentSessionRecord {
    fn note_storage_fault(&mut self) {
        if !self.ended {
            self.storage_fault_at_seq = self.events.last().map(|event| event.seq);
        }
    }

    fn from_events(events: Vec<AgentSessionEvent>) -> Result<Self, String> {
        let first = events
            .first()
            .ok_or_else(|| "Agent session log is empty".to_string())?;
        let AgentSessionEventPayload::SessionCreated {
            task_id,
            goal,
            parent_session_id,
            continued_from_session_id,
            target,
            permission_mode,
            execution_surface,
            success_criteria,
            capability_scope,
            subagent,
        } = &first.payload
        else {
            return Err("Agent session log does not start with session/created".into());
        };
        let header = AgentSessionHeader {
            model_selection: None,
            session_id: first.session_id.clone(),
            task_id: task_id.clone(),
            goal: goal.clone(),
            title: None,
            parent_session_id: parent_session_id.clone(),
            continued_from_session_id: continued_from_session_id.clone(),
            target: target.clone(),
            permission_mode: *permission_mode,
            execution_surface: *execution_surface,
            success_criteria: success_criteria.clone(),
            capability_scope: capability_scope.clone(),
            subagent: subagent.clone(),
            created_at_unix_ms: first.time_unix_ms,
        };
        let mut record = Self {
            header,
            status: AgentSessionStatus::Idle,
            ended: false,
            storage_fault_at_seq: None,
            archived: false,
            events: Vec::with_capacity(events.len()),
            inbox: AgentInbox::default(),
            driver_metrics: super::driver_metrics::DriverMetrics::default(),
            loop_progress: super::driver_progress::LoopProgress::default(),
            snapshot_cache: Arc::new(OnceLock::new()),
        };
        for event in events {
            validate_event_envelope(&record, &event)?;
            validate_event_transition(&record, &event)?;
            validate_event_payload(&event)?;
            if sanitize_event(event.clone())? != event {
                return Err("Agent session log contains data that was not redacted".into());
            }
            apply_event(&mut record, &event)?;
            record.events.push(event);
        }
        // Rebuild the Inbox from the committed log as the authoritative
        // restart path, rather than relying on the incremental candidate.
        record.inbox = AgentInbox::replay(&record.events)?;
        derive_surface(&record.events)?;
        validate_record_final(&record)?;
        Ok(record)
    }

    fn snapshot(&self) -> Result<AgentSessionSnapshot, String> {
        if let Some(snapshot) = self.snapshot_cache.get() {
            return Ok(snapshot.clone());
        }
        let snapshot = AgentSessionSnapshot {
            header: self.header.clone(),
            status: self.status,
            ended: self.ended,
            archived: self.archived,
            event_count: self.events.len() as u64,
            surface: derive_surface(&self.events)?,
            inbox: AgentInboxProjection {
                paused_ids: self.inbox.paused_ids(),
                next_turn: self.inbox.next_turn(),
                next_step: self.inbox.next_step(),
            },
            task: derive_task(&self.events),
            recovery: super::derive_recovery_checkpoint(&self.events),
            uncertain_native_effects: has_uncertain_tool_executions(&self.events),
            child_failure_recovery: None,
            child_continuation: self.header.subagent.as_ref().map(|child| {
                super::subagent::child_continuation(
                    &child.budget,
                    &self.events,
                    child.budget.max_turns as usize,
                    self.events
                        .last()
                        .map_or(self.header.created_at_unix_ms, |event| event.time_unix_ms),
                )
            }),
        };
        let mut snapshot = snapshot;
        snapshot.child_failure_recovery = super::child_recovery::child_failure_recovery(
            &self.header,
            self.status,
            self.archived,
            &self.events,
            &snapshot.inbox,
        );
        let _ = self.snapshot_cache.set(snapshot.clone());
        Ok(snapshot)
    }

    fn list_item(&self) -> AgentSessionListItem {
        AgentSessionListItem {
            header: self.header.clone(),
            status: self.status,
            ended: self.ended,
            archived: self.archived,
            event_count: self.events.len() as u64,
            pending_turns: self.inbox.next_turn().len(),
            pending_step_messages: self.inbox.next_step().len(),
        }
    }
}

pub(super) fn has_uncertain_tool_executions(events: &[AgentSessionEvent]) -> bool {
    let mut dispatched = HashSet::new();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::ToolExecution { call_id, .. } => {
                dispatched.insert((event.step_id.as_deref(), call_id.as_str()));
            }
            AgentSessionEventPayload::ToolResult {
                call_id, status, ..
            } if *status != super::AgentToolResultStatus::Uncertain => {
                dispatched.remove(&(event.step_id.as_deref(), call_id.as_str()));
            }
            _ => {}
        }
    }
    !dispatched.is_empty()
}

/// Validate a complete decoded log through the same replay path used by the
/// production Session store, without publishing, repairing, or executing it.
#[cfg(test)]
pub(crate) fn validate_session_events(events: Vec<AgentSessionEvent>) -> Result<(), String> {
    AgentSessionRecord::from_events(events).map(|_| ())
}

#[derive(Default)]
struct AgentSessionStoreInner {
    root: Option<PathBuf>,
    archive_root: Option<PathBuf>,
    // Covers active and archived logs. Unknown after an unsuccessful disk
    // mutation; the next writer reconciles against the private directories.
    log_bytes: Option<u64>,
    sessions: HashMap<String, AgentSessionRecord>,
    recovery_notices: Vec<AgentSessionRecoveryNotice>,
    publisher: Option<EventPublisher>,
    petdex: super::petdex::PetdexActivities,
    #[cfg(test)]
    append_failure: Option<fn(&AgentSessionEventPayload) -> bool>,
}

impl AgentSessionStoreInner {
    fn log_bytes(&mut self) -> Result<u64, String> {
        if let Some(bytes) = self.log_bytes {
            return Ok(bytes);
        }
        let bytes = total_log_bytes(self.root.as_ref().expect("configured store has a root"))?
            .saturating_add(total_log_bytes(
                self.archive_root
                    .as_ref()
                    .expect("configured store has an archive root"),
            )?);
        self.log_bytes = Some(bytes);
        Ok(bytes)
    }
}

#[derive(Clone)]
pub(crate) struct AgentSessionStore {
    inner: Arc<Mutex<AgentSessionStoreInner>>,
    artifacts: super::AgentArtifactStore,
}

impl Default for AgentSessionStore {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AgentSessionStoreInner::default())),
            artifacts: super::AgentArtifactStore::default(),
        }
    }
}

impl AgentSessionStore {
    pub(crate) fn begin_petdex_driver(&self, session_id: &str) -> u64 {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.petdex.begin_driver(session_id)
    }

    pub(crate) fn settle_petdex_driver(
        &self,
        session_id: &str,
        generation: u64,
        settlement: super::AgentDriverSettlement,
    ) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .petdex
            .settle_driver(session_id, generation, settlement);
    }

    pub(crate) fn attach_petdex(
        &self,
        adapter: crate::petdex::PetdexAdapter,
    ) -> Result<(), String> {
        let mut inner = self.lock_configured()?;
        if !inner.petdex.attach(adapter) {
            return Ok(());
        }
        let AgentSessionStoreInner {
            sessions, petdex, ..
        } = &mut *inner;
        for (id, record) in sessions.iter().filter(|(_, r)| !r.ended && !r.archived) {
            petdex.observe(id, &record.events, &[], record.status, true);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn fail_appends_matching(&self, predicate: fn(&AgentSessionEventPayload) -> bool) {
        self.inner.lock().unwrap().append_failure = Some(predicate);
    }

    pub(crate) fn configure(&self, app_data_root: PathBuf) -> Result<(), String> {
        self.artifacts.configure(&app_data_root)?;
        let runtime_root = app_data_root.join("agent-runtime");
        // Each conversation event carries its own format version.
        let root = runtime_root.join("sessions");
        let archive_root = runtime_root.join("archives");
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Agent session store is unavailable".to_string())?;
        match inner.root.as_ref() {
            Some(existing) if existing == &root => return Ok(()),
            Some(_) => return Err("Agent session root changed after initialization".into()),
            None => {}
        }
        prepare_private_directory(&runtime_root)?;
        prepare_private_directory(&root)?;
        prepare_private_directory(&archive_root)?;
        let mut loaded = load_sessions(&root)?;
        let mut archived = load_sessions(&archive_root)?;
        let log_bytes = total_log_bytes(&root)?.saturating_add(total_log_bytes(&archive_root)?);
        if loaded
            .sessions
            .len()
            .saturating_add(archived.sessions.len())
            > MAX_SESSION_COUNT
            || log_bytes > MAX_TOTAL_SESSION_LOG_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }
        for record in archived.sessions.values_mut() {
            record.archived = true;
            record.snapshot_cache = Arc::new(OnceLock::new());
        }
        for (session_id, record) in archived.sessions {
            if loaded.sessions.insert(session_id, record).is_some() {
                return Err("Agent session exists in both active and archived storage".into());
            }
        }
        loaded
            .recovery_notices
            .append(&mut archived.recovery_notices);
        inner.sessions = loaded.sessions;
        inner.recovery_notices = loaded.recovery_notices;
        inner.root = Some(root);
        inner.archive_root = Some(archive_root);
        inner.log_bytes = Some(log_bytes);
        Ok(())
    }

    pub(crate) fn set_publisher(&self, publisher: EventPublisher) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "Agent session store is unavailable".to_string())?
            .publisher = Some(publisher);
        Ok(())
    }

    pub(crate) fn pause_restored_inputs(&self) -> Result<(), String> {
        // Finish already committed claim intents before pausing unclaimed work.
        // Otherwise a torn claim batch would try to claim a now-paused item.
        let ids = self
            .lock_configured()?
            .sessions
            .iter()
            .filter(|(_, record)| !record.ended && !record.archived)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.repair_step_claims(&id)?;
        }
        let mut inner = self.lock_configured()?;
        let pending = inner
            .sessions
            .iter()
            .filter(|(_, record)| !record.ended && !record.archived)
            .filter_map(|(id, record)| {
                let paused = record.inbox.paused_ids();
                let item_ids: Vec<_> = record
                    .inbox
                    .next_turn()
                    .iter()
                    .chain(&record.inbox.next_step())
                    .filter(|message| !paused.contains(&message.message_id))
                    .map(|message| message.message_id.clone())
                    .collect();
                (!item_ids.is_empty()).then(|| (id.clone(), item_ids))
            })
            .collect::<Vec<_>>();
        for (id, item_ids) in pending {
            append_payloads_locked(
                &mut inner,
                &id,
                vec![(
                    None,
                    None,
                    AgentSessionEventPayload::InboxPaused { item_ids },
                )],
            )?;
        }
        Ok(())
    }

    pub(crate) fn create(
        &self,
        request: CreateAgentSessionRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        self.create_with_target_switch(request, false)
    }

    pub(crate) fn reconnect_terminal(
        &self,
        session_id: &str,
        previous_session_id: &str,
        target: AgentSessionTarget,
    ) -> Result<AgentSessionSnapshot, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        if record.header.target.as_ref() == Some(&target) {
            return record.snapshot();
        }
        let mut descendants = vec![session_id.to_owned()];
        let mut visited = HashSet::new();
        while let Some(parent) = descendants.pop() {
            if !visited.insert(parent.clone()) {
                continue;
            }
            for child in inner
                .sessions
                .values()
                .filter(|child| child.header.parent_session_id.as_deref() == Some(&parent))
            {
                if !target_switch_settled(child)? {
                    return Err("terminal reconnect requires settled child Sessions".into());
                }
                descendants.push(child.header.session_id.clone());
            }
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::SessionTerminalReconnected {
                    previous_session_id: previous_session_id.into(),
                    target,
                },
            )],
        )?;
        let snapshot = inner.sessions[session_id].snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn continue_on_target(
        &self,
        request: CreateAgentSessionRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        if request.continued_from_session_id.is_none()
            || request.execution_surface != super::AgentExecutionSurface::BoundTerminal
        {
            return Err("target switch requires a source Session and visible execution".into());
        }
        self.create_with_target_switch(request, true)
    }

    fn create_with_target_switch(
        &self,
        request: CreateAgentSessionRequest,
        allow_target_switch: bool,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_create_request(&request)?;

        let mut inner = self.lock_configured()?;
        if let Some(record) = inner.sessions.get(&request.session_id) {
            let proposed = create_session_events(&request, record.header.created_at_unix_ms)?;
            if proposed.first().map(|event| &event.payload)
                == record.events.first().map(|event| &event.payload)
            {
                return record.snapshot();
            }
            return Err("Agent session already exists with a different payload".into());
        }
        if let Some(source_id) = request.continued_from_session_id.as_deref() {
            let source = inner
                .sessions
                .get(source_id)
                .ok_or_else(|| "continuation source Session was not found".to_string())?;
            if allow_target_switch {
                if source.header.execution_surface != super::AgentExecutionSurface::BoundTerminal
                    || !target_switch_settled(source)?
                {
                    return Err("target switch requires a settled source Session".into());
                }
                let mut descendants = vec![source_id];
                let mut visited = HashSet::new();
                while let Some(parent_id) = descendants.pop() {
                    if !visited.insert(parent_id) {
                        continue;
                    }
                    for child in inner.sessions.values().filter(|child| {
                        child.header.parent_session_id.as_deref() == Some(parent_id)
                    }) {
                        if !target_switch_settled(child)? {
                            return Err("target switch requires settled child Sessions".into());
                        }
                        descendants.push(child.header.session_id.as_str());
                    }
                }
            }
            if source.header.subagent.is_some()
                || !source
                    .header
                    .target
                    .as_ref()
                    .zip(request.target.as_ref())
                    .is_some_and(|(old, current)| {
                        (same_terminal_login(old, current) || allow_target_switch)
                            && old.session_id != current.session_id
                            && old.target_id != current.target_id
                    })
            {
                return Err(
                    "continuation requires a different terminal with the same login".into(),
                );
            }
        }
        if inner.sessions.len() >= MAX_SESSION_COUNT {
            return Err("Agent session store reached its Session limit".into());
        }
        let root = inner.root.clone().expect("configured store has a root");
        let latest_created = inner
            .sessions
            .values()
            .map(|record| record.header.created_at_unix_ms)
            .max()
            .unwrap_or(0);
        let now = current_unix_ms()
            .max(latest_created.saturating_add(1))
            .max(1);
        if now > MAX_JS_SAFE_INTEGER {
            return Err("Agent Session timestamp exceeds the wire boundary".into());
        }
        let events = create_session_events(&request, now)?;
        let record = AgentSessionRecord::from_events(events.clone())?;
        let encoded_len = encoded_events(&events)?.len() as u64;
        let log_bytes = inner.log_bytes()?;
        if log_bytes.saturating_add(encoded_len)
            > MAX_TOTAL_SESSION_LOG_BYTES - TOTAL_SETTLEMENT_RESERVE_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }
        inner.log_bytes = None;
        write_new_log(&root, &request.session_id, &events)?;
        inner.log_bytes = Some(log_bytes.saturating_add(encoded_len));
        let snapshot = record.snapshot()?;
        inner.sessions.insert(request.session_id, record);
        let publisher = inner.publisher.clone();
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn create_child_with_descriptor(
        &self,
        parent_session_id: &str,
        request: CreateAgentSessionRequest,
        descriptor: AgentSessionEventPayload,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_create_request(&request)?;
        if request.parent_session_id.as_deref() != Some(parent_session_id) {
            return Err("child Session parent identity does not match its descriptor owner".into());
        }
        let AgentSessionEventPayload::SubagentDescriptor {
            child_session_id,
            parent_session_id: descriptor_parent,
            parent_task_id,
            target_scope,
            ..
        } = &descriptor
        else {
            return Err("child Session transaction requires subagent/descriptor".into());
        };
        if child_session_id != &request.session_id || descriptor_parent != parent_session_id {
            return Err("subagent descriptor identity does not match the child Session".into());
        }

        let mut inner = self.lock_configured()?;
        let parent = inner
            .sessions
            .get(parent_session_id)
            .ok_or_else(|| "parent Agent Session was not found".to_string())?;
        if parent.ended || parent.status.is_terminal() {
            return Err("terminal parent Agent Session cannot create a child".into());
        }
        if parent.header.task_id != *parent_task_id {
            return Err("subagent descriptor parentTaskId drifted".into());
        }
        if !request
            .subagent
            .as_ref()
            .is_some_and(|metadata| metadata.target_scope == *target_scope)
            || target_scope
                .iter()
                .any(|target| parent.header.delegated_target(&target.target_id) != Some(target))
        {
            return Err("subagent target scope drifted from the parent Session".into());
        }
        if inner.sessions.contains_key(&request.session_id) {
            return Err("Agent session already exists".into());
        }
        if inner.sessions.len() >= MAX_SESSION_COUNT {
            return Err("Agent session store reached its Session limit".into());
        }
        let root = inner.root.clone().expect("configured store has a root");
        let latest_created = inner
            .sessions
            .values()
            .map(|record| record.header.created_at_unix_ms)
            .max()
            .unwrap_or(0);
        let now = current_unix_ms()
            .max(latest_created.saturating_add(1))
            .max(1);
        let child_events = create_session_events(&request, now)?;
        let child_record = AgentSessionRecord::from_events(child_events.clone())?;
        let encoded_len = encoded_events(&child_events)?.len() as u64;
        let log_bytes = inner.log_bytes()?;
        if log_bytes.saturating_add(encoded_len)
            > MAX_TOTAL_SESSION_LOG_BYTES - TOTAL_SETTLEMENT_RESERVE_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }

        inner.log_bytes = None;
        write_new_log(&root, &request.session_id, &child_events)?;
        inner.log_bytes = Some(log_bytes.saturating_add(encoded_len));
        let parent_append = append_payloads_locked(
            &mut inner,
            parent_session_id,
            vec![(None, None, descriptor)],
        );
        let (parent_events, parent_publisher) = match parent_append {
            Ok(committed) => committed,
            Err(error) => {
                let path = session_path(&root, &request.session_id);
                inner.log_bytes = None;
                let rollback = fs::remove_file(&path)
                    .map_err(|rollback_error| rollback_error.to_string())
                    .and_then(|()| sync_parent(&path));
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "child Session descriptor commit failed ({error}); rollback also failed ({rollback_error})"
                    )),
                };
            }
        };
        let snapshot = child_record.snapshot()?;
        inner
            .sessions
            .insert(request.session_id.clone(), child_record);
        let child_publisher = inner.publisher.clone();
        drop(inner);
        publish_events(child_publisher, &child_events);
        publish_events(parent_publisher, &parent_events);
        Ok(snapshot)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn commit_subagent_settlement(
        &self,
        parent_session_id: &str,
        descriptor_id: &str,
        settlement_id: &str,
        child_session_id: &str,
        status: AgentSessionStatus,
        summary: String,
        evidence_refs: Vec<String>,
        parent_closing: bool,
        tool_result: Option<AgentSubagentToolSettlement>,
    ) -> Result<(AgentSessionSnapshot, String), String> {
        validate_identifier(descriptor_id, "descriptorId")?;
        validate_identifier(settlement_id, "settlementId")?;
        validate_identifier(child_session_id, "childSessionId")?;
        validate_text(&summary, "subagent summary", false, MAX_AGENT_MESSAGE_BYTES)?;
        let mut inner = self.lock_configured()?;
        let parent = inner
            .sessions
            .get(parent_session_id)
            .ok_or_else(|| "parent Agent Session was not found".to_string())?;
        if parent.events.iter().any(|event| {
            matches!(
                &event.payload,
                AgentSessionEventPayload::SubagentSettled {
                    settlement_id: existing,
                    ..
                } if existing == settlement_id
            )
        }) {
            return Ok((parent.snapshot()?, "duplicate".into()));
        }
        let owns_child = parent.events.iter().any(|event| {
            matches!(
                &event.payload,
                AgentSessionEventPayload::SubagentDescriptor {
                    descriptor_id: existing_descriptor,
                    child_session_id: existing_child,
                    ..
                } if existing_descriptor == descriptor_id && existing_child == child_session_id
            )
        });
        if !owns_child {
            return Err("parent Session does not own the child descriptor".into());
        }
        if parent.ended || parent.status.is_terminal() {
            return Err("ended parent Session cannot accept child settlement".into());
        }
        let route = if tool_result.is_some() {
            "toolResult"
        } else if parent_closing {
            "inject"
        } else if matches!(
            parent.status,
            AgentSessionStatus::Running | AgentSessionStatus::Waiting
        ) {
            "steer"
        } else {
            "followup"
        };
        let mut payloads = vec![
            (
                None,
                None,
                AgentSessionEventPayload::SubagentSettled {
                    descriptor_id: descriptor_id.to_string(),
                    settlement_id: settlement_id.to_string(),
                    child_session_id: child_session_id.to_string(),
                    status,
                    summary: summary.clone(),
                    evidence_refs: evidence_refs.clone(),
                },
            ),
            (
                None,
                None,
                AgentSessionEventPayload::SubagentMessage {
                    descriptor_id: descriptor_id.to_string(),
                    child_session_id: child_session_id.to_string(),
                    direction: "inbound".into(),
                    route: route.into(),
                    summary: summary.clone(),
                },
            ),
        ];
        if let Some(tool_result) = tool_result {
            payloads.push((
                Some(tool_result.turn_id),
                Some(tool_result.step_id),
                AgentSessionEventPayload::ToolResult {
                    call_id: tool_result.call_id,
                    name: tool_result.name,
                    status: tool_result.status,
                    summary,
                    data: tool_result.data,
                    duration_ms: None,
                    evidence_refs,
                },
            ));
        } else {
            let lane = if route == "followup" {
                AgentInboxLane::NextTurn
            } else {
                AgentInboxLane::NextStep
            };
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Enqueued,
                    lane,
                    messages: vec![AgentInboxMessage {
                        images: Vec::new(),
                        message_id: format!("subagent-{settlement_id}"),
                        client_submission_id: None,
                        content: summary,
                        source: AgentMessageSource::session_reference(child_session_id.to_string()),
                        terminal_context: None,
                    }],
                },
            ));
        }
        let (events, publisher) = append_payloads_locked(&mut inner, parent_session_id, payloads)?;
        let snapshot = inner
            .sessions
            .get(parent_session_id)
            .expect("settlement parent remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok((snapshot, route.into()))
    }

    pub(crate) fn safe_inheritance_boundary(
        &self,
        parent_session_id: &str,
    ) -> Result<Option<u64>, String> {
        let inner = self.lock_configured()?;
        let parent = inner
            .sessions
            .get(parent_session_id)
            .ok_or_else(|| "parent Agent Session was not found".to_string())?;
        let completed_turns = parent
            .events
            .iter()
            .filter_map(|event| {
                matches!(event.payload, AgentSessionEventPayload::TurnEnd { .. })
                    .then_some(event.seq)
            })
            .collect::<Vec<_>>();
        Ok(completed_turns
            .len()
            .checked_sub(2)
            .map(|index| completed_turns[index]))
    }

    pub(crate) fn inherited_surface(
        &self,
        child_session_id: &str,
    ) -> Result<Option<AgentSurfaceSnapshot>, String> {
        let inner = self.lock_configured()?;
        let child = inner
            .sessions
            .get(child_session_id)
            .ok_or_else(|| "child Agent Session was not found".to_string())?;
        if let Some(source_id) = child.header.continued_from_session_id.as_deref() {
            return Ok(Some(historical_continuation_surface(
                &inner.sessions,
                source_id,
            )?));
        }
        let Some(subagent) = &child.header.subagent else {
            return Ok(None);
        };
        let super::AgentSubagentInheritance::SafePrefix {
            parent_through_seq: Some(boundary),
        } = subagent.inheritance
        else {
            return Ok(None);
        };
        let parent_session_id = child
            .header
            .parent_session_id
            .as_deref()
            .ok_or_else(|| "subagent Session lost parentSessionId".to_string())?;
        let parent = inner
            .sessions
            .get(parent_session_id)
            .ok_or_else(|| "subagent parent Session was not found".to_string())?;
        let prefix_end = parent
            .events
            .iter()
            .position(|event| event.seq == boundary)
            .ok_or_else(|| "subagent inheritance boundary was not found".to_string())?
            .saturating_add(1);
        let parent_session_id = parent.header.session_id.clone();
        let (mut surface, resolutions) = plan_model_surface(&parent.events[..prefix_end])?;
        drop(inner);
        resolve_surface_replays(
            &parent_session_id,
            &self.artifacts,
            &mut surface,
            resolutions,
        )?;
        Ok(Some(surface))
    }

    pub(crate) fn child_session_ids(&self, parent_session_id: &str) -> Result<Vec<String>, String> {
        let inner = self.lock_configured()?;
        if !inner.sessions.contains_key(parent_session_id) {
            return Err("parent Agent Session was not found".into());
        }
        let mut children = inner
            .sessions
            .values()
            .filter(|record| record.header.parent_session_id.as_deref() == Some(parent_session_id))
            .map(|record| record.header.session_id.clone())
            .collect::<Vec<_>>();
        children.sort();
        Ok(children)
    }

    pub(crate) fn append(
        &self,
        session_id: &str,
        turn_id: Option<String>,
        step_id: Option<String>,
        payload: AgentSessionEventPayload,
    ) -> Result<AgentSessionEvent, String> {
        let mut inner = self.lock_configured()?;
        let (events, publisher) =
            append_payloads_locked(&mut inner, session_id, vec![(turn_id, step_id, payload)])?;
        let event = events[0].clone();
        drop(inner);
        publish_events(publisher, &events);
        Ok(event)
    }

    pub(crate) fn append_batch(
        &self,
        session_id: &str,
        payloads: Vec<AgentScopedPayload>,
    ) -> Result<Vec<AgentSessionEvent>, String> {
        Ok(self.append_batch_deferred(session_id, payloads)?())
    }

    // Some native transitions must keep input admission locked through the
    // durable write, then release it before invoking event subscribers.
    pub(super) fn append_batch_deferred(
        &self,
        session_id: &str,
        payloads: Vec<AgentScopedPayload>,
    ) -> Result<impl FnOnce() -> Vec<AgentSessionEvent> + use<>, String> {
        let mut inner = self.lock_configured()?;
        let payloads = payloads
            .into_iter()
            .map(|event| (event.turn_id, event.step_id, event.payload))
            .collect();
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        Ok(move || {
            publish_events(publisher, &events);
            events
        })
    }

    pub(crate) fn execution_observation_only(&self, session_id: &str) -> Result<bool, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        execution_observation_only_locked(&inner, record)
    }

    pub(crate) fn claimed_step(
        &self,
        session_id: &str,
        step_id: &str,
    ) -> Result<AgentClaimedStep, String> {
        let messages = self
            .all_events(session_id)?
            .into_iter()
            .find_map(|e| {
                if e.step_id.as_deref() != Some(step_id) {
                    return None;
                }
                match e.payload {
                    AgentSessionEventPayload::StepInputClaim {
                        turn_messages,
                        step_messages,
                        ..
                    } => Some(turn_messages.into_iter().chain(step_messages).collect()),
                    _ => None,
                }
            })
            .unwrap_or_default();
        Ok(AgentClaimedStep { messages })
    }

    pub(crate) fn repair_step_claims(&self, session_id: &str) -> Result<(), String> {
        let mut inner = self.lock_configured()?;
        let record = inner.sessions.get(session_id).ok_or("Session not found")?;
        if record.ended {
            return Ok(());
        }
        let mut payloads = Vec::new();
        for intent in &record.events {
            let AgentSessionEventPayload::StepInputClaim {
                start_turn,
                turn_messages,
                step_messages,
            } = &intent.payload
            else {
                continue;
            };
            for (lane, messages) in [
                (AgentInboxLane::NextTurn, turn_messages),
                (AgentInboxLane::NextStep, step_messages),
            ] {
                let missing: Vec<_> = messages
                    .iter()
                    .filter(|m| record.inbox.locate(&m.message_id).is_some())
                    .cloned()
                    .collect();
                if !missing.is_empty() {
                    payloads.push((
                        None,
                        None,
                        AgentSessionEventPayload::InboxSpliced {
                            operation: AgentInboxOperation::Claimed,
                            lane,
                            messages: missing,
                        },
                    ));
                }
            }
            if *start_turn
                && !record.events.iter().any(|e| {
                    e.turn_id == intent.turn_id
                        && matches!(e.payload, AgentSessionEventPayload::TurnStart)
                })
            {
                payloads.push((
                    intent.turn_id.clone(),
                    None,
                    AgentSessionEventPayload::TurnStart,
                ));
            }
            if !record.events.iter().any(|e| {
                e.step_id == intent.step_id
                    && matches!(e.payload, AgentSessionEventPayload::StepStart)
            }) {
                payloads.push((
                    intent.turn_id.clone(),
                    intent.step_id.clone(),
                    AgentSessionEventPayload::StepStart,
                ));
            }
            for message in turn_messages.iter().chain(step_messages) {
                if !record.events.iter().any(|e| matches!(&e.payload, AgentSessionEventPayload::UserMessage { message: m } if m.message_id == message.message_id)) {
                    payloads.push((intent.turn_id.clone(), intent.step_id.clone(), AgentSessionEventPayload::UserMessage { message: message.clone() }));
                }
            }
        }
        if payloads.is_empty() {
            return Ok(());
        }
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(())
    }

    pub(crate) fn begin_turn_step(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
    ) -> Result<Option<AgentClaimedStep>, String> {
        self.begin_turn_step_checked(session_id, turn_id, step_id, None)
    }

    pub(crate) fn begin_turn_step_checked(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
        expected_input: Option<&[AgentInboxMessage]>,
    ) -> Result<Option<AgentClaimedStep>, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.ended || record.status.is_terminal() {
            return Err("ended Agent session cannot start a Turn".into());
        }
        let turn_messages = record.inbox.turn_claim();
        let step_messages = record.inbox.step_claim();
        if expected_input.is_some_and(|expected| {
            !turn_messages
                .iter()
                .chain(&step_messages)
                .eq(expected.iter())
        }) {
            return Ok(None);
        }
        if turn_messages.is_empty() && step_messages.is_empty() {
            return Ok(None);
        }
        let mut payloads = vec![(
            Some(turn_id.clone()),
            Some(step_id.clone()),
            AgentSessionEventPayload::StepInputClaim {
                start_turn: true,
                turn_messages: turn_messages.clone(),
                step_messages: step_messages.clone(),
            },
        )];
        if !turn_messages.is_empty() {
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Claimed,
                    lane: AgentInboxLane::NextTurn,
                    messages: turn_messages.clone(),
                },
            ));
        }
        payloads.push((
            Some(turn_id.clone()),
            None,
            AgentSessionEventPayload::TurnStart,
        ));
        if !step_messages.is_empty() {
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Claimed,
                    lane: AgentInboxLane::NextStep,
                    messages: step_messages.clone(),
                },
            ));
        }
        payloads.push((
            Some(turn_id.clone()),
            Some(step_id.clone()),
            AgentSessionEventPayload::StepStart,
        ));
        let messages = turn_messages
            .into_iter()
            .chain(step_messages)
            .collect::<Vec<_>>();
        payloads.extend(messages.iter().cloned().map(|message| {
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::UserMessage { message },
            )
        }));
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(Some(AgentClaimedStep { messages }))
    }

    /// Preparation diagnostics remain in the audit log without consuming input.
    pub(crate) fn abandon_step_preparation(
        &self,
        session_id: &str,
        turn_id: &str,
        step_id: &str,
        input_message_ids: Vec<String>,
        reason: &str,
    ) -> Result<(), String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        let scoped = record
            .events
            .iter()
            .filter(|event| event.turn_id.as_deref() == Some(turn_id))
            .collect::<Vec<_>>();
        if scoped.is_empty()
            || scoped.iter().any(|event| {
                matches!(
                    event.payload,
                    AgentSessionEventPayload::TurnStart
                        | AgentSessionEventPayload::StepPreparationAbandoned { .. }
                )
            })
        {
            return Ok(());
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                Some(turn_id.into()),
                Some(step_id.into()),
                AgentSessionEventPayload::StepPreparationAbandoned {
                    reason: reason.into(),
                    input_message_ids,
                },
            )],
        )?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(())
    }

    /// Serialize the last-step boundary with inbox mutations. Once TurnEnd is
    /// durable, steer rejects this turn even before the driver publishes Idle.
    pub(crate) fn end_turn_if_no_step_input(
        &self,
        session_id: &str,
        turn_id: &str,
        reason: &str,
    ) -> Result<bool, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if !record.inbox.step_claim().is_empty() {
            return Ok(false);
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                Some(turn_id.to_string()),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: reason.into(),
                },
            )],
        )?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(true)
    }

    pub(crate) fn begin_step_or_end_turn(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
        end_reason: &str,
    ) -> Result<Option<AgentClaimedStep>, String> {
        let mut inner = self.lock_configured()?;
        let messages = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?
            .inbox
            .step_claim();
        if messages.is_empty() {
            let (events, publisher) = append_payloads_locked(
                &mut inner,
                session_id,
                vec![(
                    Some(turn_id),
                    None,
                    AgentSessionEventPayload::TurnEnd {
                        reason: end_reason.into(),
                    },
                )],
            )?;
            drop(inner);
            publish_events(publisher, &events);
            return Ok(None);
        }
        let mut payloads = vec![
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::StepInputClaim {
                    start_turn: false,
                    turn_messages: Vec::new(),
                    step_messages: messages.clone(),
                },
            ),
            (
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Claimed,
                    lane: AgentInboxLane::NextStep,
                    messages: messages.clone(),
                },
            ),
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::StepStart,
            ),
        ];
        payloads.extend(messages.iter().cloned().map(|message| {
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::UserMessage { message },
            )
        }));
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(Some(AgentClaimedStep { messages }))
    }

    pub(crate) fn begin_continuation_step(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
    ) -> Result<AgentClaimedStep, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.ended || record.status.is_terminal() {
            return Err("ended Agent session cannot continue a Turn".into());
        }
        let messages = record.inbox.step_claim();
        let mut payloads = vec![(
            Some(turn_id.clone()),
            Some(step_id.clone()),
            AgentSessionEventPayload::StepInputClaim {
                start_turn: false,
                turn_messages: Vec::new(),
                step_messages: messages.clone(),
            },
        )];
        if !messages.is_empty() {
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Claimed,
                    lane: AgentInboxLane::NextStep,
                    messages: messages.clone(),
                },
            ));
        }
        payloads.push((
            Some(turn_id.clone()),
            Some(step_id.clone()),
            AgentSessionEventPayload::StepStart,
        ));
        payloads.extend(messages.iter().cloned().map(|message| {
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::UserMessage { message },
            )
        }));
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(AgentClaimedStep { messages })
    }

    pub(crate) fn validate_model_retry(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<(), String> {
        validate_identifier(turn_id, "turnId")?;
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        validate_model_retry_record(record, turn_id)
    }

    pub(crate) fn validate_child_retry(
        &self,
        request: &super::AgentChildRetryRequest,
        max_turns: usize,
    ) -> Result<bool, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&request.child_session_id)
            .ok_or("Agent session was not found")?;
        validate_child_retry_record(record, request, max_turns)
    }

    /// Commit recovery and its input together. A repeated request is identified
    /// by the failed turn, including after a lost reply or a process restart.
    pub(crate) fn retry_child_failure(
        &self,
        request: &super::AgentChildRetryRequest,
        max_turns: usize,
    ) -> Result<AgentSessionSnapshot, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&request.child_session_id)
            .ok_or("Agent session was not found")?;
        if validate_child_retry_record(record, request, max_turns)? {
            return record.snapshot();
        }
        let id = super::child_recovery::recovery_id(&request.turn_id);
        let payloads = if find_submission(record, &id).is_some() {
            if record.inbox.paused_ids().contains(&id) {
                vec![(
                    None,
                    None,
                    AgentSessionEventPayload::InboxItemResumed {
                        item_id: id,
                        previous_revision: record.events.len() as u64,
                        client_operation_id: format!(
                            "child-retry-resume-{}",
                            Uuid::new_v4().simple()
                        ),
                    },
                )]
            } else {
                return record.snapshot();
            }
        } else {
            let mut source = AgentMessageSource::runtime("child-failure-retry".into());
            source
                .metadata
                .insert("retryTurnId".into(), request.turn_id.clone().into());
            source.metadata.insert(
                "parentSessionId".into(),
                request.parent_session_id.clone().into(),
            );
            source.metadata.insert(
                "recoveryInputHash".into(),
                crate::llm::runtime::digest(
                    &serde_json::to_vec(&request.content).map_err(|error| error.to_string())?,
                )
                .into(),
            );
            let mut content = "An explicit recovery attempt was requested for this child task. Continue only the unfinished work from the saved conversation, task plan and committed tool results. Completed operations remain completed: do not repeat them. Never assume that a timeout means an operation did not execute. Inspect current state before any uncertain side effect. The original permissions and cumulative budgets still apply.".to_string();
            if let Some(correction) = &request.content {
                content.push_str("\nRecovery instructions:\n");
                content.push_str(correction);
            }
            vec![(
                None,
                None,
                AgentSessionEventPayload::SubagentRecoveryStarted {
                    failed_turn_id: request.turn_id.clone(),
                    recovery_id: id.clone(),
                    message: AgentInboxMessage {
                        message_id: id.clone(),
                        client_submission_id: Some(id),
                        content,
                        source,
                        images: Vec::new(),
                        terminal_context: None,
                    },
                },
            )]
        };
        let (events, publisher) =
            append_payloads_locked(&mut inner, &request.child_session_id, payloads)?;
        let snapshot = inner.sessions[&request.child_session_id].snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    /// Record a human recovery action without duplicating the original user input.
    /// The per-turn submission identity is also the durable receipt for a lost IPC reply.
    pub(crate) fn retry_model_failure(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(turn_id, "turnId")?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        let operation_id = format!("model-retry-{turn_id}");
        if let Some((_, message)) = find_submission(record, &operation_id) {
            validate_model_retry_receipt(message, turn_id)?;
            if !record.inbox.paused_ids().contains(&operation_id) {
                return record.snapshot();
            }
            validate_model_retry_record(record, turn_id)?;
            validate_mutable_session(record, "model retry recovery")?;
            if record.header.subagent.is_some() || has_uncertain_tool_executions(&record.events) {
                return Err("MODEL_RETRY_UNAVAILABLE: pending recovery requires inspection".into());
            }
            let previous_revision = record.events.len() as u64;
            let (events, publisher) = append_payloads_locked(
                &mut inner,
                session_id,
                vec![(
                    None,
                    None,
                    AgentSessionEventPayload::InboxItemResumed {
                        item_id: operation_id,
                        previous_revision,
                        client_operation_id: format!(
                            "model-retry-resume-{}",
                            Uuid::new_v4().simple()
                        ),
                    },
                )],
            )?;
            let snapshot = inner.sessions[session_id].snapshot()?;
            drop(inner);
            publish_events(publisher, &events);
            return Ok(snapshot);
        }
        validate_model_retry_record(record, turn_id)?;
        let mut source = AgentMessageSource::runtime("model-failure-retry".into());
        source.metadata.insert("retryTurnId".into(), turn_id.into());
        let message = AgentInboxMessage {
            message_id: operation_id.clone(),
            client_submission_id: Some(operation_id),
            content: "The user explicitly requested a retry of the latest failed model request. Continue answering the existing user request using the conversation above. Do not treat this recovery notice as a new user question.".into(),
            source,
            images: Vec::new(),
            terminal_context: None,
        };
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Enqueued,
                    lane: AgentInboxLane::NextTurn,
                    messages: vec![message],
                },
            )],
        )?;
        let snapshot = inner.sessions[session_id].snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn enqueue(
        &self,
        session_id: &str,
        lane: AgentInboxLane,
        message: AgentInboxMessage,
    ) -> Result<AgentSessionSnapshot, String> {
        self.enqueue_submission(session_id, lane, message, false, None)
    }

    pub(crate) fn has_submission(
        &self,
        session_id: &str,
        submission_id: &str,
    ) -> Result<bool, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        Ok(find_submission(record, submission_id).is_some())
    }

    pub(crate) fn enqueue_submission(
        &self,
        session_id: &str,
        lane: AgentInboxLane,
        message: AgentInboxMessage,
        paused: bool,
        target_turn_id: Option<&str>,
    ) -> Result<AgentSessionSnapshot, String> {
        self.enqueue_submission_checked(
            session_id,
            lane,
            message,
            paused,
            target_turn_id,
            None::<fn(&AgentSessionSnapshot, &AgentInboxMessage) -> Result<(), String>>,
        )
    }

    pub(super) fn enqueue_submission_checked(
        &self,
        session_id: &str,
        lane: AgentInboxLane,
        mut message: AgentInboxMessage,
        paused: bool,
        target_turn_id: Option<&str>,
        validate: Option<
            impl FnOnce(&AgentSessionSnapshot, &AgentInboxMessage) -> Result<(), String>,
        >,
    ) -> Result<AgentSessionSnapshot, String> {
        if let Some(turn_id) = target_turn_id {
            validate_identifier(turn_id, "targetTurnId")?;
            message
                .source
                .metadata
                .insert("targetTurnId".into(), turn_id.into());
            message.source.metadata.insert(
                "submissionLane".into(),
                serde_json::to_value(lane).map_err(|error| error.to_string())?,
            );
        }
        // This receipt field is assigned only by the store, never by the caller.
        message
            .source
            .metadata
            .remove(SUBMISSION_CONTENT_FINGERPRINT);
        validate_inbox_message(&message)?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if let Some(client_submission_id) = message.client_submission_id.as_deref() {
            if let Some((previous_lane, previous)) = find_submission(record, client_submission_id) {
                // The first captured terminal snapshot belongs to the durable
                // submission. A retry may observe newer output, but must not
                // change the already committed user message or its context.
                let mut previous_source = previous.source.clone();
                let mut incoming_source = message.source.clone();
                // Admission state is assigned by the store, not part of the
                // caller's immutable payload. It survives an identical retry.
                previous_source.metadata.remove("admissionPaused");
                incoming_source.metadata.remove("admissionPaused");
                let content_fingerprint = previous_source
                    .metadata
                    .remove(SUBMISSION_CONTENT_FINGERPRINT);
                let same_content = content_fingerprint.as_ref().map_or_else(
                    || previous.content == message.content,
                    |fingerprint| {
                        fingerprint.as_str()
                            == Some(
                                crate::llm::runtime::digest(message.content.as_bytes()).as_str(),
                            )
                    },
                );
                if (previous_lane != lane && target_turn_id.is_none())
                    || previous.message_id != message.message_id
                    || !same_content
                    || previous.images != message.images
                    || previous_source != incoming_source
                {
                    return Err(
                        "client submission id was already committed with a different payload"
                            .into(),
                    );
                }
                return record.snapshot();
            }
        }
        if record.storage_fault_at_seq.is_some() {
            return Err(JOURNAL_WRITE_FAILED.into());
        }
        if let Some(validate) = validate {
            validate(&record.snapshot()?, &message)?;
        }
        if let Some(fingerprint) = inbox_content_fingerprint(&message.content) {
            message
                .source
                .metadata
                .insert(SUBMISSION_CONTENT_FINGERPRINT.into(), fingerprint.into());
        }
        let active_turn = record
            .events
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                AgentSessionEventPayload::TurnStart => Some(event.turn_id.as_deref()),
                AgentSessionEventPayload::TurnEnd { .. } => Some(None),
                _ => None,
            })
            .flatten();
        let lane = if lane == AgentInboxLane::NextStep
            && target_turn_id.is_some_and(|target| Some(target) != active_turn)
        {
            AgentInboxLane::NextTurn
        } else {
            lane
        };
        let failed_root = record.ended
            && record.status == AgentSessionStatus::Failed
            && record.header.subagent.is_none()
            && !record.archived;
        let mut payloads = Vec::new();
        if paused || failed_root {
            message
                .source
                .metadata
                .insert("admissionPaused".into(), true.into());
        }
        payloads.push((
            None,
            None,
            AgentSessionEventPayload::InboxSpliced {
                operation: AgentInboxOperation::Enqueued,
                lane,
                messages: vec![message],
            },
        ));
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        let snapshot = inner
            .sessions
            .get(session_id)
            .expect("appended Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn mutate_inbox(
        &self,
        input: AgentInboxMutationInput,
    ) -> Result<AgentSessionSnapshot, String> {
        self.mutate_inbox_with_driver(input, true)
    }

    #[cfg(test)]
    pub(crate) fn mutate_inbox_with_driver(
        &self,
        input: AgentInboxMutationInput,
        has_active_driver: bool,
    ) -> Result<AgentSessionSnapshot, String> {
        self.mutate_inbox_preparing_images(input, has_active_driver, |_, _, _, _| {
            Err("image edits require Runtime admission".into())
        })
    }

    pub(super) fn mutate_inbox_preparing_images(
        &self,
        input: AgentInboxMutationInput,
        has_active_driver: bool,
        prepare_images: impl FnOnce(
            &AgentSessionSnapshot,
            &AgentInboxMessage,
            &str,
            &super::images::InboxImageEdit,
        ) -> Result<Vec<super::images::ImageRef>, String>,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(&input.session_id, "sessionId")?;
        validate_identifier(&input.client_operation_id, "clientOperationId")?;
        if input.expected_revision > MAX_JS_SAFE_INTEGER {
            return Err("Agent inbox expected revision exceeds the wire boundary".into());
        }
        let image_edit_fingerprint = match &input.mutation {
            AgentInboxMutation::UpdateWithImages { images, .. } => Some(images.fingerprint()?),
            _ => None,
        };
        let mut inner = self.lock_configured()?;
        let (record, committed) = inbox_mutation_target(
            &inner,
            &input,
            image_edit_fingerprint.as_deref(),
            has_active_driver,
        )?;
        if committed {
            return record.snapshot();
        }
        let prepared = if let AgentInboxMutation::UpdateWithImages {
            item_id,
            content,
            images,
        } = &input.mutation
        {
            validate_identifier(item_id, "itemId")?;
            validate_text(
                content,
                "inbox content",
                !images.kept.is_empty() || !images.added.is_empty(),
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            let (_, current) = require_queued_item(record, item_id)?;
            if current.source.kind != AgentMessageSourceKind::User
                || record.header.subagent.is_some()
            {
                return Err("IMAGE_SOURCE_NOT_USER".into());
            }
            let mut originals = current.images.iter();
            if !images
                .kept
                .iter()
                .all(|kept| originals.any(|image| image == kept))
            {
                return Err("IMAGE_REFERENCE_NOT_IN_SESSION: queue attachments changed".into());
            }
            let snapshot = record.snapshot()?;
            let current = current.clone();
            // Image decoding and disk writes run off the Session lock. Recheck the
            // revision and receipt before committing the replacement atomically.
            drop(inner);
            let prepared = prepare_images(&snapshot, &current, content, images)?;
            inner = self.lock_configured()?;
            let (record, committed) = inbox_mutation_target(
                &inner,
                &input,
                image_edit_fingerprint.as_deref(),
                has_active_driver,
            )?;
            if committed {
                return record.snapshot();
            }
            Some(prepared)
        } else {
            None
        };
        let record = inner
            .sessions
            .get(&input.session_id)
            .expect("validated mutation target");
        let payload = match input.mutation {
            AgentInboxMutation::Resume { item_id } => {
                validate_identifier(&item_id, "itemId")?;
                require_queued_item(record, &item_id)?;
                if !record.inbox.paused_ids().contains(&item_id) {
                    return Err("only paused Inbox items can be resumed".into());
                }
                AgentSessionEventPayload::InboxItemResumed {
                    item_id,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                }
            }
            AgentInboxMutation::Steer { item_id } => {
                validate_identifier(&item_id, "itemId")?;
                validate_steer_target(record, &item_id)?;
                AgentSessionEventPayload::InboxItemSteered {
                    item_id,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                }
            }
            AgentInboxMutation::Update { item_id, content }
            | AgentInboxMutation::UpdateWithImages {
                item_id, content, ..
            } => {
                validate_identifier(&item_id, "itemId")?;
                let (lane, current) = require_queued_item(record, &item_id)?;
                let images = prepared.as_deref().unwrap_or(&current.images);
                validate_text(
                    &content,
                    "inbox content",
                    !images.is_empty(),
                    MAX_AGENT_MESSAGE_BYTES,
                )?;
                AgentSessionEventPayload::InboxItemUpdated {
                    item_id,
                    lane,
                    content_fingerprint: inbox_content_fingerprint(&content),
                    images: prepared,
                    image_edit_fingerprint,
                    content,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                }
            }
            AgentInboxMutation::Remove { item_id } => {
                validate_identifier(&item_id, "itemId")?;
                let (lane, _) = require_queued_item(record, &item_id)?;
                AgentSessionEventPayload::InboxItemRemoved {
                    item_id,
                    lane,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                }
            }
            AgentInboxMutation::Reorder {
                lane,
                ordered_item_ids,
            } => {
                validate_collection_allow_empty(&ordered_item_ids, "ordered inbox item ids")?;
                for item_id in &ordered_item_ids {
                    validate_identifier(item_id, "itemId")?;
                }
                let mut candidate = record.inbox.clone();
                candidate.reorder(lane, &ordered_item_ids)?;
                AgentSessionEventPayload::InboxReordered {
                    lane,
                    ordered_item_ids,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                }
            }
        };
        let (events, publisher) =
            append_payloads_locked(&mut inner, &input.session_id, vec![(None, None, payload)])?;
        let snapshot = inner
            .sessions
            .get(&input.session_id)
            .expect("mutated Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    /// Only the first committed human submission can request an automatic title.
    /// Model selection and the draft used when creating a session are unrelated.
    pub(crate) fn title_submission(
        &self,
        session_id: &str,
        submission_id: &str,
    ) -> Result<Option<String>, String> {
        let inner = self.lock_configured()?;
        let record = inner.sessions.get(session_id).ok_or("Session not found")?;
        if record.header.title.is_some()
            || record.header.parent_session_id.is_some()
            || record.archived
            || record.ended
            || record.status.is_terminal()
        {
            return Ok(None);
        }
        let first = record.events.iter().find_map(|event| match &event.payload {
            AgentSessionEventPayload::InboxSpliced {
                operation: AgentInboxOperation::Enqueued,
                messages,
                ..
            } => messages
                .iter()
                .find(|message| message.source.kind == AgentMessageSourceKind::User),
            _ => None,
        });
        Ok(first
            .filter(|message| message.client_submission_id.as_deref() == Some(submission_id))
            .map(|message| message.content.clone()))
    }

    /// Check and commit under one lock: a late title must never replace a user rename.
    pub(crate) fn set_generated_title(
        &self,
        session_id: &str,
        title: String,
    ) -> Result<(), String> {
        validate_session_title(&title)?;
        let mut inner = self.lock_configured()?;
        let record = inner.sessions.get(session_id).ok_or("Session not found")?;
        if record.header.title.is_some()
            || record.archived
            || record.ended
            || record.status.is_terminal()
        {
            return Ok(());
        }
        let previous_revision = record.events.len() as u64;
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::SessionRenamed {
                    title,
                    previous_revision,
                    client_operation_id: format!("auto-title-{}", Uuid::new_v4().simple()),
                },
            )],
        )?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(())
    }

    pub(crate) fn rename(
        &self,
        input: AgentSessionRenameInput,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(&input.session_id, "sessionId")?;
        validate_identifier(&input.client_operation_id, "clientOperationId")?;
        let title = input.title.trim().to_string();
        validate_session_title(&title)?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&input.session_id)
            .ok_or_else(|| "Agent Session rename target was not found".to_string())?;
        validate_mutable_session(record, "rename")?;
        validate_expected_revision(record, input.expected_revision)?;
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            &input.session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::SessionRenamed {
                    title,
                    previous_revision: input.expected_revision,
                    client_operation_id: input.client_operation_id,
                },
            )],
        )?;
        let snapshot = inner
            .sessions
            .get(&input.session_id)
            .expect("renamed Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn claim_turn(&self, session_id: &str) -> Result<Vec<AgentInboxMessage>, String> {
        self.claim(session_id, AgentInboxLane::NextTurn)
    }

    #[cfg(test)]
    pub(crate) fn claim_step(&self, session_id: &str) -> Result<Vec<AgentInboxMessage>, String> {
        self.claim(session_id, AgentInboxLane::NextStep)
    }

    #[cfg(test)]
    fn claim(
        &self,
        session_id: &str,
        lane: AgentInboxLane,
    ) -> Result<Vec<AgentInboxMessage>, String> {
        let mut inner = self.lock_configured()?;
        let messages = {
            let record = inner
                .sessions
                .get(session_id)
                .ok_or_else(|| "Agent session was not found".to_string())?;
            match lane {
                AgentInboxLane::NextTurn => record.inbox.turn_claim(),
                AgentInboxLane::NextStep => record.inbox.step_claim(),
            }
        };
        if messages.is_empty() {
            return Ok(messages);
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Claimed,
                    lane,
                    messages: messages.clone(),
                },
            )],
        )?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(messages)
    }

    /// Stop a turn after its worker and tools have settled. Queue entries stay
    /// durable but cannot be claimed until explicitly resumed by the user.
    pub(crate) fn interrupt(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        self.pause_input(session_id, "cancelled", "stoppedByUser", false)
    }

    pub(super) fn settle_recovered_approval(
        &self,
        input: &AgentToolDecisionInput,
        decision: AgentToolDecision,
    ) -> Result<Option<AgentToolDecisionSettlement>, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&input.session_id)
            .ok_or("Agent session was not found")?;
        validate_mutable_session(record, "resolve approval")?;
        let pending = recorded_pending_approvals(&record.events)
            .into_iter()
            .find(|pending| {
                pending.event.turn_id.as_deref() == Some(input.turn_id.as_str())
                    && pending.event.step_id.as_deref() == Some(input.step_id.as_str())
                    && pending.call.call_id == input.call_id
                    && pending.request_id == input.request_id
                    && pending.approval_id == input.approval_id
            })
            .ok_or("Approval identity or state is stale")?;
        let (approval, result, reason, settlement) =
            if current_unix_ms() >= pending.expires_at_unix_ms {
                (
                    AgentToolApprovalStatus::Expired,
                    AgentToolResultStatus::TimedOut,
                    "Native approval expired while the app was not running",
                    AgentToolDecisionSettlement::Expired,
                )
            } else if decision == AgentToolDecision::Reject {
                (
                    AgentToolApprovalStatus::Rejected,
                    AgentToolResultStatus::Rejected,
                    "Native approval was rejected",
                    AgentToolDecisionSettlement::Resolved,
                )
            } else {
                return Ok(None);
            };
        let mut payloads = Vec::new();
        pending.settle(&mut payloads, approval, result, reason);
        pending.skip_unadmitted_calls(&record.events, &mut payloads);
        let (events, publisher) =
            append_settlement_locked(&mut inner, &input.session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(Some(settlement))
    }

    pub(crate) fn pause_for_input(
        &self,
        session_id: &str,
        reason: &str,
    ) -> Result<AgentSessionSnapshot, String> {
        self.pause_input(session_id, reason, reason, true)
    }

    fn pause_input(
        &self,
        session_id: &str,
        turn_reason: &str,
        status_reason: &str,
        clear_recovery: bool,
    ) -> Result<AgentSessionSnapshot, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        validate_mutable_session(record, "interrupt")?;
        let mut payloads = Vec::new();
        if !clear_recovery {
            cancel_recorded_approvals(&record.events, &mut payloads);
        }
        let mut turn_id = None;
        let mut step_id = None;
        for event in &record.events {
            match &event.payload {
                AgentSessionEventPayload::TurnStart => turn_id.clone_from(&event.turn_id),
                AgentSessionEventPayload::StepStart => step_id.clone_from(&event.step_id),
                AgentSessionEventPayload::StepEnd { .. } => step_id = None,
                AgentSessionEventPayload::TurnEnd { .. } => {
                    turn_id = None;
                    step_id = None;
                }
                _ => {}
            }
        }
        if let Some(turn_id) = turn_id {
            if let Some(step_id) = step_id {
                payloads.push((
                    Some(turn_id.clone()),
                    Some(step_id),
                    AgentSessionEventPayload::StepEnd {
                        reason: turn_reason.into(),
                    },
                ));
            }
            payloads.push((
                Some(turn_id),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: turn_reason.into(),
                },
            ));
        }
        let item_ids = record
            .inbox
            .next_turn()
            .iter()
            .chain(&record.inbox.next_step())
            .map(|message| message.message_id.clone())
            .collect::<Vec<_>>();
        if !item_ids.is_empty() {
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::InboxPaused { item_ids },
            ));
        }
        payloads.push((
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Idle,
                reason: Some(status_reason.into()),
            },
        ));
        if clear_recovery {
            payloads.push((
                None,
                None,
                AgentSessionEventPayload::TaskState {
                    status: "idle".into(),
                    phase: Some("inputRequired".into()),
                    progress: None,
                    fleet: None,
                    recovery: Some(super::AgentRecoveryState {
                        status: super::AgentRecoveryStatus::None,
                        summary: Some(status_reason.into()),
                    }),
                },
            ));
        }
        let (events, publisher) = append_settlement_locked(&mut inner, session_id, payloads)?;
        let snapshot = inner.sessions[session_id].snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn has_ready_input(&self, session_id: &str) -> Result<bool, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        Ok(!record.inbox.turn_claim().is_empty() || !record.inbox.step_claim().is_empty())
    }

    /// A new explicit human input may continue a closed root conversation.
    /// Never rewrite the old terminal event or reopen delegated/archived work.
    pub(crate) fn resume(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        if record.archived || record.header.subagent.is_some() {
            return Err("only an unarchived root Session can be resumed".into());
        }
        if !record.ended {
            return record.snapshot();
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(None, None, AgentSessionEventPayload::SessionResumed {})],
        )?;
        let snapshot = inner.sessions[session_id].snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn cancel(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.ended {
            if record.status == AgentSessionStatus::Cancelled {
                return record.snapshot();
            }
            return Err("ended Agent session cannot be cancelled".into());
        }
        if record.status.is_terminal() {
            if record.status != AgentSessionStatus::Cancelled || !record.inbox.is_empty() {
                return Err("Agent Session is already closing with another terminal state".into());
            }
            let (events, publisher) = append_settlement_locked(
                &mut inner,
                session_id,
                vec![(
                    None,
                    None,
                    AgentSessionEventPayload::SessionEnded {
                        status: AgentSessionStatus::Cancelled,
                        reason: Some("cancelled by user".into()),
                    },
                )],
            )?;
            let snapshot = inner
                .sessions
                .get(session_id)
                .expect("cancelled Session remains registered")
                .snapshot()?;
            drop(inner);
            publish_events(publisher, &events);
            return Ok(snapshot);
        }
        let mut payloads = Vec::new();
        cancel_recorded_approvals(&record.events, &mut payloads);
        for lane in [AgentInboxLane::NextTurn, AgentInboxLane::NextStep] {
            let messages = record.inbox.discard(lane);
            if !messages.is_empty() {
                payloads.push((
                    None,
                    None,
                    AgentSessionEventPayload::InboxSpliced {
                        operation: AgentInboxOperation::Discarded,
                        lane,
                        messages,
                    },
                ));
            }
        }
        payloads.push((
            None,
            None,
            AgentSessionEventPayload::AgentStatus {
                status: AgentSessionStatus::Cancelled,
                reason: Some("cancelled by user".into()),
            },
        ));
        payloads.push((
            None,
            None,
            AgentSessionEventPayload::SessionEnded {
                status: AgentSessionStatus::Cancelled,
                reason: Some("cancelled by user".into()),
            },
        ));
        let (events, publisher) = append_settlement_locked(&mut inner, session_id, payloads)?;
        let snapshot = inner
            .sessions
            .get(session_id)
            .expect("appended Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn end(
        &self,
        session_id: &str,
        status: AgentSessionStatus,
        reason: Option<String>,
    ) -> Result<AgentSessionSnapshot, String> {
        if !matches!(
            status,
            AgentSessionStatus::Completed | AgentSessionStatus::Failed
        ) {
            return Err("Agent Session end requires completed or failed status".into());
        }
        if let Some(reason) = reason.as_deref() {
            validate_text(reason, "Session end reason", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.ended {
            if record.status == status {
                return record.snapshot();
            }
            return Err("Agent Session already ended with another status".into());
        }
        if !record.inbox.is_empty() {
            return Err("Agent Session cannot end while Inbox work is pending".into());
        }
        if record.status.is_terminal() && record.status != status {
            return Err("Agent Session is already closing with another terminal state".into());
        }
        let payloads = if record.status == status {
            vec![(
                None,
                None,
                AgentSessionEventPayload::SessionEnded { status, reason },
            )]
        } else {
            vec![
                (
                    None,
                    None,
                    AgentSessionEventPayload::AgentStatus {
                        status,
                        reason: reason.clone(),
                    },
                ),
                (
                    None,
                    None,
                    AgentSessionEventPayload::SessionEnded { status, reason },
                ),
            ]
        };
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        let snapshot = inner
            .sessions
            .get(session_id)
            .expect("ended Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn terminate(
        &self,
        session_id: &str,
        status: AgentSessionStatus,
        reason: String,
    ) -> Result<AgentSessionSnapshot, String> {
        if !status.is_terminal() {
            return Err("Agent Session termination requires a terminal status".into());
        }
        validate_text(
            &reason,
            "Session end reason",
            false,
            MAX_AGENT_MESSAGE_BYTES,
        )?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.ended {
            if record.status == status {
                return record.snapshot();
            }
            return Err("Agent Session already ended with another status".into());
        }
        let mut payloads = Vec::new();
        let retain_inputs =
            status == AgentSessionStatus::Failed && record.header.subagent.is_none();
        for lane in [AgentInboxLane::NextTurn, AgentInboxLane::NextStep] {
            let messages = record.inbox.discard(lane);
            if !messages.is_empty() {
                payloads.push((
                    None,
                    None,
                    if retain_inputs {
                        AgentSessionEventPayload::InboxPaused {
                            item_ids: messages
                                .iter()
                                .map(|message| message.message_id.clone())
                                .collect(),
                        }
                    } else {
                        AgentSessionEventPayload::InboxSpliced {
                            operation: AgentInboxOperation::Discarded,
                            lane,
                            messages,
                        }
                    },
                ));
            }
        }
        payloads.extend([
            (
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status,
                    reason: Some(reason.clone()),
                },
            ),
            (
                None,
                None,
                AgentSessionEventPayload::SessionEnded {
                    status,
                    reason: Some(reason),
                },
            ),
        ]);
        let (events, publisher) = append_settlement_locked(&mut inner, session_id, payloads)?;
        let snapshot = inner
            .sessions
            .get(session_id)
            .expect("terminated Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn all_events(&self, session_id: &str) -> Result<Vec<AgentSessionEvent>, String> {
        let inner = self.lock_configured()?;
        Ok(inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?
            .events
            .clone())
    }

    /// Storage ownership survives a verified transport reconnect. The immutable
    /// creation event supplies its target; the current header still grants all
    /// execution and approval authority.
    pub(super) fn scratch_ownership_target(
        &self,
        session_id: &str,
        current: &AgentSessionTarget,
    ) -> Result<AgentSessionTarget, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        if record.header.target.as_ref() != Some(current) {
            return Err("scratch request does not match the current frozen target".into());
        }
        let owner = match record.events.first().map(|event| &event.payload) {
            Some(AgentSessionEventPayload::SessionCreated {
                target: Some(target),
                ..
            }) => target,
            _ => return Err("scratch ownership has no immutable creation target".into()),
        };
        super::scratch::validate_transport_target(owner, current)?;
        Ok(owner.clone())
    }

    /// Synchronous read only: the callback must not call back into this store.
    pub(super) fn read_events<T>(
        &self,
        session_id: &str,
        read: impl FnOnce(&[AgentSessionEvent]) -> T,
    ) -> Result<T, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        Ok(read(&record.events))
    }

    pub(super) fn read_turn_events<T>(
        &self,
        session_id: &str,
        read: impl FnOnce(&[AgentSessionEvent]) -> T,
    ) -> Result<T, String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        Ok(read(&record.events[record.driver_metrics.turn_start..]))
    }

    pub(super) fn driver_metrics(
        &self,
        session_id: &str,
    ) -> Result<super::driver_metrics::DriverMetrics, String> {
        let inner = self.lock_configured()?;
        Ok(inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?
            .driver_metrics
            .clone())
    }

    pub(super) fn loop_progress_counts(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<(usize, usize), String> {
        let inner = self.lock_configured()?;
        Ok(inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?
            .loop_progress
            .counts(turn_id))
    }

    pub(super) fn loop_recovery_used(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<bool, String> {
        let inner = self.lock_configured()?;
        Ok(inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?
            .loop_progress
            .recovery_used(turn_id))
    }

    pub(super) fn driver_control(
        &self,
        session_id: &str,
    ) -> Result<(AgentSessionStatus, AgentInboxProjection), String> {
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or("Agent session was not found")?;
        Ok((
            record.status,
            AgentInboxProjection {
                paused_ids: record.inbox.paused_ids(),
                next_turn: record.inbox.next_turn(),
                next_step: record.inbox.next_step(),
            },
        ))
    }

    pub(crate) fn snapshot(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(session_id, "sessionId")?;
        let inner = self.lock_configured()?;
        inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?
            .snapshot()
    }

    /// An unsuccessful settlement must be observable without publishing an
    /// invented journal event. The next process recovers from the actual log.
    pub(super) fn record_storage_fault(&self, session_id: &str) {
        if let Ok(mut inner) = self.lock_configured() {
            if let Some(record) = inner.sessions.get_mut(session_id) {
                record.note_storage_fault();
            }
        }
    }

    pub(crate) fn terminal_root_sessions(&self, terminal_id: &str) -> Result<Vec<String>, String> {
        let inner = self.lock_configured()?;
        Ok(inner
            .sessions
            .values()
            .map(AgentSessionRecord::list_item)
            .filter(|item| {
                !item.ended
                    && !item.archived
                    && item.header.subagent.is_none()
                    && item
                        .header
                        .target
                        .as_ref()
                        .is_some_and(|target| target.session_id == terminal_id)
            })
            .map(|item| item.header.session_id)
            .collect())
    }

    pub(crate) fn model_surface(&self, session_id: &str) -> Result<AgentSurfaceSnapshot, String> {
        validate_identifier(session_id, "sessionId")?;
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        let (mut surface, resolutions) = plan_model_surface(&record.events)?;
        drop(inner);
        resolve_surface_replays(session_id, &self.artifacts, &mut surface, resolutions)?;
        Ok(surface)
    }

    pub(crate) fn active_replay_artifact_ids(
        &self,
        session_id: &str,
    ) -> Result<HashSet<String>, String> {
        validate_identifier(session_id, "sessionId")?;
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        Ok(derive_surface(&record.events)?
            .messages
            .into_iter()
            .filter_map(|message| match message {
                AgentSurfaceMessage::Assistant {
                    replay: Some(replay),
                    ..
                } => replay
                    .artifact_metadata()
                    .map(|metadata| metadata.artifact_id.clone()),
                _ => None,
            })
            .collect())
    }

    pub(crate) fn session_ids(&self) -> Result<Vec<String>, String> {
        let inner = self.lock_configured()?;
        let mut ids = inner.sessions.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }

    pub(super) fn referenced_image_hashes(&self) -> Result<HashSet<String>, String> {
        let inner = self.lock_configured()?;
        let mut hashes = HashSet::new();
        for event in inner.sessions.values().flat_map(|session| &session.events) {
            match &event.payload {
                AgentSessionEventPayload::InboxSpliced { messages, .. } => {
                    hashes.extend(
                        messages
                            .iter()
                            .flat_map(|message| &message.images)
                            .map(|image| image.sha256.clone()),
                    );
                }
                AgentSessionEventPayload::UserMessage { message }
                | AgentSessionEventPayload::SubagentRecoveryStarted { message, .. } => {
                    hashes.extend(message.images.iter().map(|image| image.sha256.clone()));
                }
                AgentSessionEventPayload::InboxItemUpdated {
                    images: Some(images),
                    ..
                } => {
                    hashes.extend(images.iter().map(|image| image.sha256.clone()));
                }
                AgentSessionEventPayload::StepInputClaim {
                    turn_messages,
                    step_messages,
                    ..
                } => {
                    hashes.extend(
                        turn_messages
                            .iter()
                            .chain(step_messages)
                            .flat_map(|message| &message.images)
                            .map(|image| image.sha256.clone()),
                    );
                }
                _ => {}
            }
        }
        Ok(hashes)
    }

    pub(crate) fn archive(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(session_id, "sessionId")?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if record.archived {
            return record.snapshot();
        }
        // An idle conversation remains continuable after its last answer. Close
        // it only when archive is requested, without dropping queued input.
        if !record.ended && (record.status != AgentSessionStatus::Idle || !record.inbox.is_empty())
        {
            return Err("AGENT_SESSION_ARCHIVE_BUSY".into());
        }
        let ended = record.ended;
        let mut descendants = vec![session_id];
        let mut visited = HashSet::new();
        while let Some(parent_id) = descendants.pop() {
            if !visited.insert(parent_id) {
                continue;
            }
            for child in inner
                .sessions
                .values()
                .filter(|child| child.header.parent_session_id.as_deref() == Some(parent_id))
            {
                if !child.ended {
                    return Err("AGENT_SESSION_ARCHIVE_BUSY".into());
                }
                descendants.push(&child.header.session_id);
            }
        }
        let root = inner.root.clone().expect("configured store has a root");
        let archive_root = inner
            .archive_root
            .clone()
            .expect("configured store has an archive root");
        let source = session_path(&root, session_id);
        let destination = session_path(&archive_root, session_id);
        if destination.exists() {
            return Err("Agent archive target already exists".into());
        }
        let (events, publisher) = if ended {
            (Vec::new(), inner.publisher.clone())
        } else {
            append_payloads_locked(
                &mut inner,
                session_id,
                vec![
                    (
                        None,
                        None,
                        AgentSessionEventPayload::AgentStatus {
                            status: AgentSessionStatus::Completed,
                            reason: Some("archived".into()),
                        },
                    ),
                    (
                        None,
                        None,
                        AgentSessionEventPayload::SessionEnded {
                            status: AgentSessionStatus::Completed,
                            reason: Some("archived".into()),
                        },
                    ),
                ],
            )?
        };
        let result = (|| {
            fs::rename(&source, &destination)
                .map_err(|error| format!("failed to archive Agent Session log: {error}"))?;
            sync_parent(&source)?;
            sync_parent(&destination)?;
            restrict_file(&destination)?;
            let record = inner
                .sessions
                .get_mut(session_id)
                .expect("archived Session remains registered");
            record.archived = true;
            record.snapshot_cache = Arc::new(OnceLock::new());
            record.snapshot()
        })();
        drop(inner);
        // Publish the committed close even if moving the file failed, so the UI
        // still observes the durable state and can retry archive safely.
        publish_events(publisher, &events);
        result
    }

    pub(crate) fn delete_archived(&self, session_id: &str) -> Result<(), String> {
        validate_identifier(session_id, "sessionId")?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if !record.archived {
            return Err("only an archived Agent Session can be deleted".into());
        }
        if inner.sessions.values().any(|candidate| {
            candidate.header.continued_from_session_id.as_deref() == Some(session_id)
        }) {
            return Err("Agent Session is referenced by a continued conversation".into());
        }
        let archive_root = inner
            .archive_root
            .clone()
            .expect("configured store has an archive root");
        let path = session_path(&archive_root, session_id);
        let log_bytes = inner.log_bytes()?;
        let removed_bytes = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect archived Agent Session log: {error}"))?
            .len();
        inner.log_bytes = None;
        fs::remove_file(&path)
            .map_err(|error| format!("failed to delete archived Agent Session log: {error}"))?;
        sync_parent(&path)?;
        inner.log_bytes = Some(log_bytes.saturating_sub(removed_bytes));
        inner.sessions.remove(session_id);
        Ok(())
    }

    pub(crate) fn list_page(
        &self,
        request: AgentSessionListRequest,
    ) -> Result<AgentSessionListPage, String> {
        validate_page_limit(request.limit, MAX_SESSION_PAGE_SIZE, "Session")?;
        if let Some(cursor) = request.cursor.as_deref() {
            validate_identifier(cursor, "cursor")?;
        }
        let inner = self.lock_configured()?;
        let mut sessions = inner
            .sessions
            .values()
            .map(AgentSessionRecord::list_item)
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            (left.header.created_at_unix_ms, &left.header.session_id)
                .cmp(&(right.header.created_at_unix_ms, &right.header.session_id))
        });
        let start = match request.cursor.as_deref() {
            Some(cursor) => sessions
                .iter()
                .position(|item| item.header.session_id == cursor)
                .map(|index| index + 1)
                .ok_or_else(|| "Agent Session list cursor is invalid".to_string())?,
            None => 0,
        };
        let end = start.saturating_add(request.limit).min(sessions.len());
        let page = sessions[start..end].to_vec();
        let next_cursor = (end < sessions.len())
            .then(|| page.last().map(|item| item.header.session_id.clone()))
            .flatten();
        Ok(AgentSessionListPage {
            sessions: page,
            next_cursor,
            recovery_notices: inner.recovery_notices.clone(),
        })
    }

    pub(crate) fn events_page(
        &self,
        request: AgentSessionEventsRequest,
    ) -> Result<AgentSessionEventPage, String> {
        validate_identifier(&request.session_id, "sessionId")?;
        validate_page_limit(request.limit, MAX_EVENT_PAGE_SIZE, "event")?;
        let inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&request.session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        let cursor = request.cursor.unwrap_or(0);
        if cursor > record.events.len() as u64 || cursor > MAX_JS_SAFE_INTEGER {
            return Err("Agent Session event cursor is invalid".into());
        }
        let start = cursor as usize;
        let end = start.saturating_add(request.limit).min(record.events.len());
        let mut events = record.events[start..end].to_vec();
        for event in &mut events {
            crate::llm::replay::public_event_projection(event);
        }
        Ok(AgentSessionEventPage {
            events,
            next_cursor: (end < record.events.len()).then_some(end as u64),
            storage_fault_at_seq: record.storage_fault_at_seq,
        })
    }

    pub(crate) fn committed_events_page(
        &self,
        request: AgentCommittedEventsRequest,
    ) -> Result<AgentSessionEventPage, String> {
        let cursor = request.after_seq.map(|seq| seq.saturating_add(1));
        self.events_page(AgentSessionEventsRequest {
            session_id: request.session_id,
            cursor,
            limit: request.limit,
        })
    }

    fn lock_configured(&self) -> Result<std::sync::MutexGuard<'_, AgentSessionStoreInner>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Agent session store is unavailable".to_string())?;
        if inner.root.is_none() {
            return Err("Agent session store is not configured".into());
        }
        Ok(inner)
    }
}

fn validate_create_request(request: &CreateAgentSessionRequest) -> Result<(), String> {
    validate_identifier(&request.session_id, "sessionId")?;
    validate_identifier(&request.task_id, "taskId")?;
    validate_text(&request.goal, "goal", false, MAX_AGENT_MESSAGE_BYTES)?;
    if let Some(parent_session_id) = request.parent_session_id.as_deref() {
        validate_identifier(parent_session_id, "parentSessionId")?;
        if parent_session_id == request.session_id {
            return Err("Agent Session cannot parent itself".into());
        }
    }
    if let Some(source_id) = request.continued_from_session_id.as_deref() {
        validate_identifier(source_id, "continuedFromSessionId")?;
        if source_id == request.session_id
            || request.parent_session_id.is_some()
            || request.subagent.is_some()
        {
            return Err("continuation requires a new root Session".into());
        }
    }
    if let Some(target) = &request.target {
        validate_session_target(target)?;
    }
    validate_collection_allow_empty(&request.success_criteria, "success criteria")?;
    for criterion in &request.success_criteria {
        validate_text(
            criterion,
            "success criterion",
            false,
            MAX_AGENT_MESSAGE_BYTES,
        )?;
    }
    if let Some(scope) = &request.capability_scope {
        validate_capability_scope(scope)?;
    }
    if let Some(subagent) = &request.subagent {
        validate_subagent_session(subagent, request.parent_session_id.as_deref())?;
        if request.capability_scope.as_ref() != Some(&subagent.capability_scope) {
            return Err("subagent Session capability scope drifted from its descriptor".into());
        }
        if request.target.as_ref().is_some_and(|target| {
            !subagent
                .target_scope
                .iter()
                .any(|candidate| candidate == target)
        }) {
            return Err("subagent Session target exceeds its descriptor scope".into());
        }
    } else if request.parent_session_id.is_some() {
        return Err("child Agent Session requires subagent metadata".into());
    }
    Ok(())
}

fn create_session_events(
    request: &CreateAgentSessionRequest,
    now: u64,
) -> Result<Vec<AgentSessionEvent>, String> {
    let events = vec![
        sanitize_event(AgentSessionEvent::new(
            request.session_id.clone(),
            0,
            now,
            None,
            None,
            AgentSessionEventPayload::SessionCreated {
                task_id: request.task_id.clone(),
                goal: request.goal.clone(),
                parent_session_id: request.parent_session_id.clone(),
                continued_from_session_id: request.continued_from_session_id.clone(),
                target: request.target.clone(),
                permission_mode: request.permission_mode,
                execution_surface: request.execution_surface,
                success_criteria: request.success_criteria.clone(),
                capability_scope: request.capability_scope.clone(),
                subagent: request.subagent.clone(),
            },
        ))?,
        sanitize_event(AgentSessionEvent::new(
            request.session_id.clone(),
            1,
            now,
            None,
            None,
            AgentSessionEventPayload::AgentCreated {
                agent_id: request.session_id.clone(),
                parent_agent_id: request.parent_session_id.clone(),
            },
        ))?,
    ];
    AgentSessionRecord::from_events(events.clone())?;
    encoded_events(&events)?;
    Ok(events)
}

fn execution_observation_only_locked<'a>(
    inner: &'a AgentSessionStoreInner,
    mut record: &'a AgentSessionRecord,
) -> Result<bool, String> {
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(record.header.session_id.as_str()) {
            return Err("invalid Agent recovery lineage".into());
        }
        if super::recovery::execution_writes_restricted(&record.events) {
            return Ok(true);
        }
        let Some(parent) = record.header.parent_session_id.as_ref() else {
            return Ok(false);
        };
        record = inner
            .sessions
            .get(parent)
            .ok_or("Agent recovery parent was not found")?;
    }
}

fn validate_execution_admission(
    inner: &AgentSessionStoreInner,
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
) -> Result<(), String> {
    let AgentSessionEventPayload::ToolExecution { call_id, .. } = &event.payload else {
        return Ok(());
    };
    let effect = record
        .events
        .iter()
        .rev()
        .find_map(|previous| {
            if previous.turn_id != event.turn_id || previous.step_id != event.step_id {
                return None;
            }
            match &previous.payload {
                AgentSessionEventPayload::ToolCall { call } if call.call_id == *call_id => {
                    call.effect
                }
                _ => None,
            }
        })
        .unwrap_or(super::AgentSessionEffect::Unknown);
    if !super::recovery::observation_effect_allowed(effect)
        && execution_observation_only_locked(inner, record)?
    {
        return Err(super::recovery::UNKNOWN_EXECUTION_WRITE_BLOCKED.into());
    }
    Ok(())
}

fn append_settlement_locked(
    inner: &mut AgentSessionStoreInner,
    session_id: &str,
    payloads: Vec<(Option<String>, Option<String>, AgentSessionEventPayload)>,
) -> Result<(Vec<AgentSessionEvent>, Option<EventPublisher>), String> {
    append_payloads_locked(inner, session_id, payloads).inspect_err(|error| {
        if error.starts_with(JOURNAL_WRITE_FAILED) {
            inner
                .sessions
                .get_mut(session_id)
                .expect("settling Session exists")
                .note_storage_fault();
        }
    })
}

fn append_payloads_locked(
    inner: &mut AgentSessionStoreInner,
    session_id: &str,
    payloads: Vec<(Option<String>, Option<String>, AgentSessionEventPayload)>,
) -> Result<(Vec<AgentSessionEvent>, Option<EventPublisher>), String> {
    #[cfg(test)]
    if inner
        .append_failure
        .is_some_and(|predicate| payloads.iter().any(|(_, _, payload)| predicate(payload)))
    {
        return Err("injected Session append failure".into());
    }
    if payloads.is_empty() {
        return Err("Agent Session append batch cannot be empty".into());
    }
    let root = inner.root.clone().expect("configured store has a root");
    let log_bytes = inner
        .log_bytes()
        .map_err(|error| format!("{JOURNAL_WRITE_FAILED}: {error}"))?;
    let record = inner
        .sessions
        .get(session_id)
        .ok_or_else(|| "Agent session was not found".to_string())?;
    if record.archived {
        return Err("archived Agent Session logs are read-only".into());
    }
    // Chunks do not alter the Model Surface, Inbox, or transition state. Validate
    // the new batch independently, then advance observers only after disk commit.
    // Other event types retain the transactional candidate and full validation.
    let stream_only = payloads
        .iter()
        .all(|(_, _, payload)| matches!(payload, AgentSessionEventPayload::AssistantChunk { .. }));
    let settlement = payloads.iter().all(|(_, _, payload)| match payload {
        AgentSessionEventPayload::StepEnd { .. }
        | AgentSessionEventPayload::TurnEnd { .. }
        | AgentSessionEventPayload::InboxPaused { .. }
        | AgentSessionEventPayload::InboxSpliced {
            operation: AgentInboxOperation::Discarded,
            ..
        }
        | AgentSessionEventPayload::SessionEnded { .. } => true,
        AgentSessionEventPayload::ToolApproval { status, .. } => matches!(
            status,
            AgentToolApprovalStatus::Cancelled
                | AgentToolApprovalStatus::Expired
                | AgentToolApprovalStatus::Rejected
        ),
        AgentSessionEventPayload::ToolResult { status, .. } => matches!(
            status,
            AgentToolResultStatus::Cancelled
                | AgentToolResultStatus::TimedOut
                | AgentToolResultStatus::Rejected
        ),
        AgentSessionEventPayload::AgentStatus { status, .. } => {
            status.is_terminal() || *status == AgentSessionStatus::Idle
        }
        _ => false,
    });
    let mut candidate = (!stream_only).then(|| record.clone());
    let first_seq = record.events.len() as u64;
    let mut previous_time = record.events.last().map_or(1, |event| event.time_unix_ms);
    let mut appended = Vec::with_capacity(payloads.len());
    for (turn_id, step_id, payload) in payloads {
        let seq = first_seq + appended.len() as u64;
        let validation_record = candidate.as_ref().unwrap_or(record);
        let mut raw_event = AgentSessionEvent::new(
            session_id.to_string(),
            seq,
            current_unix_ms().max(previous_time),
            turn_id,
            step_id,
            payload,
        );
        validate_event_envelope_at(validation_record, &raw_event, seq, previous_time)?;
        validate_execution_admission(inner, validation_record, &raw_event)?;
        validate_event_transition(validation_record, &raw_event)?;
        validate_event_payload(&raw_event)?;
        encoded_events(std::slice::from_ref(&raw_event))?;
        if let AgentSessionEventPayload::AssistantMessage { content, .. } = &mut raw_event.payload {
            for block in content {
                if let AgentAssistantContentBlock::Text { text }
                | AgentAssistantContentBlock::Reasoning { text, .. } = block
                {
                    *text = crate::redaction::redact_model_output_text(text);
                }
            }
        }
        // Redaction can expand an otherwise valid 4 KiB delta. Normalize the
        // durable copy before final validation without changing live tool input.
        for mut event in stream_chunks::split_sanitized_event(sanitize_event(raw_event)?) {
            let seq = first_seq + appended.len() as u64;
            event.seq = seq;
            let validation_record = candidate.as_ref().unwrap_or(record);
            validate_event_envelope_at(validation_record, &event, seq, previous_time)?;
            validate_event_transition(validation_record, &event)?;
            validate_event_payload(&event)?;
            if let Some(candidate) = &mut candidate {
                apply_event(candidate, &event)?;
                candidate.events.push(event.clone());
            }
            previous_time = event.time_unix_ms;
            appended.push(event);
        }
    }
    if let Some(candidate) = &candidate {
        derive_surface(&candidate.events)?;
        validate_record_final(candidate)?;
    }
    let encoded = encoded_events(&appended)?;
    let appended_bytes = encoded.len() as u64;
    let total_limit = if settlement {
        MAX_TOTAL_SESSION_LOG_BYTES
    } else {
        MAX_TOTAL_SESSION_LOG_BYTES - TOTAL_SETTLEMENT_RESERVE_BYTES
    };
    let session_limit = if settlement {
        MAX_SESSION_LOG_BYTES
    } else {
        MAX_SESSION_LOG_BYTES - SESSION_SETTLEMENT_RESERVE_BYTES
    };
    if log_bytes.saturating_add(appended_bytes) > total_limit {
        return Err(format!(
            "{JOURNAL_WRITE_FAILED}: Agent active and archived logs exceed the storage boundary"
        ));
    }
    inner.log_bytes = None;
    append_log_batch(&root, session_id, &encoded, session_limit)
        .map_err(|error| format!("{JOURNAL_WRITE_FAILED}: {error}"))?;
    inner.log_bytes = Some(log_bytes.saturating_add(appended_bytes));
    if let Some(mut candidate) = candidate {
        if candidate.ended
            || appended.iter().any(|event| {
                matches!(
                    event.payload,
                    AgentSessionEventPayload::AgentStatus {
                        status: AgentSessionStatus::Idle,
                        ..
                    }
                )
            })
        {
            candidate.storage_fault_at_seq = None;
        }
        inner.sessions.insert(session_id.to_string(), candidate);
    } else {
        let record = inner
            .sessions
            .get_mut(session_id)
            .expect("validated Session exists");
        for event in &appended {
            observe_event(record, event);
        }
        record.events.extend(appended.iter().cloned());
    }
    let record = &inner.sessions[session_id];
    inner
        .petdex
        .observe(session_id, &record.events, &appended, record.status, false);
    Ok((appended, inner.publisher.clone()))
}

fn target_switch_settled(record: &AgentSessionRecord) -> Result<bool, String> {
    Ok(terminal_reconnect_settled(record)? && !record.snapshot()?.uncertain_native_effects)
}

fn terminal_reconnect_settled(record: &AgentSessionRecord) -> Result<bool, String> {
    let snapshot = record.snapshot()?;
    let open_turn = record
        .events
        .iter()
        .rev()
        .find_map(|event| match event.payload {
            AgentSessionEventPayload::TurnStart => Some(true),
            AgentSessionEventPayload::TurnEnd { .. }
            | AgentSessionEventPayload::SessionEnded { .. } => Some(false),
            _ => None,
        })
        .unwrap_or(false);
    Ok(!open_turn
        && !matches!(
            snapshot.status,
            AgentSessionStatus::Running | AgentSessionStatus::Waiting
        )
        && snapshot.inbox.next_step.is_empty()
        && snapshot.inbox.next_turn.is_empty())
}

fn validate_child_retry_record(
    record: &AgentSessionRecord,
    request: &super::AgentChildRetryRequest,
    max_turns: usize,
) -> Result<bool, String> {
    validate_identifier(&request.turn_id, "turnId")?;
    if record.header.parent_session_id.as_deref() != Some(&request.parent_session_id) {
        return Err("CHILD_RETRY_UNAVAILABLE: parent does not own this child".into());
    }
    if let Some(content) = &request.content {
        validate_text(
            content,
            "recovery instructions",
            false,
            MAX_AGENT_MESSAGE_BYTES / 2,
        )?;
    }
    let id = super::child_recovery::recovery_id(&request.turn_id);
    let mut has_receipt = false;
    if let Some((_, message)) = find_submission(record, &id) {
        has_receipt = true;
        if message.source.label != "child-failure-retry"
            || message
                .source
                .metadata
                .get("retryTurnId")
                .and_then(serde_json::Value::as_str)
                != Some(request.turn_id.as_str())
        {
            return Err("CHILD_RETRY_UNAVAILABLE: recovery identity conflicts".into());
        }
        if request.content.is_some()
            && message
                .source
                .metadata
                .get("recoveryInputHash")
                .and_then(serde_json::Value::as_str)
                != Some(
                    crate::llm::runtime::digest(
                        &serde_json::to_vec(&request.content).map_err(|error| error.to_string())?,
                    )
                    .as_str(),
                )
        {
            return Err("CHILD_RETRY_UNAVAILABLE: recovery input is immutable; send further instructions after recovery".into());
        }
        if record.inbox.locate(&id).is_none() {
            return Ok(true);
        }
    }
    let snapshot = record.snapshot()?;
    let recovery = snapshot.child_failure_recovery.ok_or(
        "CHILD_RETRY_UNAVAILABLE: inspect saved progress; this child cannot safely recover",
    )?;
    if recovery.turn_id != request.turn_id {
        return Err("CHILD_RETRY_UNAVAILABLE: only the latest failed turn can recover".into());
    }
    if !recovery.retryable && request.content.is_none() && !has_receipt {
        return Err("CHILD_RETRY_UNAVAILABLE: resolve the request or configuration error and provide recovery instructions".into());
    }
    let now = current_unix_ms();
    if recovery.retry_at.is_some_and(|retry_at| now < retry_at) {
        return Err("MODEL_RETRY_COOLDOWN: wait for the provider retry window".into());
    }
    let child = record
        .header
        .subagent
        .as_ref()
        .ok_or("Session is not a subagent")?;
    if !super::subagent::child_has_remaining_budget(&child.budget, &record.events, max_turns, now) {
        return Err("subagentBudgetExhausted: cumulative child budget is exhausted; inspect saved progress and take over remaining work".into());
    }
    Ok(false)
}

fn validate_model_retry_record(record: &AgentSessionRecord, turn_id: &str) -> Result<(), String> {
    let operation_id = format!("model-retry-{turn_id}");
    validate_identifier(&operation_id, "clientSubmissionId")?;
    if let Some((_, message)) = find_submission(record, &operation_id) {
        validate_model_retry_receipt(message, turn_id)?;
        if !record
            .inbox
            .next_turn()
            .iter()
            .chain(&record.inbox.next_step())
            .any(|pending| pending.message_id == operation_id)
        {
            return Ok(());
        }
    }
    if record.archived
        || record.header.subagent.is_some()
        || !matches!(
            record.status,
            AgentSessionStatus::Failed | AgentSessionStatus::Idle
        )
        || record
            .inbox
            .next_turn()
            .iter()
            .chain(&record.inbox.next_step())
            .any(|pending| pending.message_id != operation_id)
        || has_uncertain_tool_executions(&record.events)
    {
        return Err(
            "MODEL_RETRY_UNAVAILABLE: Session must be settled without pending or uncertain work"
                .into(),
        );
    }
    let boundary = record.events.iter().rev().find(|event| {
        matches!(
            event.payload,
            AgentSessionEventPayload::TurnStart | AgentSessionEventPayload::TurnEnd { .. }
        )
    });
    if !boundary.is_some_and(|event| {
        event.turn_id.as_deref() == Some(turn_id)
            && matches!(event.payload, AgentSessionEventPayload::TurnEnd { .. })
    }) {
        return Err("MODEL_RETRY_UNAVAILABLE: only the latest failed Turn can be retried".into());
    }
    let events: Vec<_> = record
        .events
        .iter()
        .filter(|event| event.turn_id.as_deref() == Some(turn_id))
        .collect();
    if events.iter().any(|event| {
        matches!(
            event.payload,
            AgentSessionEventPayload::ToolCall { .. }
                | AgentSessionEventPayload::QuestionRequested { .. }
        )
    }) {
        return Err("MODEL_RETRY_VERIFY: inspect tool execution before continuing".into());
    }
    let failure_event = events.iter().rev().find(|event| {
        matches!(
            event.payload,
            AgentSessionEventPayload::RequestFailure { .. }
                | AgentSessionEventPayload::RequestUsage { .. }
                | AgentSessionEventPayload::AssistantMessage { .. }
        )
    });
    let Some(event) = failure_event else {
        return Err("MODEL_RETRY_UNAVAILABLE: no failed model request".into());
    };
    let AgentSessionEventPayload::RequestFailure { failure, .. } = &event.payload else {
        return Err("MODEL_RETRY_UNAVAILABLE: no failed model request".into());
    };
    let code = failure
        .code
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !failure.retryable()
        || matches!(failure.status, Some(401..=404))
        || matches!(
            code.as_str(),
            "insufficient_quota"
                | "billing_hard_limit_reached"
                | "model_not_found"
                | "content_policy_violation"
                | "context_length_exceeded"
                | "invalid_request_error"
        )
    {
        return Err(
            "MODEL_RETRY_UNAVAILABLE: resolve model configuration or request errors first".into(),
        );
    }
    if failure
        .retry_after_ms
        .is_some_and(|delay| current_unix_ms() < event.time_unix_ms.saturating_add(delay))
    {
        return Err("MODEL_RETRY_COOLDOWN: wait for the provider retry window".into());
    }
    Ok(())
}

fn validate_model_retry_receipt(message: &AgentInboxMessage, turn_id: &str) -> Result<(), String> {
    if message.source.kind != super::AgentMessageSourceKind::Runtime
        || message.source.label != "model-failure-retry"
        || message
            .source
            .metadata
            .get("retryTurnId")
            .and_then(serde_json::Value::as_str)
            != Some(turn_id)
    {
        return Err("MODEL_RETRY_UNAVAILABLE: recovery receipt identity conflicts".into());
    }
    Ok(())
}

fn find_submission<'a>(
    record: &'a AgentSessionRecord,
    client_submission_id: &str,
) -> Option<(AgentInboxLane, &'a AgentInboxMessage)> {
    record.events.iter().find_map(|event| match &event.payload {
        AgentSessionEventPayload::SubagentRecoveryStarted { message, .. }
            if message.client_submission_id.as_deref() == Some(client_submission_id) =>
        {
            Some((AgentInboxLane::NextTurn, message))
        }
        AgentSessionEventPayload::InboxSpliced {
            operation: AgentInboxOperation::Enqueued,
            lane,
            messages,
        } => messages
            .iter()
            .find(|message| message.client_submission_id.as_deref() == Some(client_submission_id))
            .map(|message| (*lane, message)),
        _ => None,
    })
}

fn inbox_mutation_target<'a>(
    inner: &'a AgentSessionStoreInner,
    input: &AgentInboxMutationInput,
    image_fingerprint: Option<&str>,
    has_active_driver: bool,
) -> Result<(&'a AgentSessionRecord, bool), String> {
    use AgentInboxMutation as Mutation;
    use AgentSessionEventPayload as Event;

    let record = inner
        .sessions
        .get(&input.session_id)
        .ok_or_else(|| "Agent inbox mutation target Session was not found".to_string())?;
    // Durable receipts take precedence over stale revisions and consumed items.
    if let Some(previous) = record.events.iter().find(|event| {
        inbox_operation_id(&event.payload) == Some(input.client_operation_id.as_str())
    }) {
        let matches = match (&previous.payload, &input.mutation) {
            (Event::InboxItemResumed { item_id, .. }, Mutation::Resume { item_id: incoming })
            | (Event::InboxItemSteered { item_id, .. }, Mutation::Steer { item_id: incoming })
            | (Event::InboxItemRemoved { item_id, .. }, Mutation::Remove { item_id: incoming }) => {
                item_id == incoming
            }
            (
                Event::InboxItemUpdated {
                    item_id,
                    content,
                    content_fingerprint,
                    image_edit_fingerprint,
                    ..
                },
                Mutation::Update {
                    item_id: incoming,
                    content: raw,
                }
                | Mutation::UpdateWithImages {
                    item_id: incoming,
                    content: raw,
                    ..
                },
            ) => {
                item_id == incoming
                    && image_edit_fingerprint.as_deref() == image_fingerprint
                    && match content_fingerprint {
                        Some(fingerprint) => {
                            *fingerprint == crate::llm::runtime::digest(raw.as_bytes())
                        }
                        None => content == raw,
                    }
            }
            (
                Event::InboxReordered {
                    lane,
                    ordered_item_ids,
                    ..
                },
                Mutation::Reorder {
                    lane: incoming_lane,
                    ordered_item_ids: incoming,
                },
            ) => lane == incoming_lane && ordered_item_ids == incoming,
            _ => false,
        };
        return if matches {
            Ok((record, true))
        } else {
            Err("client operation id was already committed with a different payload".into())
        };
    }
    validate_mutable_session(record, "inbox mutation")?;
    if matches!(input.mutation, Mutation::Steer { .. }) && !has_active_driver {
        return Err(
            "Agent inbox steer requires an active running driver; resume the Session first".into(),
        );
    }
    validate_expected_revision(record, input.expected_revision)?;
    Ok((record, false))
}

fn require_queued_item<'a>(
    record: &'a AgentSessionRecord,
    item_id: &str,
) -> Result<(AgentInboxLane, &'a AgentInboxMessage), String> {
    if let Some(item) = record.inbox.locate(item_id) {
        return Ok(item);
    }
    let existed = record.events.iter().any(|event| match &event.payload {
        AgentSessionEventPayload::InboxSpliced {
            operation: AgentInboxOperation::Enqueued,
            messages,
            ..
        } => messages.iter().any(|message| message.message_id == item_id),
        _ => false,
    });
    if existed {
        Err("Agent inbox item is no longer queued (claimed or removed)".into())
    } else {
        Err("Agent inbox item was not found".into())
    }
}

fn inbox_operation_id(payload: &AgentSessionEventPayload) -> Option<&str> {
    match payload {
        AgentSessionEventPayload::InboxItemResumed {
            client_operation_id,
            ..
        } => Some(client_operation_id),
        AgentSessionEventPayload::InboxItemSteered {
            client_operation_id,
            ..
        }
        | AgentSessionEventPayload::InboxItemUpdated {
            client_operation_id,
            ..
        }
        | AgentSessionEventPayload::InboxItemRemoved {
            client_operation_id,
            ..
        }
        | AgentSessionEventPayload::InboxReordered {
            client_operation_id,
            ..
        }
        | AgentSessionEventPayload::SessionRenamed {
            client_operation_id,
            ..
        } => Some(client_operation_id),
        _ => None,
    }
}

fn validate_mutable_session(record: &AgentSessionRecord, operation: &str) -> Result<(), String> {
    if record.archived {
        return Err(format!("archived Agent Session rejects {operation}"));
    }
    if record.ended || record.status.is_terminal() {
        return Err(format!("terminal Agent Session rejects {operation}"));
    }
    Ok(())
}

fn validate_steer_target(record: &AgentSessionRecord, item_id: &str) -> Result<(), String> {
    validate_mutable_session(record, "inbox steer")?;
    if record.status != AgentSessionStatus::Running {
        return Err("Agent inbox steer requires a running Session".into());
    }
    let last_turn_boundary = record.events.iter().rev().find(|event| {
        matches!(
            event.payload,
            AgentSessionEventPayload::TurnStart | AgentSessionEventPayload::TurnEnd { .. }
        )
    });
    if !last_turn_boundary
        .is_some_and(|event| matches!(event.payload, AgentSessionEventPayload::TurnStart))
    {
        return Err("Agent inbox steer requires an open running turn".into());
    }
    let (lane, message) = require_queued_item(record, item_id)?;
    if lane != AgentInboxLane::NextTurn {
        return Err("Agent inbox steer requires a queued nextTurn item".into());
    }
    if message.source.kind != super::AgentMessageSourceKind::User {
        return Err("Agent inbox steer requires a user message".into());
    }
    Ok(())
}

fn validate_expected_revision(
    record: &AgentSessionRecord,
    expected_revision: u64,
) -> Result<(), String> {
    let current_revision = record.events.len() as u64;
    if expected_revision != current_revision {
        return Err(format!(
            "Agent Runtime revision conflict: expected revision {expected_revision}, current revision {current_revision}"
        ));
    }
    Ok(())
}

fn validate_event_envelope(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
) -> Result<(), String> {
    validate_event_envelope_at(
        record,
        event,
        record.events.len() as u64,
        record
            .events
            .last()
            .map_or(1, |previous| previous.time_unix_ms),
    )
}

fn validate_event_envelope_at(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
    next_seq: u64,
    previous_time: u64,
) -> Result<(), String> {
    if event.version != AGENT_SESSION_EVENT_VERSION {
        return Err(format!(
            "Agent session event version {} is unsupported; expected {AGENT_SESSION_EVENT_VERSION}",
            event.version
        ));
    }
    validate_identifier(&event.session_id, "sessionId")?;
    if event.session_id != record.header.session_id {
        return Err("Agent session event belongs to another Session".into());
    }
    if event.seq != next_seq || event.seq > MAX_JS_SAFE_INTEGER {
        return Err("Agent session event sequence is not contiguous".into());
    }
    if event.time_unix_ms == 0 || event.time_unix_ms > MAX_JS_SAFE_INTEGER {
        return Err("Agent session event timestamp is invalid".into());
    }
    if event.time_unix_ms < previous_time {
        return Err("Agent session event timestamp moved backwards".into());
    }
    if let Some(turn_id) = event.turn_id.as_deref() {
        validate_identifier(turn_id, "turnId")?;
    }
    if let Some(step_id) = event.step_id.as_deref() {
        validate_identifier(step_id, "stepId")?;
        if event.turn_id.is_none() {
            return Err("Agent session stepId requires turnId".into());
        }
    }
    Ok(())
}

fn validate_event_transition(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
) -> Result<(), String> {
    if let AgentSessionEventPayload::SessionTerminalReconnected {
        previous_session_id,
        target,
    } = &event.payload
    {
        let old = record
            .header
            .target
            .as_ref()
            .ok_or("terminal reconnect requires a target")?;
        let mut expected = old.clone();
        expected.session_id = target.session_id.clone();
        expected.target_id = target.target_id.clone();
        if record.archived
            || record.header.subagent.is_some()
            || record.header.capability_scope.is_some()
            || old.session_id != *previous_session_id
            || old.session_id == target.session_id
            || old.target_id == target.target_id
            || expected != *target
            || !terminal_reconnect_settled(record)?
        {
            return Err(
                "terminal reconnect requires a settled root Session and the same target identity"
                    .into(),
            );
        }
        let recovery = record.snapshot()?.recovery;
        if recovery.kind != super::AgentRecoveryCheckpointKind::ExecutionInFlight
            && matches!(
                recovery.status,
                super::AgentRecoveryStatus::Available
                    | super::AgentRecoveryStatus::Required
                    | super::AgentRecoveryStatus::Reconciling
            )
        {
            return Err("terminal reconnect requires reconciled effects".into());
        }
        return Ok(());
    }
    if let AgentSessionEventPayload::SubagentRecoveryStarted {
        failed_turn_id,
        recovery_id,
        message,
    } = &event.payload
    {
        let snapshot = record.snapshot()?;
        return if record.ended
            && record.status == AgentSessionStatus::Failed
            && snapshot
                .child_failure_recovery
                .is_some_and(|recovery| recovery.turn_id == *failed_turn_id)
            && *recovery_id == super::child_recovery::recovery_id(failed_turn_id)
            && message.message_id == *recovery_id
            && message.client_submission_id.as_deref() == Some(recovery_id.as_str())
            && message.source.kind == super::AgentMessageSourceKind::Runtime
            && message.source.label == "child-failure-retry"
            && message.images.is_empty()
            && message.terminal_context.is_none()
            && message
                .source
                .metadata
                .get("retryTurnId")
                .and_then(serde_json::Value::as_str)
                == Some(failed_turn_id.as_str())
            && find_submission(record, recovery_id).is_none()
        {
            Ok(())
        } else {
            Err("subagent/recovery_started requires a safely settled failed child".into())
        };
    }
    if matches!(event.payload, AgentSessionEventPayload::SessionResumed {}) {
        return if record.ended && !record.archived && record.header.subagent.is_none() {
            Ok(())
        } else {
            Err("session/resumed requires an ended unarchived root Session".into())
        };
    }
    // A stopped root may append only scoped reconciliation evidence/results.
    // It stays ended; neither this audit trail nor cancellation authorizes replay.
    if record.ended
        && !record.archived
        && record.header.subagent.is_none()
        && record.header.capability_scope.is_none()
        && matches!(
            record.status,
            AgentSessionStatus::Cancelled | AgentSessionStatus::Failed
        )
    {
        if let Some(checkpoint) = super::recovery::unresolved_execution(&record.events) {
            if event.turn_id == checkpoint.turn_id && event.step_id == checkpoint.step_id {
                match &event.payload {
                    AgentSessionEventPayload::TaskEvidence { kind, .. } if kind == "recovery-reconciliation" => return Ok(()),
                    AgentSessionEventPayload::ToolResult { call_id, name, status, evidence_refs, .. }
                        if checkpoint.call_id.as_ref() == Some(call_id)
                            && checkpoint.tool_name.as_ref() == Some(name)
                            && matches!(status, super::AgentToolResultStatus::Completed | super::AgentToolResultStatus::Cancelled)
                            && !evidence_refs.is_empty()
                            && evidence_refs.iter().all(|id| record.events.iter().any(|previous| {
                                previous.turn_id == event.turn_id && previous.step_id == event.step_id
                                    && matches!(&previous.payload, AgentSessionEventPayload::TaskEvidence { evidence_id, kind, .. }
                                        if evidence_id == id && kind == "recovery-reconciliation")
                            })) => return validate_tool_result_transition(record, event, call_id, *status),
                    _ => {}
                }
            }
        }
    }
    let failed_admission = record.ended
        && record.status == AgentSessionStatus::Failed
        && !record.archived
        && record.header.subagent.is_none()
        && matches!(
            event.payload,
            AgentSessionEventPayload::InboxSpliced {
                operation: AgentInboxOperation::Enqueued,
                ..
            } | AgentSessionEventPayload::InboxPaused { .. }
        );
    if record.ended && !failed_admission {
        return Err("ended Agent session does not accept new events".into());
    }
    if record.status.is_terminal()
        && !failed_admission
        && !matches!(event.payload, AgentSessionEventPayload::SessionEnded { .. })
    {
        return Err("terminal Agent status must be followed by session/ended".into());
    }
    let context_messages: &[AgentInboxMessage] = match &event.payload {
        AgentSessionEventPayload::InboxSpliced { messages, .. } => messages,
        AgentSessionEventPayload::UserMessage { message } => std::slice::from_ref(message),
        _ => &[],
    };
    for message in context_messages {
        if let Some(context) = &message.terminal_context {
            if record
                .header
                .target
                .as_ref()
                .map(|target| target.session_id.as_str())
                != Some(context.session_id.as_str())
            {
                return Err("terminal context does not match the frozen Session target".into());
            }
        }
    }
    match &event.payload {
        AgentSessionEventPayload::InboxItemResumed { item_id, .. } => {
            if record.events.iter().any(|previous| {
                inbox_operation_id(&previous.payload) == inbox_operation_id(&event.payload)
            }) {
                return Err("Agent inbox resume operation was already committed".into());
            }
            if !record.inbox.paused_ids().contains(item_id) {
                return Err("only paused Inbox items can be resumed".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::InboxItemSteered { item_id, .. } => {
            if record.events.iter().any(|previous| {
                inbox_operation_id(&previous.payload) == inbox_operation_id(&event.payload)
            }) {
                return Err("Agent inbox steer operation was already committed".into());
            }
            validate_steer_target(record, item_id)
        }
        AgentSessionEventPayload::SessionCreated { .. } if !record.events.is_empty() => {
            Err("session/created can only be the first event".into())
        }
        AgentSessionEventPayload::SessionCreated { .. } => Ok(()),
        _ if record.events.is_empty() => {
            Err("Agent session log must begin with session/created".into())
        }
        AgentSessionEventPayload::SessionProjectRootBound { root } => {
            if record.header.subagent.is_some()
                || record.status != AgentSessionStatus::Idle
                || record.ended
                || record.archived
                || !record.inbox.is_empty()
            {
                return Err(
                    "Busy: project binding requires an idle root Session with an empty inbox"
                        .into(),
                );
            }
            let target = record
                .header
                .target
                .as_ref()
                .ok_or("Unavailable: missing target")?;
            let existing = match target.kind.as_str() {
                "local" => &target.cwd,
                "remote" => &target.root_path,
                _ => return Err("Unavailable: unsupported target".into()),
            };
            if existing
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err("Denied: project directory is already bound".into());
            }
            let absolute = if target.kind == "local" {
                std::path::Path::new(root).is_absolute()
            } else {
                root.starts_with('/')
            };
            if !absolute || root.chars().any(char::is_control) {
                return Err("InvalidRequest: project directory must be absolute".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SessionExecutionSurfaceChanged { .. } => {
            if record.header.subagent.is_some() || record.status != AgentSessionStatus::Idle {
                return Err("execution surface change requires an idle root Session".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SessionEnded { status, .. } => {
            if !status.is_terminal() {
                return Err("session/ended requires a terminal status".into());
            }
            if !record.inbox.is_empty() && !retains_paused_inputs(record, *status) {
                return Err("session/ended requires an empty Inbox".into());
            }
            if record.status.is_terminal() && record.status != *status {
                return Err("session/ended did not match the terminal Agent status".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::RequestStart {
            request_id,
            header_request_id,
            provider_id,
            model,
            reasoning_effort,
            series,
            ..
        } => {
            let header = record
                .events
                .iter()
                .rev()
                .find_map(|previous| match &previous.payload {
                    payload @ AgentSessionEventPayload::RequestHeader { .. } => Some(payload),
                    _ => None,
                });
            let Some(AgentSessionEventPayload::RequestHeader {
                request_id: snapshot_id,
                provider_id: snapshot_provider,
                model: snapshot_model,
                reasoning_effort: snapshot_effort,
                series: snapshot_series,
                ..
            }) = header
            else {
                return Err("request/start requires a recorded header snapshot".into());
            };
            if header_request_id != snapshot_id
                || provider_id != snapshot_provider
                || model != snapshot_model
                || reasoning_effort != snapshot_effort
                || series.series_id != snapshot_series.series_id
            {
                return Err(
                    "request/start must reference the current matching header snapshot".into(),
                );
            }
            let mut previous_series = None;
            for previous in record.events.iter().rev() {
                if let AgentSessionEventPayload::RequestStart {
                    request_id: previous_id,
                    series: value,
                    ..
                } = &previous.payload
                {
                    if previous_id == request_id {
                        return Err("request/start identity was already committed".into());
                    }
                    if previous_series.is_none() {
                        previous_series = Some(value);
                    }
                }
            }
            let expected_index = previous_series
                .filter(|previous| previous.series_id == series.series_id)
                .map_or(0, |previous| previous.request_index.saturating_add(1));
            if series.request_index != expected_index {
                return Err("request/start series index is not contiguous".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::AssistantMessage {
            content,
            interrupted,
            replay,
            ..
        } => {
            if *interrupted {
                if replay.is_some() {
                    return Err("interrupted assistant message cannot carry replay metadata".into());
                }
                return Ok(());
            }
            match replay {
                Some(super::AgentStoredReplay::Inline(
                    envelope @ crate::llm::replay::ReplayEnvelopeV5::Prepared { .. },
                )) => validate_assistant_replay(&record.events, event, content, envelope),
                Some(super::AgentStoredReplay::Artifact(reference)) => {
                    validate_assistant_replay_context(&record.events, event)?;
                    super::validate_replay_metadata(&reference.artifact)
                }
                None => {
                    // Interactive input/search text is intentionally absent from both
                    // the durable call and its response-wide replay envelope.
                    if content.iter().any(|block| {
                        matches!(
                            block,
                            AgentAssistantContentBlock::ToolCall { call }
                                if super::model::recorded_tool_call_omits_replay(call)
                        )
                    }) {
                        Ok(())
                    } else {
                        Err("REPLAY_CAPTURE_MISSING: prepared response requires a prepared replay envelope".into())
                    }
                }
            }
        }
        AgentSessionEventPayload::FileReferenceScopeBound { scope } => {
            if record.header.target.as_ref() != Some(&scope.target)
                || super::file_references::current_bound_scope(&record.events)
                    .is_some_and(|previous| previous != *scope)
            {
                return Err("File reference root identity changed".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillCatalogObserved { observation } => {
            if let Some(snapshot) = &observation.snapshot {
                if record.header.target.as_ref() != Some(&snapshot.scope.target) {
                    return Err("Skills observation changed the frozen target".into());
                }
                if super::file_references::current_bound_scope(&record.events)
                    .is_some_and(|previous| previous != snapshot.scope)
                {
                    return Err("Skills root identity changed during observation".into());
                }
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillStepPrepared { prepared } => {
            if record.events.iter().any(|e| {
                e.step_id == event.step_id
                    && matches!(
                        e.payload,
                        AgentSessionEventPayload::SkillStepPrepared { .. }
                    )
            }) {
                return Err("Skill Step already prepared".into());
            }
            let claimed: Vec<_> = record
                .events
                .iter()
                .filter(|e| e.step_id == event.step_id)
                .flat_map(|e| match &e.payload {
                    AgentSessionEventPayload::StepInputClaim {
                        turn_messages,
                        step_messages,
                        ..
                    } => turn_messages
                        .iter()
                        .chain(step_messages)
                        .filter(|m| super::skills::direct_skill_input(m))
                        .map(|m| m.message_id.clone())
                        .collect(),
                    _ => Vec::new(),
                })
                .collect();
            if claimed != prepared.message_ids {
                return Err("Skill preparation does not match durable claim".into());
            }
            for outcome in &prepared.outcomes {
                if outcome.message_ids.iter().any(|id| !claimed.contains(id)) {
                    return Err("Skill invocation has an unclaimed input".into());
                }
                if outcome.loaded.as_ref().is_some_and(|loaded| {
                    record.header.target.as_ref() != Some(&loaded.provenance.scope.target)
                }) {
                    return Err("Skill invocation changed the frozen target".into());
                }
            }
            Ok(())
        }
        AgentSessionEventPayload::RequestContext {
            surface_generation, ..
        } if *surface_generation != derive_surface(&record.events)?.generation => {
            Err("request/context referenced a stale Model Surface generation".into())
        }
        AgentSessionEventPayload::ToolCall { call } => {
            if record.events.iter().any(|previous| {
                previous.step_id == event.step_id
                    && matches!(
                        &previous.payload,
                        AgentSessionEventPayload::ToolCall { call: previous_call }
                            if previous_call.call_id == call.call_id
                    )
            }) {
                return Err("tool call identity was already committed in this Step".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::ToolApproval {
            call_id,
            approval_id,
            status,
            expires_at_unix_ms,
            ..
        } => validate_tool_approval_transition(
            record,
            event,
            call_id,
            approval_id.as_deref(),
            *status,
            *expires_at_unix_ms,
        ),
        AgentSessionEventPayload::ToolExecution { call_id, .. } => {
            validate_tool_execution_transition(record, event, call_id)
        }
        AgentSessionEventPayload::ToolResult {
            call_id, status, ..
        } => validate_tool_result_transition(record, event, call_id, *status),
        AgentSessionEventPayload::QuestionRequested { .. }
        | AgentSessionEventPayload::QuestionAnswered { .. }
        | AgentSessionEventPayload::QuestionActionAnswered { .. }
        | AgentSessionEventPayload::QuestionCancelled { .. } => {
            super::user_questions::validate_transition(&record.events, event)
        }
        _ => Ok(()),
    }
}

fn validate_assistant_replay(
    previous_events: &[AgentSessionEvent],
    event: &AgentSessionEvent,
    content: &[AgentAssistantContentBlock],
    envelope: &crate::llm::replay::ReplayEnvelopeV5,
) -> Result<(), String> {
    let (snapshot, request_id) = validate_assistant_replay_context(previous_events, event)?;
    crate::llm::replay::validate_agent_envelope(envelope, content, snapshot, request_id)
        .map_err(crate::llm::replay::replay_error_string)
}

fn validate_assistant_replay_context<'a>(
    previous_events: &'a [AgentSessionEvent],
    event: &AgentSessionEvent,
) -> Result<(&'a crate::llm::runtime::RequestSnapshot, &'a str), String> {
    let start = previous_events.iter().rev().find_map(|previous| {
        if previous.step_id != event.step_id {
            return None;
        }
        match &previous.payload {
            AgentSessionEventPayload::RequestStart {
                request_id,
                header_request_id,
                ..
            } => Some((request_id, header_request_id)),
            _ => None,
        }
    });
    let Some((request_id, header_request_id)) = start else {
        return Err("assistant message requires a committed request/start".into());
    };
    let header = previous_events
        .iter()
        .rev()
        .find_map(|previous| match &previous.payload {
            AgentSessionEventPayload::RequestHeader {
                request_id,
                snapshot,
                snapshot_digest,
                ..
            } if request_id == header_request_id => Some((snapshot, snapshot_digest.as_str())),
            _ => None,
        });
    let Some((snapshot, snapshot_digest)) = header else {
        return Err("assistant replay requires its committed request/header snapshot".into());
    };
    if snapshot.digest() != snapshot_digest {
        return Err("assistant replay request snapshot digest mismatch".into());
    }
    Ok((snapshot, request_id))
}

fn validate_tool_execution_transition(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
    call_id: &str,
) -> Result<(), String> {
    let mut approved = false;
    let mut dispatched = false;
    let mut has_result = false;
    for previous in record
        .events
        .iter()
        .filter(|previous| previous.step_id == event.step_id)
    {
        match &previous.payload {
            AgentSessionEventPayload::ToolApproval {
                call_id: previous_call,
                status: super::AgentToolApprovalStatus::Approved,
                ..
            } if previous_call == call_id => approved = true,
            AgentSessionEventPayload::ToolExecution {
                call_id: previous_call,
                ..
            } if previous_call == call_id => dispatched = true,
            AgentSessionEventPayload::ToolResult {
                call_id: previous_call,
                ..
            } if previous_call == call_id => has_result = true,
            _ => {}
        }
    }
    if !approved || dispatched || has_result {
        return Err("tool execution dispatch has no unique authorized call".into());
    }
    Ok(())
}

type ScopedSettlement = (Option<String>, Option<String>, AgentSessionEventPayload);

struct RecordedPendingApproval<'a> {
    event: &'a AgentSessionEvent,
    call: &'a RecordedToolCall,
    request_id: &'a str,
    approval_id: &'a str,
    expires_at_unix_ms: u64,
}

impl RecordedPendingApproval<'_> {
    fn scoped(&self, payload: AgentSessionEventPayload) -> ScopedSettlement {
        (
            self.event.turn_id.clone(),
            self.event.step_id.clone(),
            payload,
        )
    }

    fn settle(
        &self,
        payloads: &mut Vec<ScopedSettlement>,
        approval: AgentToolApprovalStatus,
        result: AgentToolResultStatus,
        reason: &str,
    ) {
        payloads.push(self.scoped(AgentSessionEventPayload::ToolApproval {
            request_id: self.request_id.into(),
            call_id: self.call.call_id.clone(),
            approval_id: Some(self.approval_id.into()),
            status: approval,
            risk: self.call.effect,
            reason: Some(reason.into()),
            expires_at_unix_ms: Some(self.expires_at_unix_ms),
            prompt: None,
        }));
        payloads.push(self.scoped(AgentSessionEventPayload::ToolResult {
            call_id: self.call.call_id.clone(),
            name: self.call.name.clone(),
            status: result,
            summary: reason.into(),
            data: None,
            duration_ms: None,
            evidence_refs: Vec::new(),
        }));
    }

    fn skip_unadmitted_calls(
        &self,
        events: &[AgentSessionEvent],
        payloads: &mut Vec<ScopedSettlement>,
    ) {
        let scoped = || {
            events.iter().filter(|event| {
                event.turn_id == self.event.turn_id && event.step_id == self.event.step_id
            })
        };
        let recorded: HashSet<_> = scoped()
            .filter_map(|event| match &event.payload {
                AgentSessionEventPayload::ToolCall { call } => Some(call.call_id.as_str()),
                _ => None,
            })
            .collect();
        for event in scoped() {
            let AgentSessionEventPayload::AssistantMessage { content, .. } = &event.payload else {
                continue;
            };
            let calls = super::assistant_tool_calls(content);
            let Some(index) = calls
                .iter()
                .position(|call| call.call_id == self.call.call_id)
            else {
                continue;
            };
            for call in calls
                .iter()
                .skip(index + 1)
                .filter(|call| !recorded.contains(call.call_id.as_str()))
            {
                payloads.push(self.scoped(AgentSessionEventPayload::ToolCall {
                    call: (*call).clone(),
                }));
                payloads.push(self.scoped(AgentSessionEventPayload::ToolResult {
                    call_id: call.call_id.clone(),
                    name: call.name.clone(),
                    status: AgentToolResultStatus::Rejected,
                    summary: "Tool not started: approval settled after restart".into(),
                    data: Some(serde_json::json!({ "schedulerAdmission": "notStarted", "reason": "approvalSettledAfterRestart" })),
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                }));
            }
            break;
        }
    }
}

fn recorded_pending_approvals(events: &[AgentSessionEvent]) -> Vec<RecordedPendingApproval<'_>> {
    let Some(turn_id) = super::recovery::open_turn_id(events) else {
        return Vec::new();
    };
    let mut calls = HashMap::new();
    let mut pending = HashMap::new();
    for event in events
        .iter()
        .filter(|event| event.turn_id.as_deref() == Some(turn_id))
    {
        let Some(step_id) = event.step_id.as_deref() else {
            continue;
        };
        match &event.payload {
            AgentSessionEventPayload::ToolCall { call } => {
                calls.insert((step_id, call.call_id.as_str()), call);
            }
            AgentSessionEventPayload::ToolApproval {
                request_id,
                call_id,
                approval_id: Some(approval_id),
                expires_at_unix_ms,
                status: AgentToolApprovalStatus::Requested,
                ..
            } => {
                let key = (step_id, call_id.as_str());
                if let Some(call) = calls.get(&key) {
                    pending.insert(
                        key,
                        RecordedPendingApproval {
                            event,
                            call,
                            request_id,
                            approval_id,
                            expires_at_unix_ms: expires_at_unix_ms.unwrap_or(event.time_unix_ms),
                        },
                    );
                }
            }
            AgentSessionEventPayload::ToolApproval { call_id, .. }
            | AgentSessionEventPayload::ToolExecution { call_id, .. }
            | AgentSessionEventPayload::ToolResult { call_id, .. } => {
                pending.remove(&(step_id, call_id.as_str()));
            }
            _ => {}
        }
    }
    let mut pending: Vec<_> = pending.into_values().collect();
    pending.sort_by_key(|approval| approval.event.seq);
    pending
}

fn cancel_recorded_approvals(events: &[AgentSessionEvent], payloads: &mut Vec<ScopedSettlement>) {
    for pending in recorded_pending_approvals(events) {
        pending.settle(
            payloads,
            AgentToolApprovalStatus::Cancelled,
            AgentToolResultStatus::Cancelled,
            "Native tool call was cancelled",
        );
    }
}

fn validate_tool_approval_transition(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
    call_id: &str,
    approval_id: Option<&str>,
    status: super::AgentToolApprovalStatus,
    expires_at_unix_ms: Option<u64>,
) -> Result<(), String> {
    let scoped = record.events.iter().filter(|previous| {
        previous.step_id == event.step_id
            && match &previous.payload {
                AgentSessionEventPayload::ToolCall { call } => call.call_id == call_id,
                AgentSessionEventPayload::ToolApproval {
                    call_id: previous_call,
                    ..
                }
                | AgentSessionEventPayload::ToolResult {
                    call_id: previous_call,
                    ..
                } => previous_call == call_id,
                _ => false,
            }
    });
    let mut has_call = false;
    let mut latest_approval = None;
    let mut has_result = false;
    for previous in scoped {
        match &previous.payload {
            AgentSessionEventPayload::ToolCall { .. } => has_call = true,
            AgentSessionEventPayload::ToolApproval {
                approval_id,
                status,
                ..
            } => latest_approval = Some((approval_id.as_deref(), *status)),
            AgentSessionEventPayload::ToolResult { .. } => has_result = true,
            _ => {}
        }
    }
    if !has_call || has_result {
        return Err("tool approval has no pending durable call".into());
    }
    match status {
        super::AgentToolApprovalStatus::Requested => {
            if latest_approval.is_some()
                || approval_id.is_none()
                || expires_at_unix_ms.is_none_or(|expires| expires <= event.time_unix_ms)
            {
                return Err("tool approval request is stale or has an invalid TTL".into());
            }
        }
        super::AgentToolApprovalStatus::Approved if approval_id.is_none() => {
            if latest_approval.is_some() {
                return Err("automatic native approval cannot follow another decision".into());
            }
        }
        super::AgentToolApprovalStatus::Cancelled
            if latest_approval == Some((approval_id, super::AgentToolApprovalStatus::Approved)) =>
        {
            if record.events.iter().any(|previous| {
                previous.step_id == event.step_id
                    && matches!(&previous.payload, AgentSessionEventPayload::ToolExecution {
                    call_id: dispatched, ..
                } if dispatched == call_id)
            }) {
                return Err("dispatched tool must settle through its execution owner".into());
            }
        }
        super::AgentToolApprovalStatus::Approved
        | super::AgentToolApprovalStatus::Rejected
        | super::AgentToolApprovalStatus::Expired
        | super::AgentToolApprovalStatus::Cancelled => {
            if !matches!(
                latest_approval,
                Some((previous_id, super::AgentToolApprovalStatus::Requested))
                    if previous_id == approval_id
            ) {
                return Err("tool approval decision is duplicate, late, or mismatched".into());
            }
        }
    }
    Ok(())
}

fn validate_tool_result_transition(
    record: &AgentSessionRecord,
    event: &AgentSessionEvent,
    call_id: &str,
    status: super::AgentToolResultStatus,
) -> Result<(), String> {
    let mut has_call = false;
    let mut is_skill = false;
    let mut approval = None;
    let mut dispatched = false;
    let mut previous_result = None;
    for previous in record
        .events
        .iter()
        .filter(|previous| previous.step_id == event.step_id)
    {
        match &previous.payload {
            AgentSessionEventPayload::ToolCall { call } if call.call_id == call_id => {
                has_call = true;
                is_skill = call.name == super::skills::SKILL_TOOL;
            }
            AgentSessionEventPayload::ToolApproval {
                call_id: previous_call,
                status,
                ..
            } if previous_call == call_id => approval = Some(*status),
            AgentSessionEventPayload::ToolResult {
                call_id: previous_call,
                status,
                ..
            } if previous_call == call_id => previous_result = Some(*status),
            AgentSessionEventPayload::ToolExecution {
                call_id: previous_call,
                ..
            } if previous_call == call_id => dispatched = true,
            _ => {}
        }
    }
    if !has_call
        || previous_result.is_some_and(|previous| {
            previous != super::AgentToolResultStatus::Uncertain
                || status == super::AgentToolResultStatus::Uncertain
        })
    {
        return Err("tool result has no unique durable call".into());
    }
    if let Some(question) = super::user_questions::records(&record.events)
        .into_iter()
        .find(|q| {
            q.identity.call_id == call_id && event.step_id.as_deref() == Some(&q.identity.step_id)
        })
    {
        if super::user_questions::matches_result(&question, &event.payload) {
            return Ok(());
        }
        return Err("question result does not match its durable answer or cancellation".into());
    }
    let allowed = match approval {
        Some(super::AgentToolApprovalStatus::Approved) => dispatched,
        Some(super::AgentToolApprovalStatus::Rejected) => {
            status == super::AgentToolResultStatus::Rejected
        }
        Some(super::AgentToolApprovalStatus::Expired) => {
            status == super::AgentToolResultStatus::TimedOut
        }
        Some(super::AgentToolApprovalStatus::Cancelled) => {
            status == super::AgentToolResultStatus::Cancelled
        }
        Some(super::AgentToolApprovalStatus::Requested) => false,
        None => {
            (is_skill && status == super::AgentToolResultStatus::Cancelled)
                || matches!(
                    status,
                    super::AgentToolResultStatus::Rejected | super::AgentToolResultStatus::Failed
                )
        }
    };
    if !allowed {
        return Err("tool result does not match the durable approval state".into());
    }
    Ok(())
}

fn validate_record_final(record: &AgentSessionRecord) -> Result<(), String> {
    if record.ended && !record.inbox.is_empty() && !retains_paused_inputs(record, record.status) {
        return Err("ended Agent session retained unclaimed Inbox messages".into());
    }
    Ok(())
}

fn retains_paused_inputs(record: &AgentSessionRecord, status: AgentSessionStatus) -> bool {
    status == AgentSessionStatus::Failed
        && record.header.subagent.is_none()
        && record.inbox.turn_claim().is_empty()
        && record.inbox.step_claim().is_empty()
}

fn observe_event(record: &mut AgentSessionRecord, event: &AgentSessionEvent) {
    record.snapshot_cache = Arc::new(OnceLock::new());
    record.driver_metrics.observe(event);
    record.loop_progress.observe(event);
}

fn apply_event(record: &mut AgentSessionRecord, event: &AgentSessionEvent) -> Result<(), String> {
    observe_event(record, event);
    match &event.payload {
        AgentSessionEventPayload::SessionResumed {} => {
            record.status = AgentSessionStatus::Idle;
            record.ended = false;
        }
        AgentSessionEventPayload::SubagentRecoveryStarted { message, .. } => {
            record.status = AgentSessionStatus::Idle;
            record.ended = false;
            record.inbox.apply(
                AgentInboxOperation::Enqueued,
                AgentInboxLane::NextTurn,
                std::slice::from_ref(message),
            )?;
        }
        AgentSessionEventPayload::InboxPaused { item_ids } => record.inbox.pause(item_ids)?,
        AgentSessionEventPayload::InboxItemResumed { item_id, .. } => {
            record.inbox.resume(item_id)?
        }
        AgentSessionEventPayload::AgentStatus { status, .. } => record.status = *status,
        AgentSessionEventPayload::SessionEnded { status, .. } => {
            record.status = *status;
            record.ended = true;
        }
        AgentSessionEventPayload::InboxSpliced {
            operation,
            lane,
            messages,
        } => {
            record.inbox.apply(*operation, *lane, messages)?;
            if record.ended
                && record.status == AgentSessionStatus::Failed
                && *operation == AgentInboxOperation::Enqueued
            {
                record.inbox.pause(
                    &messages
                        .iter()
                        .map(|message| message.message_id.clone())
                        .collect::<Vec<_>>(),
                )?;
            }
        }
        AgentSessionEventPayload::InboxItemUpdated {
            item_id,
            lane,
            content,
            images,
            ..
        } => record
            .inbox
            .update(*lane, item_id, content.clone(), images.as_deref())?,
        AgentSessionEventPayload::InboxItemRemoved { item_id, lane, .. } => {
            record.inbox.remove(*lane, item_id)?
        }
        AgentSessionEventPayload::InboxItemSteered { item_id, .. } => {
            record.inbox.steer(item_id)?
        }
        AgentSessionEventPayload::InboxReordered {
            lane,
            ordered_item_ids,
            ..
        } => record.inbox.reorder(*lane, ordered_item_ids)?,
        AgentSessionEventPayload::SessionModelSelected { provider } => {
            record.header.model_selection = Some(provider.clone());
        }
        AgentSessionEventPayload::SessionPermissionChanged { mode } => {
            record.header.permission_mode = Some(*mode);
        }
        AgentSessionEventPayload::SessionExecutionSurfaceChanged { surface } => {
            record.header.execution_surface = *surface;
        }
        AgentSessionEventPayload::SessionTerminalReconnected { target, .. } => {
            record.header.target = Some(target.clone());
            record.header.permission_mode = Some(AgentSessionPermissionMode::RequestApproval);
        }
        AgentSessionEventPayload::SessionProjectRootBound { root } => {
            if let Some(target) = record.header.target.as_mut() {
                if target.kind == "local" {
                    target.cwd = Some(root.clone());
                } else {
                    target.root_path = Some(root.clone());
                }
            }
        }
        AgentSessionEventPayload::SessionRenamed { title, .. } => {
            record.header.title = Some(title.clone())
        }
        _ => {}
    }
    Ok(())
}

fn validate_event_payload(event: &AgentSessionEvent) -> Result<(), String> {
    use AgentSessionEventPayload as Payload;

    match &event.payload {
        Payload::QuestionRequested { .. }
        | Payload::QuestionAnswered { .. }
        | Payload::QuestionActionAnswered { .. }
        | Payload::QuestionCancelled { .. } => super::user_questions::validate_payload(event),
        Payload::SessionCreated { .. }
        | Payload::AgentCreated { .. }
        | Payload::SessionResumed {}
        | Payload::SubagentRecoveryStarted { .. }
        | Payload::AgentStatus { .. }
        | Payload::SessionEnded { .. }
        | Payload::SessionModelSelected { .. }
        | Payload::SessionPermissionChanged { .. }
        | Payload::SessionProjectRootBound { .. }
        | Payload::SessionExecutionSurfaceChanged { .. }
        | Payload::SessionTerminalReconnected { .. }
        | Payload::SessionRenamed { .. } => validation::validate_session_lifecycle_payload(event),
        Payload::InboxPaused { .. }
        | Payload::InboxItemResumed { .. }
        | Payload::InboxSpliced { .. }
        | Payload::InboxItemUpdated { .. }
        | Payload::InboxItemSteered { .. }
        | Payload::InboxItemRemoved { .. }
        | Payload::InboxReordered { .. }
        | Payload::StepInputClaim { .. }
        | Payload::UserMessage { .. } => validation::validate_inbox_payload(event),
        Payload::FileReferenceScopeBound { .. }
        | Payload::SkillCatalogObserved { .. }
        | Payload::SkillCatalogPublished { .. }
        | Payload::SkillStepPrepared { .. } => {
            validation::validate_skill_and_file_ref_payload(event)
        }
        Payload::TurnStart
        | Payload::TurnEnd { .. }
        | Payload::StepStart
        | Payload::StepEnd { .. }
        | Payload::StepPreparationAbandoned { .. }
        | Payload::AssistantChunk { .. }
        | Payload::AssistantMessage { .. } => {
            validation::validate_turn_and_assistant_payload(event)
        }
        Payload::RequestHeader { .. }
        | Payload::RequestStart { .. }
        | Payload::RequestContext { .. }
        | Payload::RequestRetry { .. }
        | Payload::RequestUsage { .. }
        | Payload::RequestFailure { .. } => validation::validate_request_payload(event),
        Payload::ToolCall { .. }
        | Payload::ToolApproval { .. }
        | Payload::ToolExecution { .. }
        | Payload::ToolResult { .. } => validation::validate_tool_payload(event),
        Payload::ContextArtifact { .. }
        | Payload::CompactionStart { .. }
        | Payload::CompactionSummary { .. }
        | Payload::CompactionEnd { .. } => {
            validation::validate_context_and_compaction_payload(event)
        }
        Payload::SubagentDescriptor { .. }
        | Payload::SubagentMessage { .. }
        | Payload::SubagentSettled { .. }
        | Payload::SubagentDetached { .. } => validation::validate_subagent_payload(event),
        Payload::TaskLinked { .. }
        | Payload::TaskPlan { .. }
        | Payload::TaskState { .. }
        | Payload::TaskEvidence { .. } => validation::validate_task_payload(event),
    }
}

fn inbox_content_fingerprint(content: &str) -> Option<String> {
    (redact_sensitive_text(content) != content)
        .then(|| crate::llm::runtime::digest(content.as_bytes()))
}

fn same_terminal_login(old: &AgentSessionTarget, current: &AgentSessionTarget) -> bool {
    let normalized_host = |value: &str| {
        let host = value.trim();
        host.strip_prefix('[')
            .and_then(|inner| inner.strip_suffix(']'))
            .unwrap_or(host)
            .to_ascii_lowercase()
    };
    match (old.kind.as_str(), current.kind.as_str()) {
        ("local", "local") => true,
        ("remote", "remote") => {
            old.port == current.port
                && old.username.as_deref().map(str::trim)
                    == current.username.as_deref().map(str::trim)
                && old.host.as_deref().map(normalized_host)
                    == current.host.as_deref().map(normalized_host)
        }
        _ => false,
    }
}

struct ReplayResolution {
    message_id: String,
    metadata: super::AgentArtifactMetadata,
    request_id: String,
    snapshot: crate::llm::runtime::RequestSnapshot,
}

fn plan_model_surface(
    events: &[AgentSessionEvent],
) -> Result<(AgentSurfaceSnapshot, Vec<ReplayResolution>), String> {
    let surface = derive_surface(events)?;
    let active_replays = surface
        .messages
        .iter()
        .filter_map(|message| match message {
            AgentSurfaceMessage::Assistant {
                message_id,
                replay: Some(replay),
                ..
            } if replay.artifact_metadata().is_some() => Some(message_id.clone()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    if active_replays.is_empty() {
        return Ok((surface, Vec::new()));
    }

    let mut headers = HashMap::new();
    let mut starts = HashMap::new();
    let mut resolutions = Vec::with_capacity(active_replays.len());
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::RequestHeader {
                request_id,
                snapshot,
                snapshot_digest,
                ..
            } => {
                headers.insert(request_id.as_str(), (snapshot, snapshot_digest.as_str()));
            }
            AgentSessionEventPayload::RequestStart {
                request_id,
                header_request_id,
                ..
            } => {
                let (Some(turn_id), Some(step_id)) =
                    (event.turn_id.as_deref(), event.step_id.as_deref())
                else {
                    return Err("request/start lost its Turn/Step scope".into());
                };
                starts.insert(
                    (turn_id, step_id),
                    (request_id.as_str(), header_request_id.as_str()),
                );
            }
            AgentSessionEventPayload::AssistantMessage {
                message_id,
                replay: Some(replay),
                ..
            } if active_replays.contains(message_id) => {
                let metadata = replay
                    .artifact_metadata()
                    .cloned()
                    .ok_or_else(|| "active replay claim check lost its artifact".to_string())?;
                let (Some(turn_id), Some(step_id)) =
                    (event.turn_id.as_deref(), event.step_id.as_deref())
                else {
                    return Err("assistant replay lost its Turn/Step scope".into());
                };
                let (request_id, header_request_id) =
                    starts.get(&(turn_id, step_id)).copied().ok_or_else(|| {
                        "assistant replay requires a committed request/start".to_string()
                    })?;
                let (snapshot, snapshot_digest) =
                    headers.get(header_request_id).copied().ok_or_else(|| {
                        "assistant replay requires its committed request/header snapshot"
                            .to_string()
                    })?;
                if snapshot.digest() != snapshot_digest {
                    return Err("assistant replay request snapshot digest mismatch".into());
                }
                resolutions.push(ReplayResolution {
                    message_id: message_id.clone(),
                    metadata,
                    request_id: request_id.to_string(),
                    snapshot: snapshot.clone(),
                });
            }
            _ => {}
        }
    }
    if resolutions.len() != active_replays.len() {
        return Err("Model Surface replay claim checks were incomplete".into());
    }
    Ok((surface, resolutions))
}

fn resolve_surface_replays(
    session_id: &str,
    artifacts: &super::AgentArtifactStore,
    surface: &mut AgentSurfaceSnapshot,
    resolutions: Vec<ReplayResolution>,
) -> Result<(), String> {
    let mut resolutions = resolutions
        .into_iter()
        .map(|resolution| (resolution.message_id.clone(), resolution))
        .collect::<HashMap<_, _>>();
    for message in &mut surface.messages {
        let AgentSurfaceMessage::Assistant {
            message_id,
            content,
            replay: Some(stored),
            ..
        } = message
        else {
            continue;
        };
        if stored.artifact_metadata().is_none() {
            continue;
        }
        let resolution = resolutions
            .remove(message_id)
            .ok_or_else(|| "Agent replay artifact lost its assistant message".to_string())?;
        let envelope = artifacts.retrieve_replay(session_id, &resolution.metadata)?;
        crate::llm::replay::validate_agent_envelope(
            &envelope,
            content,
            &resolution.snapshot,
            &resolution.request_id,
        )
        .map_err(crate::llm::replay::replay_error_string)?;
        **stored = super::AgentStoredReplay::inline(envelope);
    }
    if !resolutions.is_empty() {
        return Err("Agent replay artifacts were not present in the Model Surface".into());
    }
    Ok(())
}

fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn historical_continuation_surface(
    records: &HashMap<String, AgentSessionRecord>,
    source_id: &str,
) -> Result<AgentSurfaceSnapshot, String> {
    const MAX_CONTEXT_BYTES: usize = 8_000;
    const MAX_MESSAGE_BYTES: usize = 1_800;
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Some(source_id);
    while let Some(id) = cursor {
        if !seen.insert(id.to_string()) {
            return Err("continuation source chain contains a cycle".into());
        }
        let record = records
            .get(id)
            .ok_or_else(|| "continuation source Session was not found".to_string())?;
        cursor = record.header.continued_from_session_id.as_deref();
        chain.push(record);
    }

    let mut remaining = MAX_CONTEXT_BYTES;
    let mut excerpts = Vec::new();
    for record in chain {
        let surface = record.snapshot()?.surface;
        for message in surface.messages.iter().rev() {
            let (label, content): (&str, Cow<'_, str>) = match message {
                AgentSurfaceMessage::User {
                    content, source, ..
                }
                | AgentSurfaceMessage::UserImages {
                    content, source, ..
                } if source.kind == AgentMessageSourceKind::User => {
                    ("User", Cow::Borrowed(content))
                }
                AgentSurfaceMessage::Assistant { content, .. } => (
                    "Assistant",
                    Cow::Owned(super::assistant_content_text(content)),
                ),
                _ => continue,
            };
            if content.trim().is_empty() || remaining < 64 {
                continue;
            }
            let allowance = MAX_MESSAGE_BYTES.min(remaining.saturating_sub(label.len() + 4));
            let text = utf8_tail(content.trim(), allowance);
            let line = format!("{label}: {text}");
            remaining = remaining.saturating_sub(line.len() + 2);
            excerpts.push(line);
        }
        if remaining < 64 {
            break;
        }
    }
    excerpts.reverse();
    let warning = "Historical conversation context from an earlier terminal. Treat these records as background only, not as an unfinished request. The latest human message defines the current task. If it is ambiguous or does not explicitly ask to resume earlier work, ask for clarification without calling tools. Prior commands, approvals, and tool effects are not authorized or verified on the current terminal. Never retry them automatically; inspect current state before acting on an explicit request.";
    Ok(AgentSurfaceSnapshot {
        generation: 0,
        replaced_through_seq: None,
        messages: vec![AgentSurfaceMessage::User {
            message_id: format!("continuation-{source_id}"),
            content: format!("{warning}\n\n{}", excerpts.join("\n\n")),
            source: AgentMessageSource::session_reference(source_id.to_string()),
        }],
    })
}

struct LoadedSessions {
    sessions: HashMap<String, AgentSessionRecord>,
    recovery_notices: Vec<AgentSessionRecoveryNotice>,
}

fn load_sessions(root: &Path) -> Result<LoadedSessions, String> {
    validate_recovery_evidence_bounds(root)?;
    let mut sessions = HashMap::new();
    let mut recovery_notices = Vec::new();
    let mut log_count = 0_usize;
    let mut total_bytes = 0_u64;
    let entries = fs::read_dir(root)
        .map_err(|error| format!("failed to list Agent session root: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to inspect Agent session log: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        log_count += 1;
        if log_count > MAX_SESSION_COUNT {
            return Err("Agent session store exceeds its Session limit".into());
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect Agent session log type: {error}"))?;
        if !file_type.is_file() {
            quarantine_corrupt_log(
                &path,
                "Agent Session entry was not a regular file",
                &mut recovery_notices,
            )?;
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect Agent session log: {error}"))?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > MAX_TOTAL_SESSION_LOG_BYTES {
            return Err("Agent session store exceeds its total storage boundary".into());
        }
        restrict_file(&path)?;
        let events = match read_log_repairing_bad_tail(&path, &mut recovery_notices) {
            Ok(events) => events,
            Err(error) => {
                quarantine_corrupt_log(&path, &error, &mut recovery_notices)?;
                continue;
            }
        };
        let record = match AgentSessionRecord::from_events(events) {
            Ok(record) => record,
            Err(error) => {
                quarantine_corrupt_log(&path, &error, &mut recovery_notices)?;
                continue;
            }
        };
        let file_stem = path.file_stem().and_then(|value| value.to_str());
        if file_stem != Some(record.header.session_id.as_str()) {
            quarantine_corrupt_log(
                &path,
                "Agent Session file name did not match sessionId",
                &mut recovery_notices,
            )?;
            continue;
        }
        if sessions
            .insert(record.header.session_id.clone(), record)
            .is_some()
        {
            return Err("duplicate Agent session identity in persistence".into());
        }
    }
    Ok(LoadedSessions {
        sessions,
        recovery_notices,
    })
}

fn read_log_repairing_bad_tail(
    path: &Path,
    notices: &mut Vec<AgentSessionRecoveryNotice>,
) -> Result<Vec<AgentSessionEvent>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect Agent session log: {error}"))?;
    if metadata.len() == 0 {
        return Err("Agent session log is empty".into());
    }
    if metadata.len() > MAX_SESSION_LOG_BYTES {
        return Err("Agent session log exceeds the storage boundary".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("failed to read Agent session log: {error}"))?;
    if bytes.last() != Some(&b'\n') {
        let committed_len = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let tail = &bytes[committed_len..];
        ensure_recovery_evidence_capacity(path, tail.len() as u64)?;
        let evidence_path = evidence_path(path, "bad-tail")?;
        write_private_exclusive(&evidence_path, tail)?;
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|error| format!("failed to open Agent Session for tail recovery: {error}"))?;
        file.set_len(committed_len as u64)
            .and_then(|()| file.sync_all())
            .map_err(|error| {
                format!("failed to truncate uncommitted Agent Session tail: {error}")
            })?;
        sync_parent(path)?;
        notices.push(recovery_notice(
            path,
            AgentSessionRecoveryAction::BadTailDiscarded,
            "discarded bytes after the last committed JSONL newline",
            &evidence_path,
        ));
        bytes.truncate(committed_len);
    }
    if bytes.is_empty() {
        return Err("Agent session log has no committed events".into());
    }
    let mut events = Vec::new();
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.is_empty() {
            if index + 1 == bytes.split(|byte| *byte == b'\n').count() {
                continue;
            }
            return Err(format!("empty Agent session event at line {}", index + 1));
        }
        if line.len() > MAX_SESSION_EVENT_BYTES {
            return Err(format!(
                "Agent session event at line {} exceeds the storage boundary",
                index + 1
            ));
        }
        let event = serde_json::from_slice::<AgentSessionEvent>(line).map_err(|error| {
            format!("invalid Agent session event at line {}: {error}", index + 1)
        })?;
        events.push(event);
    }
    Ok(events)
}

fn quarantine_corrupt_log(
    path: &Path,
    reason: &str,
    notices: &mut Vec<AgentSessionRecoveryNotice>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect corrupt Agent Session log: {error}"))?;
    ensure_recovery_evidence_capacity(path, metadata.len())?;
    let quarantine = evidence_path(path, "corrupt")?;
    fs::rename(path, &quarantine)
        .map_err(|error| format!("failed to quarantine corrupt Agent Session log: {error}"))?;
    if metadata.file_type().is_file() {
        restrict_file(&quarantine)?;
    }
    sync_parent(&quarantine)?;
    let notice = recovery_notice(
        path,
        AgentSessionRecoveryAction::CorruptLogQuarantined,
        reason,
        &quarantine,
    );
    log::warn!(
        "Quarantined Agent Session log {}: {}",
        notice.file_name,
        notice.reason
    );
    notices.push(notice);
    Ok(())
}

fn recovery_notice(
    original: &Path,
    action: AgentSessionRecoveryAction,
    reason: &str,
    evidence: &Path,
) -> AgentSessionRecoveryNotice {
    AgentSessionRecoveryNotice {
        file_name: original
            .file_name()
            .and_then(|value| value.to_str())
            .map(redact_sensitive_text)
            .unwrap_or_else(|| "unknown-session-log".into()),
        action,
        reason: redact_sensitive_text(reason),
        evidence_file_name: evidence
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("quarantined-session-log")
            .to_string(),
        recorded_at_unix_ms: current_unix_ms().max(1),
    }
}

fn evidence_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Agent Session log file name was invalid".to_string())?;
    Ok(path.with_file_name(format!("{file_name}.{label}-{}", Uuid::new_v4().simple())))
}

fn sanitize_event(event: AgentSessionEvent) -> Result<AgentSessionEvent, String> {
    let value = serde_json::to_value(event)
        .map_err(|error| format!("failed to encode Agent session event: {error}"))?;
    serde_json::from_value(redact_json_value(&value))
        .map_err(|error| format!("failed to sanitize Agent session event: {error}"))
}

fn encoded_events(events: &[AgentSessionEvent]) -> Result<Vec<u8>, String> {
    let mut batch = Vec::new();
    for event in events {
        let encoded = serde_json::to_vec(event)
            .map_err(|error| format!("failed to encode Agent session event: {error}"))?;
        if encoded.len() > MAX_SESSION_EVENT_BYTES {
            return Err("Agent session event exceeds the storage boundary".into());
        }
        batch.extend_from_slice(&encoded);
        batch.push(b'\n');
    }
    Ok(batch)
}

pub(crate) fn event_payload_fits_storage_boundary(
    session_id: &str,
    turn_id: Option<&str>,
    step_id: Option<&str>,
    payload: &AgentSessionEventPayload,
) -> Result<bool, String> {
    event_payload_fits_boundary(
        session_id,
        turn_id,
        step_id,
        payload,
        MAX_SESSION_EVENT_BYTES,
    )
}

pub(crate) fn event_payload_fits_inline_replay_boundary(
    session_id: &str,
    turn_id: Option<&str>,
    step_id: Option<&str>,
    payload: &AgentSessionEventPayload,
) -> Result<bool, String> {
    event_payload_fits_boundary(
        session_id,
        turn_id,
        step_id,
        payload,
        MAX_INLINE_REPLAY_EVENT_BYTES,
    )
}

fn event_payload_fits_boundary(
    session_id: &str,
    turn_id: Option<&str>,
    step_id: Option<&str>,
    payload: &AgentSessionEventPayload,
    limit: usize,
) -> Result<bool, String> {
    let event = AgentSessionEvent::new(
        session_id.to_string(),
        MAX_JS_SAFE_INTEGER,
        MAX_JS_SAFE_INTEGER,
        turn_id.map(str::to_string),
        step_id.map(str::to_string),
        payload.clone(),
    );
    serde_json::to_vec(&event)
        .map(|encoded| encoded.len() <= limit)
        .map_err(|error| format!("failed to measure Agent session event: {error}"))
}

fn write_new_log(
    root: &Path,
    session_id: &str,
    events: &[AgentSessionEvent],
) -> Result<(), String> {
    let encoded = encoded_events(events)?;
    // The store reserves aggregate capacity before calling this writer.
    if encoded.len() as u64 > MAX_SESSION_LOG_BYTES {
        return Err("Agent session store exceeds its storage boundary".into());
    }
    let path = session_path(root, session_id);
    let result = write_private_exclusive(&path, &encoded).and_then(|()| sync_parent(&path));
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

fn append_log_batch(
    root: &Path,
    session_id: &str,
    encoded: &[u8],
    limit: u64,
) -> Result<(), String> {
    let path = session_path(root, session_id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect Agent session log: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Agent session log is not a regular file".into());
    }
    let original_len = metadata.len();
    if original_len.saturating_add(encoded.len() as u64) > limit {
        return Err("Agent session store exceeds its storage boundary".into());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open Agent session log: {error}"))?;
    restrict_open_file(&file)?;
    if let Err(error) = file.write_all(encoded).and_then(|()| file.sync_data()) {
        let rollback = file.set_len(original_len).and_then(|()| file.sync_all());
        return match rollback {
            Ok(()) => Err(format!("failed to persist Agent session event: {error}")),
            Err(rollback_error) => Err(format!(
                "failed to persist Agent session event ({error}); rollback also failed ({rollback_error})"
            )),
        };
    }
    Ok(())
}

fn write_private_exclusive(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("failed to create private Agent Session file: {error}"))?;
    restrict_open_file(&file)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("failed to persist private Agent Session file: {error}"))
}

fn total_log_bytes(root: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    for entry in fs::read_dir(root)
        .map_err(|error| format!("failed to inspect Agent Session storage: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect Agent Session storage: {error}"))?;
        if entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
            && entry
                .file_type()
                .map_err(|error| format!("failed to inspect Agent Session storage: {error}"))?
                .is_file()
        {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| format!("failed to inspect Agent Session storage: {error}"))?
                    .len(),
            );
        }
    }
    Ok(total)
}

fn validate_recovery_evidence_bounds(root: &Path) -> Result<(), String> {
    let (count, bytes) = recovery_evidence_usage(root)?;
    if count > MAX_RECOVERY_EVIDENCE_FILES || bytes > MAX_RECOVERY_EVIDENCE_BYTES {
        return Err("Agent Session recovery evidence exceeds its storage boundary".into());
    }
    Ok(())
}

fn ensure_recovery_evidence_capacity(path: &Path, additional_bytes: u64) -> Result<(), String> {
    let root = path
        .parent()
        .ok_or_else(|| "Agent Session recovery evidence has no parent".to_string())?;
    let (count, bytes) = recovery_evidence_usage(root)?;
    if count >= MAX_RECOVERY_EVIDENCE_FILES
        || bytes.saturating_add(additional_bytes) > MAX_RECOVERY_EVIDENCE_BYTES
    {
        return Err("Agent Session recovery evidence reached its storage boundary".into());
    }
    Ok(())
}

fn recovery_evidence_usage(root: &Path) -> Result<(usize, u64), String> {
    let mut count = 0_usize;
    let mut bytes = 0_u64;
    for entry in fs::read_dir(root)
        .map_err(|error| format!("failed to inspect Agent Session recovery evidence: {error}"))?
    {
        let entry = entry.map_err(|error| {
            format!("failed to inspect Agent Session recovery evidence: {error}")
        })?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.contains(".bad-tail-") && !file_name.contains(".corrupt-") {
            continue;
        }
        count = count.saturating_add(1);
        bytes = bytes.saturating_add(
            fs::symlink_metadata(entry.path())
                .map_err(|error| {
                    format!("failed to inspect Agent Session recovery evidence: {error}")
                })?
                .len(),
        );
    }
    Ok((count, bytes))
}

fn session_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.jsonl"))
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn publish_events(publisher: Option<EventPublisher>, events: &[AgentSessionEvent]) {
    if let Some(publisher) = publisher {
        for event in events {
            let mut public_event = event.clone();
            crate::llm::replay::public_event_projection(&mut public_event);
            publisher(&public_event);
        }
    }
}

fn prepare_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create Agent session root: {error}"))?;
    if !fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect Agent session root: {error}"))?
        .file_type()
        .is_dir()
    {
        return Err("Agent session root is not a regular directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to restrict Agent session root: {error}"))?;
    }
    Ok(())
}

fn restrict_file(path: &Path) -> Result<(), String> {
    if !fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect Agent session log: {error}"))?
        .file_type()
        .is_file()
    {
        return Err("Agent session log is not a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict Agent session log: {error}"))?;
    }
    Ok(())
}

fn restrict_open_file(_file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict Agent session log: {error}"))?;
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent session log has no parent".to_string())?;
    #[cfg(unix)]
    {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("failed to flush Agent session directory: {error}"))
    }
    #[cfg(not(unix))]
    {
        // Windows requires FILE_FLAG_BACKUP_SEMANTICS to open a directory handle.
        // The log file itself was already sync_all'd; do not turn that successful
        // durable commit into an AccessDenied failure by using File::open here.
        let _ = parent;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    include!("tests/session/mod.rs");
}
