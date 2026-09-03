use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::redaction::{redact_json_value, redact_sensitive_text};

use super::{
    derive_surface, derive_task, AgentAssistantContentBlock, AgentInbox, AgentInboxLane,
    AgentInboxMessage, AgentInboxOperation, AgentMessageSource, AgentRecoveryCheckpoint,
    AgentSessionEvent, AgentSessionEventPayload, AgentSessionPermissionMode, AgentSessionStatus,
    AgentSessionTarget, AgentSubagentSession, AgentSurfaceSnapshot, AgentTaskProjection,
    RecordedToolCall, AGENT_SESSION_EVENT_VERSION, MAX_AGENT_MESSAGE_BYTES,
    MAX_AGENT_STREAM_DELTA_BYTES,
};

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 4 * 1024;
const MAX_SESSION_EVENT_BYTES: usize = 256 * 1024;
const MAX_SESSION_LOG_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_SESSION_LOG_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSION_COUNT: usize = 512;
const MAX_RECOVERY_EVIDENCE_FILES: usize = 256;
const MAX_RECOVERY_EVIDENCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SESSION_PAGE_SIZE: usize = 256;
const MAX_EVENT_PAGE_SIZE: usize = 1_024;
const MAX_COLLECTION_ITEMS: usize = 1_024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SESSION_TITLE_CHARS: usize = 120;
const MAX_SESSION_TITLE_BYTES: usize = 512;

type EventPublisher = Arc<dyn Fn(&AgentSessionEvent) + Send + Sync>;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSessionHeader {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<AgentSessionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<AgentSessionPermissionMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) success_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) capability_scope: Option<super::AgentCapabilityScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subagent: Option<AgentSubagentSession>,
    pub(crate) created_at_unix_ms: u64,
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
    pub(crate) target: Option<AgentSessionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<AgentSessionPermissionMode>,
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
    Update {
        item_id: String,
        content: String,
    },
    Remove {
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentInboxProjection {
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
}

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

pub(crate) struct AgentClaimedStep;

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
    archived: bool,
    events: Vec<AgentSessionEvent>,
    inbox: AgentInbox,
}

impl AgentSessionRecord {
    fn from_events(events: Vec<AgentSessionEvent>) -> Result<Self, String> {
        let first = events
            .first()
            .ok_or_else(|| "Agent session log is empty".to_string())?;
        let AgentSessionEventPayload::SessionCreated {
            task_id,
            goal,
            parent_session_id,
            target,
            permission_mode,
            success_criteria,
            capability_scope,
            subagent,
        } = &first.payload
        else {
            return Err("Agent session log does not start with session/created".into());
        };
        let header = AgentSessionHeader {
            session_id: first.session_id.clone(),
            task_id: task_id.clone(),
            goal: goal.clone(),
            title: None,
            parent_session_id: parent_session_id.clone(),
            target: target.clone(),
            permission_mode: *permission_mode,
            success_criteria: success_criteria.clone(),
            capability_scope: capability_scope.clone(),
            subagent: subagent.clone(),
            created_at_unix_ms: first.time_unix_ms,
        };
        let mut record = Self {
            header,
            status: AgentSessionStatus::Idle,
            ended: false,
            archived: false,
            events: Vec::with_capacity(events.len()),
            inbox: AgentInbox::default(),
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
        Ok(AgentSessionSnapshot {
            header: self.header.clone(),
            status: self.status,
            ended: self.ended,
            archived: self.archived,
            event_count: self.events.len() as u64,
            surface: derive_surface(&self.events)?,
            inbox: AgentInboxProjection {
                next_turn: self.inbox.next_turn(),
                next_step: self.inbox.next_step(),
            },
            task: derive_task(&self.events),
            recovery: super::derive_recovery_checkpoint(&self.events),
        })
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

#[derive(Default)]
struct AgentSessionStoreInner {
    root: Option<PathBuf>,
    archive_root: Option<PathBuf>,
    sessions: HashMap<String, AgentSessionRecord>,
    recovery_notices: Vec<AgentSessionRecoveryNotice>,
    publisher: Option<EventPublisher>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentSessionStore {
    inner: Arc<Mutex<AgentSessionStoreInner>>,
}

impl AgentSessionStore {
    pub(crate) fn configure(&self, app_data_root: PathBuf) -> Result<(), String> {
        let runtime_root = app_data_root.join("agent-runtime");
        // Earlier namespaces remain untouched. v4 logs are never migrated or dual-written.
        let root = runtime_root.join("sessions-v4");
        let archive_root = runtime_root.join("archives-v4");
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
        if loaded
            .sessions
            .len()
            .saturating_add(archived.sessions.len())
            > MAX_SESSION_COUNT
            || total_log_bytes(&root)?.saturating_add(total_log_bytes(&archive_root)?)
                > MAX_TOTAL_SESSION_LOG_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }
        for record in archived.sessions.values_mut() {
            record.archived = true;
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
        Ok(())
    }

    pub(crate) fn set_publisher(&self, publisher: EventPublisher) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "Agent session store is unavailable".to_string())?
            .publisher = Some(publisher);
        Ok(())
    }

    pub(crate) fn create(
        &self,
        request: CreateAgentSessionRequest,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_create_request(&request)?;

        let mut inner = self.lock_configured()?;
        if inner.sessions.contains_key(&request.session_id) {
            return Err("Agent session already exists".into());
        }
        if inner.sessions.len() >= MAX_SESSION_COUNT {
            return Err("Agent session store reached its Session limit".into());
        }
        let root = inner.root.clone().expect("configured store has a root");
        let archive_root = inner
            .archive_root
            .clone()
            .expect("configured store has an archive root");
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
        if total_log_bytes(&root)?
            .saturating_add(total_log_bytes(&archive_root)?)
            .saturating_add(encoded_len)
            > MAX_TOTAL_SESSION_LOG_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }
        write_new_log(&root, &request.session_id, &events)?;
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
        if inner.sessions.contains_key(&request.session_id) {
            return Err("Agent session already exists".into());
        }
        if inner.sessions.len() >= MAX_SESSION_COUNT {
            return Err("Agent session store reached its Session limit".into());
        }
        let root = inner.root.clone().expect("configured store has a root");
        let archive_root = inner
            .archive_root
            .clone()
            .expect("configured store has an archive root");
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
        if total_log_bytes(&root)?
            .saturating_add(total_log_bytes(&archive_root)?)
            .saturating_add(encoded_len)
            > MAX_TOTAL_SESSION_LOG_BYTES
        {
            return Err("Agent active and archived logs exceed the storage boundary".into());
        }

        write_new_log(&root, &request.session_id, &child_events)?;
        let parent_append = append_payloads_locked(
            &mut inner,
            parent_session_id,
            vec![(None, None, descriptor)],
        );
        let (parent_events, parent_publisher) = match parent_append {
            Ok(committed) => committed,
            Err(error) => {
                let path = session_path(&root, &request.session_id);
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
                        message_id: format!("subagent-{settlement_id}"),
                        client_submission_id: None,
                        content: summary,
                        source: AgentMessageSource::session_reference(child_session_id.to_string()),
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
        let prefix = parent
            .events
            .iter()
            .take_while(|event| event.seq <= boundary)
            .cloned()
            .collect::<Vec<_>>();
        Ok(Some(derive_surface(&prefix)?))
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

    pub(crate) fn target_by_id(&self, target_id: &str) -> Result<AgentSessionTarget, String> {
        validate_identifier(target_id, "targetId")?;
        let inner = self.lock_configured()?;
        inner
            .sessions
            .values()
            .filter_map(|record| record.header.target.as_ref())
            .find(|target| target.target_id == target_id)
            .cloned()
            .ok_or_else(|| "delegated target is not frozen in any Agent Session".to_string())
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
        let mut inner = self.lock_configured()?;
        let payloads = payloads
            .into_iter()
            .map(|event| (event.turn_id, event.step_id, event.payload))
            .collect();
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(events)
    }

    pub(crate) fn begin_turn_step(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
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
        if turn_messages.is_empty() && step_messages.is_empty() {
            return Ok(None);
        }
        let mut payloads = Vec::new();
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
        Ok(Some(AgentClaimedStep))
    }

    pub(crate) fn begin_step(
        &self,
        session_id: &str,
        turn_id: String,
        step_id: String,
    ) -> Result<Option<AgentClaimedStep>, String> {
        let mut inner = self.lock_configured()?;
        let messages = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?
            .inbox
            .step_claim();
        if messages.is_empty() {
            return Ok(None);
        }
        let mut payloads = vec![
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
        Ok(Some(AgentClaimedStep))
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
        let mut payloads = Vec::new();
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
        payloads.extend(messages.into_iter().map(|message| {
            (
                Some(turn_id.clone()),
                Some(step_id.clone()),
                AgentSessionEventPayload::UserMessage { message },
            )
        }));
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(AgentClaimedStep)
    }

    pub(crate) fn enqueue(
        &self,
        session_id: &str,
        lane: AgentInboxLane,
        message: AgentInboxMessage,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_inbox_message(&message)?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if let Some(client_submission_id) = message.client_submission_id.as_deref() {
            if let Some((previous_lane, previous)) = find_submission(record, client_submission_id) {
                if previous_lane != lane || previous != &message {
                    return Err(
                        "client submission id was already committed with a different payload"
                            .into(),
                    );
                }
                return record.snapshot();
            }
        }
        let (events, publisher) = append_payloads_locked(
            &mut inner,
            session_id,
            vec![(
                None,
                None,
                AgentSessionEventPayload::InboxSpliced {
                    operation: AgentInboxOperation::Enqueued,
                    lane,
                    messages: vec![message],
                },
            )],
        )?;
        let snapshot = inner
            .sessions
            .get(session_id)
            .expect("appended Session remains registered")
            .snapshot()?;
        drop(inner);
        publish_events(publisher, &events);
        Ok(snapshot)
    }

    pub(crate) fn mutate_inbox(
        &self,
        input: AgentInboxMutationInput,
    ) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(&input.session_id, "sessionId")?;
        validate_identifier(&input.client_operation_id, "clientOperationId")?;
        if input.expected_revision > MAX_JS_SAFE_INTEGER {
            return Err("Agent inbox expected revision exceeds the wire boundary".into());
        }
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(&input.session_id)
            .ok_or_else(|| "Agent inbox mutation target Session was not found".to_string())?;
        validate_mutable_session(record, "inbox mutation")?;
        validate_expected_revision(record, input.expected_revision)?;
        let payload = match input.mutation {
            AgentInboxMutation::Update { item_id, content } => {
                validate_identifier(&item_id, "itemId")?;
                validate_text(&content, "inbox content", false, MAX_AGENT_MESSAGE_BYTES)?;
                let (lane, _) = require_queued_item(record, &item_id)?;
                AgentSessionEventPayload::InboxItemUpdated {
                    item_id,
                    lane,
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
            let (events, publisher) = append_payloads_locked(
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
        let (events, publisher) = append_payloads_locked(&mut inner, session_id, payloads)?;
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

    pub(crate) fn snapshot(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(session_id, "sessionId")?;
        let inner = self.lock_configured()?;
        inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?
            .snapshot()
    }

    pub(crate) fn session_ids(&self) -> Result<Vec<String>, String> {
        let inner = self.lock_configured()?;
        let mut ids = inner.sessions.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }

    pub(crate) fn archive(&self, session_id: &str) -> Result<AgentSessionSnapshot, String> {
        validate_identifier(session_id, "sessionId")?;
        let mut inner = self.lock_configured()?;
        let record = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| "Agent session was not found".to_string())?;
        if !record.ended {
            return Err("only an ended Agent Session can be archived".into());
        }
        if record.archived {
            return record.snapshot();
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
        record.snapshot()
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
        Ok(AgentSessionEventPage {
            events: record.events[start..end].to_vec(),
            next_cursor: (end < record.events.len()).then_some(end as u64),
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
        AgentSessionEvent::new(
            request.session_id.clone(),
            0,
            now,
            None,
            None,
            AgentSessionEventPayload::SessionCreated {
                task_id: request.task_id.clone(),
                goal: request.goal.clone(),
                parent_session_id: request.parent_session_id.clone(),
                target: request.target.clone(),
                permission_mode: request.permission_mode,
                success_criteria: request.success_criteria.clone(),
                capability_scope: request.capability_scope.clone(),
                subagent: request.subagent.clone(),
            },
        ),
        AgentSessionEvent::new(
            request.session_id.clone(),
            1,
            now,
            None,
            None,
            AgentSessionEventPayload::AgentCreated {
                agent_id: request.session_id.clone(),
                parent_agent_id: request.parent_session_id.clone(),
            },
        ),
    ];
    AgentSessionRecord::from_events(events.clone())?;
    encoded_events(&events)?;
    Ok(events)
}

fn append_payloads_locked(
    inner: &mut AgentSessionStoreInner,
    session_id: &str,
    payloads: Vec<(Option<String>, Option<String>, AgentSessionEventPayload)>,
) -> Result<(Vec<AgentSessionEvent>, Option<EventPublisher>), String> {
    if payloads.is_empty() {
        return Err("Agent Session append batch cannot be empty".into());
    }
    let root = inner.root.clone().expect("configured store has a root");
    let archive_root = inner
        .archive_root
        .clone()
        .expect("configured store has an archive root");
    let record = inner
        .sessions
        .get(session_id)
        .ok_or_else(|| "Agent session was not found".to_string())?;
    if record.archived {
        return Err("archived Agent Session logs are read-only".into());
    }
    let mut candidate = record.clone();
    let mut appended = Vec::with_capacity(payloads.len());
    for (turn_id, step_id, payload) in payloads {
        let seq = candidate.events.len() as u64;
        let previous_time = candidate
            .events
            .last()
            .map_or(1, |event| event.time_unix_ms);
        let raw_event = AgentSessionEvent::new(
            session_id.to_string(),
            seq,
            current_unix_ms().max(previous_time),
            turn_id,
            step_id,
            payload,
        );
        validate_event_envelope(&candidate, &raw_event)?;
        validate_event_transition(&candidate, &raw_event)?;
        validate_event_payload(&raw_event)?;
        encoded_events(std::slice::from_ref(&raw_event))?;
        let event = sanitize_event(raw_event)?;
        validate_event_envelope(&candidate, &event)?;
        validate_event_transition(&candidate, &event)?;
        validate_event_payload(&event)?;
        apply_event(&mut candidate, &event)?;
        candidate.events.push(event.clone());
        appended.push(event);
    }
    derive_surface(&candidate.events)?;
    validate_record_final(&candidate)?;
    let appended_bytes = encoded_events(&appended)?.len() as u64;
    if total_log_bytes(&root)?
        .saturating_add(total_log_bytes(&archive_root)?)
        .saturating_add(appended_bytes)
        > MAX_TOTAL_SESSION_LOG_BYTES
    {
        return Err("Agent active and archived logs exceed the storage boundary".into());
    }
    append_log_batch(&root, session_id, &appended)?;
    inner.sessions.insert(session_id.to_string(), candidate);
    Ok((appended, inner.publisher.clone()))
}

fn find_submission<'a>(
    record: &'a AgentSessionRecord,
    client_submission_id: &str,
) -> Option<(AgentInboxLane, &'a AgentInboxMessage)> {
    record.events.iter().find_map(|event| match &event.payload {
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

fn validate_mutable_session(record: &AgentSessionRecord, operation: &str) -> Result<(), String> {
    if record.archived {
        return Err(format!("archived Agent Session rejects {operation}"));
    }
    if record.ended || record.status.is_terminal() {
        return Err(format!("terminal Agent Session rejects {operation}"));
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
    if event.seq != record.events.len() as u64 || event.seq > MAX_JS_SAFE_INTEGER {
        return Err("Agent session event sequence is not contiguous".into());
    }
    if event.time_unix_ms == 0 || event.time_unix_ms > MAX_JS_SAFE_INTEGER {
        return Err("Agent session event timestamp is invalid".into());
    }
    if record
        .events
        .last()
        .is_some_and(|previous| event.time_unix_ms < previous.time_unix_ms)
    {
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
    if record.ended {
        return Err("ended Agent session does not accept new events".into());
    }
    if record.status.is_terminal()
        && !matches!(event.payload, AgentSessionEventPayload::SessionEnded { .. })
    {
        return Err("terminal Agent status must be followed by session/ended".into());
    }
    match &event.payload {
        AgentSessionEventPayload::SessionCreated { .. } if !record.events.is_empty() => {
            Err("session/created can only be the first event".into())
        }
        AgentSessionEventPayload::SessionCreated { .. } => Ok(()),
        _ if record.events.is_empty() => {
            Err("Agent session log must begin with session/created".into())
        }
        AgentSessionEventPayload::SessionEnded { status, .. } => {
            if !status.is_terminal() {
                return Err("session/ended requires a terminal status".into());
            }
            if !record.inbox.is_empty() {
                return Err("session/ended requires an empty Inbox".into());
            }
            if record.status.is_terminal() && record.status != *status {
                return Err("session/ended did not match the terminal Agent status".into());
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
        _ => Ok(()),
    }
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
    let mut approval = None;
    let mut dispatched = false;
    let mut has_result = false;
    for previous in record
        .events
        .iter()
        .filter(|previous| previous.step_id == event.step_id)
    {
        match &previous.payload {
            AgentSessionEventPayload::ToolCall { call } if call.call_id == call_id => {
                has_call = true;
            }
            AgentSessionEventPayload::ToolApproval {
                call_id: previous_call,
                status,
                ..
            } if previous_call == call_id => approval = Some(*status),
            AgentSessionEventPayload::ToolResult {
                call_id: previous_call,
                ..
            } if previous_call == call_id => has_result = true,
            AgentSessionEventPayload::ToolExecution {
                call_id: previous_call,
                ..
            } if previous_call == call_id => dispatched = true,
            _ => {}
        }
    }
    if !has_call || has_result {
        return Err("tool result has no unique durable call".into());
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
        None => matches!(
            status,
            super::AgentToolResultStatus::Rejected | super::AgentToolResultStatus::Failed
        ),
    };
    if !allowed {
        return Err("tool result does not match the durable approval state".into());
    }
    Ok(())
}

fn validate_record_final(record: &AgentSessionRecord) -> Result<(), String> {
    if record.ended && !record.inbox.is_empty() {
        return Err("ended Agent session retained unclaimed Inbox messages".into());
    }
    Ok(())
}

fn apply_event(record: &mut AgentSessionRecord, event: &AgentSessionEvent) -> Result<(), String> {
    match &event.payload {
        AgentSessionEventPayload::AgentStatus { status, .. } => record.status = *status,
        AgentSessionEventPayload::SessionEnded { status, .. } => {
            record.status = *status;
            record.ended = true;
        }
        AgentSessionEventPayload::InboxSpliced {
            operation,
            lane,
            messages,
        } => record.inbox.apply(*operation, *lane, messages)?,
        AgentSessionEventPayload::InboxItemUpdated {
            item_id,
            lane,
            content,
            ..
        } => record.inbox.update(*lane, item_id, content.clone())?,
        AgentSessionEventPayload::InboxItemRemoved { item_id, lane, .. } => {
            record.inbox.remove(*lane, item_id)?
        }
        AgentSessionEventPayload::InboxReordered {
            lane,
            ordered_item_ids,
            ..
        } => record.inbox.reorder(*lane, ordered_item_ids)?,
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
        Payload::SessionCreated {
            task_id,
            goal,
            parent_session_id,
            target,
            success_criteria,
            capability_scope,
            subagent,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(task_id, "taskId")?;
            validate_text(goal, "goal", false, MAX_AGENT_MESSAGE_BYTES)?;
            if let Some(parent) = parent_session_id {
                validate_identifier(parent, "parentSessionId")?;
            }
            if let Some(target) = target {
                validate_session_target(target)?;
            }
            validate_collection_allow_empty(success_criteria, "success criteria")?;
            for criterion in success_criteria {
                validate_text(
                    criterion,
                    "success criterion",
                    false,
                    MAX_AGENT_MESSAGE_BYTES,
                )?;
            }
            if let Some(scope) = capability_scope {
                validate_capability_scope(scope)?;
            }
            if let Some(subagent) = subagent {
                validate_subagent_session(subagent, parent_session_id.as_deref())?;
            }
        }
        Payload::AgentCreated {
            agent_id,
            parent_agent_id,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(agent_id, "agentId")?;
            if let Some(parent) = parent_agent_id {
                validate_identifier(parent, "parentAgentId")?;
            }
        }
        Payload::AgentStatus { reason, .. } | Payload::SessionEnded { reason, .. } => {
            require_scope(event, false, false)?;
            if let Some(reason) = reason {
                validate_text(reason, "status reason", false, MAX_AGENT_MESSAGE_BYTES)?;
            }
        }
        Payload::InboxSpliced { messages, .. } => {
            require_scope(event, false, false)?;
            validate_collection(messages, "Inbox messages")?;
            for message in messages {
                validate_inbox_message(message)?;
            }
        }
        Payload::InboxItemUpdated {
            item_id,
            content,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_identifier(item_id, "itemId")?;
            validate_text(content, "inbox content", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
        Payload::InboxItemRemoved {
            item_id,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_identifier(item_id, "itemId")?;
        }
        Payload::InboxReordered {
            ordered_item_ids,
            previous_revision,
            client_operation_id,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_collection_allow_empty(ordered_item_ids, "ordered inbox item ids")?;
            let mut unique = HashSet::with_capacity(ordered_item_ids.len());
            for item_id in ordered_item_ids {
                validate_identifier(item_id, "itemId")?;
                if !unique.insert(item_id) {
                    return Err("ordered inbox item ids contain duplicates".into());
                }
            }
        }
        Payload::SessionRenamed {
            title,
            previous_revision,
            client_operation_id,
        } => {
            require_scope(event, false, false)?;
            validate_mutation_event_identity(event, *previous_revision, client_operation_id)?;
            validate_session_title(title)?;
        }
        Payload::TurnStart => require_scope(event, true, false)?,
        Payload::TurnEnd { reason } => {
            require_scope(event, true, false)?;
            validate_text(reason, "Turn end reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::StepStart => require_scope(event, true, true)?,
        Payload::StepEnd { reason } => {
            require_scope(event, true, true)?;
            validate_text(reason, "Step end reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::UserMessage { message } => {
            require_scope(event, true, true)?;
            validate_inbox_message(message)?;
        }
        Payload::AssistantChunk {
            request_id,
            text_delta,
            reasoning_delta,
            tool_call_delta,
            usage,
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_optional_stream_delta(text_delta.as_deref(), "assistant text delta")?;
            validate_optional_stream_delta(
                reasoning_delta.as_deref(),
                "assistant reasoning delta",
            )?;
            if let Some(delta) = tool_call_delta {
                validate_optional_text(delta.call_id.as_deref(), "tool call delta id")?;
                validate_optional_text(delta.name_delta.as_deref(), "tool call name delta")?;
                validate_optional_stream_delta(
                    delta.arguments_delta.as_deref(),
                    "tool call arguments delta",
                )?;
            }
            if text_delta.is_none()
                && reasoning_delta.is_none()
                && tool_call_delta.is_none()
                && usage.is_none()
            {
                return Err("assistant chunk must contain a delta or usage update".into());
            }
        }
        Payload::AssistantMessage {
            message_id,
            content,
            interrupted,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(message_id, "messageId")?;
            validate_collection_allow_empty(content, "assistant content blocks")?;
            if content.is_empty() && !interrupted {
                return Err("completed assistant message requires a content block".into());
            }
            for block in content {
                match block {
                    AgentAssistantContentBlock::Text { text } => {
                        validate_text(text, "assistant text block", false, MAX_AGENT_MESSAGE_BYTES)?
                    }
                    AgentAssistantContentBlock::Reasoning { text, .. } => validate_text(
                        text,
                        "assistant reasoning block",
                        false,
                        MAX_AGENT_MESSAGE_BYTES,
                    )?,
                    AgentAssistantContentBlock::ToolCall { call } => validate_tool_call(call)?,
                }
            }
        }
        Payload::RequestHeader {
            request_id,
            provider_id,
            model,
            reasoning_effort,
            series,
            system_prompt,
            tool_schemas,
            attempt,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_text(provider_id, "providerId", false, MAX_LABEL_BYTES)?;
            validate_text(model, "model", false, MAX_LABEL_BYTES)?;
            validate_optional_text(reasoning_effort.as_deref(), "reasoning effort")?;
            validate_identifier(&series.series_id, "seriesId")?;
            validate_text(
                system_prompt,
                "system prompt",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            validate_collection_allow_empty(tool_schemas, "request tool schemas")?;
            for schema in tool_schemas {
                validate_text(&schema.name, "tool schema name", false, MAX_LABEL_BYTES)?;
                validate_text(
                    &schema.description,
                    "tool schema description",
                    true,
                    MAX_AGENT_MESSAGE_BYTES,
                )?;
            }
            if *attempt == 0 {
                return Err("request attempt must be positive".into());
            }
            if series.request_index.saturating_add(1) != *attempt {
                return Err("request series index does not match its attempt".into());
            }
            if series.starts_series != (*attempt == 1) {
                return Err("request series boundary does not match its attempt".into());
            }
        }
        Payload::RequestContext { request_id, .. } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
        }
        Payload::RequestRetry {
            request_id,
            previous_request_id,
            attempt,
            reason,
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            if let Some(previous) = previous_request_id {
                validate_identifier(previous, "previousRequestId")?;
            }
            if *attempt == 0 {
                return Err("request retry attempt must be positive".into());
            }
            validate_text(reason, "request retry reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::RequestUsage { request_id, .. } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
        }
        Payload::ToolCall { call } => {
            require_scope(event, true, true)?;
            validate_tool_call(call)?;
        }
        Payload::ToolApproval {
            request_id,
            call_id,
            approval_id,
            reason,
            prompt,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(request_id, "requestId")?;
            validate_identifier(call_id, "callId")?;
            if let Some(approval) = approval_id {
                validate_identifier(approval, "approvalId")?;
            }
            validate_optional_text(reason.as_deref(), "approval reason")?;
            validate_optional_text(prompt.as_deref(), "approval prompt")?;
        }
        Payload::ToolExecution {
            call_id,
            idempotency,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(call_id, "callId")?;
            if !matches!(idempotency.as_str(), "yes" | "no" | "conditional") {
                return Err("tool execution idempotency is invalid".into());
            }
        }
        Payload::ToolResult {
            call_id,
            name,
            summary,
            evidence_refs,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(call_id, "callId")?;
            validate_text(name, "tool name", false, MAX_LABEL_BYTES)?;
            validate_text(
                summary,
                "tool result summary",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
            validate_collection_allow_empty(evidence_refs, "evidence refs")?;
            for evidence in evidence_refs {
                validate_identifier(evidence, "evidenceId")?;
            }
        }
        Payload::ContextArtifact {
            artifact_id,
            kind,
            title,
            media_type,
            sha256,
            ..
        } => {
            require_scope(event, true, true)?;
            validate_identifier(artifact_id, "artifactId")?;
            validate_text(kind, "artifact kind", false, MAX_LABEL_BYTES)?;
            validate_text(title, "artifact title", false, MAX_LABEL_BYTES)?;
            validate_optional_text(media_type.as_deref(), "artifact media type")?;
            if sha256.as_deref().is_some_and(|value| {
                value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) {
                return Err("artifact sha256 is invalid".into());
            }
        }
        Payload::CompactionStart { reason } => {
            require_scope(event, true, true)?;
            validate_text(reason, "compaction reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::CompactionSummary { summary, .. } => {
            require_scope(event, true, true)?;
            validate_text(
                summary,
                "compaction summary",
                false,
                MAX_AGENT_MESSAGE_BYTES,
            )?;
        }
        Payload::CompactionEnd { .. } => require_scope(event, true, true)?,
        Payload::SubagentDescriptor {
            descriptor_id,
            child_session_id,
            parent_session_id,
            parent_task_id,
            inheritance,
            capability_scope,
            target_scope,
            budget,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_identifier(parent_session_id, "parentSessionId")?;
            validate_identifier(parent_task_id, "parentTaskId")?;
            validate_subagent_inheritance(inheritance)?;
            validate_capability_scope(capability_scope)?;
            validate_collection(target_scope, "subagent target scope")?;
            for target in target_scope {
                validate_session_target(target)?;
            }
            validate_subagent_budget(budget)?;
        }
        Payload::SubagentMessage {
            descriptor_id,
            child_session_id,
            direction,
            route,
            summary,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            if !matches!(direction.as_str(), "inbound" | "outbound") {
                return Err("subagent message direction is invalid".into());
            }
            if !matches!(
                route.as_str(),
                "steer" | "followup" | "inject" | "toolResult"
            ) {
                return Err("subagent message route is invalid".into());
            }
            validate_text(summary, "subagent message", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
        Payload::SubagentSettled {
            descriptor_id,
            settlement_id,
            child_session_id,
            summary,
            evidence_refs,
            ..
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(settlement_id, "settlementId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_text(summary, "subagent summary", false, MAX_AGENT_MESSAGE_BYTES)?;
            validate_collection_allow_empty(evidence_refs, "subagent evidence refs")?;
            for evidence in evidence_refs {
                validate_identifier(evidence, "evidenceId")?;
            }
        }
        Payload::SubagentDetached {
            descriptor_id,
            child_session_id,
            reason,
        } => {
            require_scope(event, false, false)?;
            validate_identifier(descriptor_id, "descriptorId")?;
            validate_identifier(child_session_id, "childSessionId")?;
            validate_text(reason, "subagent detach reason", false, MAX_LABEL_BYTES)?;
        }
        Payload::TaskLinked { task_id, goal } => {
            validate_identifier(task_id, "taskId")?;
            if let Some(goal) = goal {
                validate_text(goal, "task goal", false, MAX_AGENT_MESSAGE_BYTES)?;
            }
        }
        Payload::TaskPlan { version, steps } => {
            if *version == 0 {
                return Err("task plan version must be positive".into());
            }
            validate_collection_allow_empty(steps, "plan steps")?;
            let mut ids = HashSet::new();
            for step in steps {
                validate_identifier(&step.id, "plan step id")?;
                if !ids.insert(step.id.as_str()) {
                    return Err("task plan contains duplicate step ids".into());
                }
                validate_text(&step.title, "plan step title", false, MAX_LABEL_BYTES)?;
                validate_optional_text(step.detail.as_deref(), "plan step detail")?;
                for evidence in &step.evidence_refs {
                    validate_identifier(evidence, "evidenceId")?;
                }
            }
        }
        Payload::TaskState {
            status,
            phase,
            progress,
            recovery,
            fleet,
        } => {
            validate_text(status, "task status", false, MAX_LABEL_BYTES)?;
            validate_optional_text(phase.as_deref(), "task phase")?;
            if progress.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                return Err("task progress must be finite and between zero and one".into());
            }
            if let Some(recovery) = recovery {
                validate_optional_text(recovery.summary.as_deref(), "recovery summary")?;
            }
            if fleet.as_ref().is_some_and(|value| {
                value.wave > value.total_waves || value.targets_completed > value.targets_total
            }) {
                return Err("task Fleet counters are invalid".into());
            }
            if let Some(fleet) = fleet {
                validate_optional_text(fleet.fleet_id.as_deref(), "Fleet id")?;
                validate_optional_text(fleet.status.as_deref(), "Fleet status")?;
                validate_collection_allow_empty(&fleet.targets, "Fleet targets")?;
                for target in &fleet.targets {
                    validate_identifier(&target.target_id, "Fleet targetId")?;
                    validate_identifier(&target.task_id, "Fleet taskId")?;
                    validate_text(
                        &target.goal,
                        "Fleet target goal",
                        false,
                        MAX_AGENT_MESSAGE_BYTES,
                    )?;
                    validate_text(&target.state, "Fleet target state", false, MAX_LABEL_BYTES)?;
                    validate_collection_allow_empty(
                        &target.child_session_ids,
                        "Fleet child Sessions",
                    )?;
                    validate_collection_allow_empty(&target.evidence_refs, "Fleet evidence")?;
                    validate_optional_text(target.recovery.as_deref(), "Fleet recovery")?;
                }
            }
        }
        Payload::TaskEvidence {
            evidence_id,
            kind,
            summary,
        } => {
            validate_identifier(evidence_id, "evidenceId")?;
            validate_text(kind, "evidence kind", false, MAX_LABEL_BYTES)?;
            validate_text(summary, "evidence summary", false, MAX_AGENT_MESSAGE_BYTES)?;
        }
    }
    Ok(())
}

fn require_scope(
    event: &AgentSessionEvent,
    require_turn: bool,
    require_step: bool,
) -> Result<(), String> {
    if require_turn != event.turn_id.is_some() || require_step != event.step_id.is_some() {
        return Err("Agent session event has an invalid Turn/Step scope".into());
    }
    Ok(())
}

fn validate_mutation_event_identity(
    event: &AgentSessionEvent,
    previous_revision: u64,
    client_operation_id: &str,
) -> Result<(), String> {
    if event.version != AGENT_SESSION_EVENT_VERSION {
        return Err("Agent Runtime mutation events require the v4 event contract".into());
    }
    if previous_revision != event.seq {
        return Err("Agent Runtime mutation previous revision does not match its sequence".into());
    }
    validate_identifier(client_operation_id, "clientOperationId")
}

fn validate_session_title(title: &str) -> Result<(), String> {
    validate_text(title, "Session title", false, MAX_SESSION_TITLE_BYTES)?;
    if title.trim() != title {
        return Err("Agent Session title must not contain leading or trailing whitespace".into());
    }
    if title.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(format!(
            "Agent Session title exceeds {MAX_SESSION_TITLE_CHARS} Unicode characters"
        ));
    }
    if title.chars().any(char::is_control) {
        return Err("Agent Session title must be a single line without control characters".into());
    }
    Ok(())
}

fn validate_inbox_message(message: &AgentInboxMessage) -> Result<(), String> {
    validate_identifier(&message.message_id, "messageId")?;
    if let Some(client_submission_id) = message.client_submission_id.as_deref() {
        validate_identifier(client_submission_id, "clientSubmissionId")?;
    }
    validate_text(
        &message.content,
        "message content",
        false,
        MAX_AGENT_MESSAGE_BYTES,
    )?;
    validate_text(
        &message.source.label,
        "message source label",
        false,
        MAX_LABEL_BYTES,
    )?;
    validate_text(
        &message.source.producer_id,
        "message source producer id",
        false,
        MAX_LABEL_BYTES,
    )?;
    Ok(())
}

fn validate_tool_call(call: &RecordedToolCall) -> Result<(), String> {
    validate_identifier(&call.call_id, "callId")?;
    if let Some(provider_call_id) = call.provider_call_id.as_deref() {
        validate_text(provider_call_id, "provider call id", false, MAX_LABEL_BYTES)?;
    }
    validate_text(&call.name, "tool name", false, MAX_LABEL_BYTES)?;
    validate_optional_text(call.native_name.as_deref(), "native tool name")?;
    validate_optional_text(call.title.as_deref(), "tool title")?;
    if let Some(target) = &call.target {
        validate_session_target(target)?;
    }
    Ok(())
}

fn validate_session_target(target: &AgentSessionTarget) -> Result<(), String> {
    if !matches!(target.kind.as_str(), "local" | "remote") {
        return Err("tool target kind is invalid".into());
    }
    validate_identifier(&target.target_id, "targetId")?;
    validate_identifier(&target.session_id, "target sessionId")?;
    validate_optional_text(target.label.as_deref(), "target label")?;
    if let Some(profile_id) = target.profile_id.as_deref() {
        validate_identifier(profile_id, "profileId")?;
    }
    validate_optional_text(target.host.as_deref(), "target host")?;
    validate_optional_text(target.username.as_deref(), "target username")?;
    validate_optional_text(target.cwd.as_deref(), "target cwd")?;
    validate_optional_text(target.root_path.as_deref(), "target root path")?;
    validate_optional_text(target.local_root.as_deref(), "target local root")?;
    match target.kind.as_str() {
        "local" if target.host.is_some() || target.port.is_some() || target.username.is_some() => {
            Err("local tool target contains remote identity fields".into())
        }
        "remote"
            if target.host.as_deref().is_none_or(str::is_empty)
                || target.port.is_none()
                || target.username.as_deref().is_none_or(str::is_empty) =>
        {
            Err("remote tool target is missing its frozen identity".into())
        }
        _ => Ok(()),
    }
}

fn validate_capability_scope(scope: &super::AgentCapabilityScope) -> Result<(), String> {
    validate_collection(&scope.tool_names, "capability tools")?;
    validate_collection(&scope.effects, "capability effects")?;
    validate_collection(&scope.target_ids, "capability targets")?;
    let mut tools = HashSet::new();
    let mut targets = HashSet::new();
    for tool in &scope.tool_names {
        validate_text(tool, "capability tool", false, MAX_LABEL_BYTES)?;
        if !tools.insert(tool) {
            return Err("capability scope contains duplicate tools".into());
        }
    }
    for target_id in &scope.target_ids {
        validate_identifier(target_id, "capability targetId")?;
        if !targets.insert(target_id) {
            return Err("capability scope contains duplicate targets".into());
        }
    }
    let mut effects = HashSet::new();
    if scope.effects.iter().any(|effect| !effects.insert(*effect)) {
        return Err("capability scope contains duplicate effects".into());
    }
    Ok(())
}

fn validate_subagent_inheritance(
    inheritance: &super::AgentSubagentInheritance,
) -> Result<(), String> {
    if let super::AgentSubagentInheritance::SafePrefix {
        parent_through_seq: Some(sequence),
    } = inheritance
    {
        if *sequence > MAX_JS_SAFE_INTEGER {
            return Err("subagent inheritance boundary exceeds the wire limit".into());
        }
    }
    Ok(())
}

fn validate_subagent_budget(budget: &super::AgentSubagentBudget) -> Result<(), String> {
    if budget.max_steps_per_turn == 0
        || budget.max_steps_per_turn > 64
        || budget.max_turns == 0
        || budget.max_turns > 256
        || budget.max_tool_calls == 0
        || budget.max_tool_calls > 4_096
        || budget.max_tokens < 1_024
        || budget.max_tokens > 16_000_000
        || budget.timeout_ms < 1_000
        || budget.timeout_ms > 24 * 60 * 60 * 1_000
    {
        return Err("subagent execution budget is outside native bounds".into());
    }
    Ok(())
}

fn validate_subagent_session(
    subagent: &AgentSubagentSession,
    parent_session_id: Option<&str>,
) -> Result<(), String> {
    validate_identifier(&subagent.descriptor_id, "descriptorId")?;
    validate_identifier(&subagent.parent_task_id, "parentTaskId")?;
    if parent_session_id.is_none() {
        return Err("subagent Session requires parentSessionId".into());
    }
    if subagent.depth == 0 || subagent.depth > 16 {
        return Err("subagent depth is outside native bounds".into());
    }
    validate_subagent_inheritance(&subagent.inheritance)?;
    validate_capability_scope(&subagent.capability_scope)?;
    validate_collection(&subagent.target_scope, "subagent target scope")?;
    for target in &subagent.target_scope {
        validate_session_target(target)?;
        if !subagent
            .capability_scope
            .target_ids
            .contains(&target.target_id)
        {
            return Err("subagent target scope exceeds its capability targets".into());
        }
    }
    validate_subagent_budget(&subagent.budget)?;
    validate_text(
        &subagent.provider.provider_id,
        "subagent providerId",
        false,
        MAX_LABEL_BYTES,
    )?;
    if !matches!(
        subagent.provider.provider_kind.as_str(),
        "ollama" | "openAi" | "openAiCompatible"
    ) {
        return Err("subagent provider kind is invalid".into());
    }
    validate_text(
        &subagent.provider.base_url,
        "subagent provider base URL",
        false,
        MAX_LABEL_BYTES,
    )?;
    validate_text(
        &subagent.provider.model,
        "subagent model",
        false,
        MAX_LABEL_BYTES,
    )?;
    validate_optional_text(
        subagent.provider.reasoning_effort.as_deref(),
        "subagent reasoning effort",
    )
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

fn write_new_log(
    root: &Path,
    session_id: &str,
    events: &[AgentSessionEvent],
) -> Result<(), String> {
    let encoded = encoded_events(events)?;
    if encoded.len() as u64 > MAX_SESSION_LOG_BYTES
        || total_log_bytes(root)?.saturating_add(encoded.len() as u64) > MAX_TOTAL_SESSION_LOG_BYTES
    {
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
    events: &[AgentSessionEvent],
) -> Result<(), String> {
    let encoded = encoded_events(events)?;
    let path = session_path(root, session_id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect Agent session log: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("Agent session log is not a regular file".into());
    }
    let original_len = metadata.len();
    if original_len.saturating_add(encoded.len() as u64) > MAX_SESSION_LOG_BYTES
        || total_log_bytes(root)?.saturating_add(encoded.len() as u64) > MAX_TOTAL_SESSION_LOG_BYTES
    {
        return Err("Agent session store exceeds its storage boundary".into());
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open Agent session log: {error}"))?;
    restrict_open_file(&file)?;
    if let Err(error) = file.write_all(&encoded).and_then(|()| file.sync_data()) {
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

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!(
            "{label} must be 1-{MAX_IDENTIFIER_BYTES} ASCII letters, digits, '-' or '_'"
        ));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    label: &str,
    allow_empty: bool,
    max_bytes: usize,
) -> Result<(), String> {
    if (!allow_empty && value.trim().is_empty()) || value.len() > max_bytes {
        return Err(format!("{label} is invalid or exceeds {max_bytes} bytes"));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, label, false, MAX_LABEL_BYTES)?;
    }
    Ok(())
}

fn validate_optional_stream_delta(value: Option<&str>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        // Stream boundaries are provider-controlled. A valid JSON argument stream may
        // contain an empty, whitespace-only, or newline-only delta, so only enforce the
        // durable event byte bound here. Semantic validation happens after reassembly.
        if value.len() > MAX_AGENT_STREAM_DELTA_BYTES {
            return Err(format!(
                "{label} exceeds {MAX_AGENT_STREAM_DELTA_BYTES} bytes"
            ));
        }
    }
    Ok(())
}

fn validate_collection<T>(values: &[T], label: &str) -> Result<(), String> {
    if values.is_empty() || values.len() > MAX_COLLECTION_ITEMS {
        return Err(format!(
            "{label} must contain 1-{MAX_COLLECTION_ITEMS} items"
        ));
    }
    Ok(())
}

fn validate_collection_allow_empty<T>(values: &[T], label: &str) -> Result<(), String> {
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err(format!("{label} exceeds {MAX_COLLECTION_ITEMS} items"));
    }
    Ok(())
}

fn validate_page_limit(limit: usize, maximum: usize, label: &str) -> Result<(), String> {
    if limit == 0 || limit > maximum {
        return Err(format!("Agent {label} page limit must be 1-{maximum}"));
    }
    Ok(())
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
            publisher(event);
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
    use super::*;

    #[test]
    fn stream_delta_validation_accepts_provider_whitespace_but_rejects_oversized_chunks() {
        assert_eq!(validate_optional_stream_delta(None, "stream delta"), Ok(()));
        assert_eq!(
            validate_optional_stream_delta(Some(""), "stream delta"),
            Ok(())
        );
        assert_eq!(
            validate_optional_stream_delta(Some(" \r\n\t"), "stream delta"),
            Ok(())
        );
        assert_eq!(
            validate_optional_stream_delta(
                Some(&"x".repeat(MAX_AGENT_STREAM_DELTA_BYTES)),
                "stream delta",
            ),
            Ok(())
        );
        assert_eq!(
            validate_optional_stream_delta(
                Some(&"x".repeat(MAX_AGENT_STREAM_DELTA_BYTES + 1)),
                "stream delta",
            ),
            Err(format!(
                "stream delta exceeds {MAX_AGENT_STREAM_DELTA_BYTES} bytes"
            ))
        );
    }

    fn configured() -> (tempfile::TempDir, AgentSessionStore) {
        let root = tempfile::tempdir().unwrap();
        let store = AgentSessionStore::default();
        store.configure(root.path().to_path_buf()).unwrap();
        (root, store)
    }

    fn create(store: &AgentSessionStore) {
        store
            .create(CreateAgentSessionRequest {
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                goal: "Inspect nginx".into(),
                parent_session_id: None,
                target: None,
                permission_mode: None,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
    }

    fn message(id: &str, content: &str) -> AgentInboxMessage {
        AgentInboxMessage {
            message_id: id.into(),
            client_submission_id: Some(id.into()),
            content: content.into(),
            source: AgentMessageSource::user(),
        }
    }

    fn log_path(root: &tempfile::TempDir) -> PathBuf {
        root.path()
            .join("agent-runtime/sessions-v4/session-1.jsonl")
    }

    fn target() -> AgentSessionTarget {
        AgentSessionTarget {
            kind: "local".into(),
            target_id: "target-1".into(),
            session_id: "terminal-1".into(),
            label: None,
            profile_id: None,
            host: None,
            port: None,
            username: None,
            cwd: Some("/tmp".into()),
            root_path: None,
            local_root: Some("/tmp".into()),
        }
    }

    fn child_request() -> (CreateAgentSessionRequest, AgentSessionEventPayload) {
        let scope = super::super::AgentCapabilityScope {
            tool_names: vec!["read_file".into()],
            effects: vec![super::super::AgentSessionEffect::ReadOnly],
            target_ids: vec!["target-1".into()],
        };
        let budget = super::super::AgentSubagentBudget {
            max_steps_per_turn: 4,
            max_turns: 1,
            max_tool_calls: 8,
            max_tokens: 8_192,
            timeout_ms: 60_000,
        };
        let metadata = AgentSubagentSession {
            descriptor_id: "descriptor-1".into(),
            parent_task_id: "task-1".into(),
            role: super::super::AgentSubagentRole::Explorer,
            continuable: false,
            depth: 1,
            inheritance: super::super::AgentSubagentInheritance::Blank,
            capability_scope: scope.clone(),
            target_scope: vec![target()],
            budget: budget.clone(),
            provider: super::super::AgentSubagentModel {
                provider_id: "provider-1".into(),
                provider_kind: "ollama".into(),
                base_url: "http://127.0.0.1:11434".into(),
                model: "test".into(),
                reasoning_effort: None,
                requires_api_key: false,
            },
        };
        (
            CreateAgentSessionRequest {
                session_id: "child-1".into(),
                task_id: "child-task-1".into(),
                goal: "inspect".into(),
                parent_session_id: Some("session-1".into()),
                target: Some(target()),
                permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
                success_criteria: Vec::new(),
                capability_scope: Some(scope.clone()),
                subagent: Some(metadata),
            },
            AgentSessionEventPayload::SubagentDescriptor {
                descriptor_id: "descriptor-1".into(),
                child_session_id: "child-1".into(),
                parent_session_id: "session-1".into(),
                parent_task_id: "task-1".into(),
                role: super::super::AgentSubagentRole::Explorer,
                continuable: false,
                depth: 1,
                inheritance: super::super::AgentSubagentInheritance::Blank,
                capability_scope: scope,
                target_scope: vec![target()],
                budget,
            },
        )
    }

    #[test]
    fn child_session_and_parent_descriptor_are_committed_together() {
        let (_root, store) = configured();
        store
            .create(CreateAgentSessionRequest {
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                goal: "parent".into(),
                parent_session_id: None,
                target: Some(target()),
                permission_mode: Some(AgentSessionPermissionMode::RequestApproval),
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        let (request, descriptor) = child_request();
        store
            .create_child_with_descriptor("session-1", request, descriptor)
            .unwrap();
        assert_eq!(
            store
                .snapshot("child-1")
                .unwrap()
                .header
                .parent_session_id
                .as_deref(),
            Some("session-1")
        );
        assert!(store
            .all_events("session-1")
            .unwrap()
            .iter()
            .any(|event| matches!(event.payload, AgentSessionEventPayload::SubagentDescriptor { ref child_session_id, .. } if child_session_id == "child-1")));
    }

    #[test]
    fn append_is_durable_sequential_redacted_and_published_after_commit() {
        let (root, store) = configured();
        let published = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&published);
        store
            .set_publisher(Arc::new(move |event| {
                observed.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        create(&store);
        let snapshot = store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("message-1", "Authorization: Bearer plaintext-secret"),
            )
            .unwrap();
        assert_eq!(snapshot.event_count, 3);
        assert_eq!(snapshot.inbox.next_turn[0].content, "[REDACTED]");
        assert_eq!(published.lock().unwrap().len(), 3);

        let recovered = AgentSessionStore::default();
        recovered.configure(root.path().to_path_buf()).unwrap();
        let page = recovered
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        let encoded = fs::read_to_string(log_path(&root)).unwrap();
        assert!(!encoded.contains("plaintext-secret"));
        assert!(encoded.contains("\"taskId\""));
        assert!(encoded.contains("\"messageId\""));
    }

    #[test]
    fn committed_event_backfill_uses_exclusive_after_seq() {
        let (_root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("message-1", "inspect"),
            )
            .unwrap();
        let page = store
            .committed_events_page(AgentCommittedEventsRequest {
                session_id: "session-1".into(),
                after_seq: Some(1),
                limit: 16,
            })
            .unwrap();
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[test]
    fn ended_logs_archive_as_read_only_and_reload_from_the_archive_root() {
        let (root, store) = configured();
        create(&store);
        store.cancel("session-1").unwrap();
        let archived = store.archive("session-1").unwrap();
        assert!(archived.archived);
        assert!(!log_path(&root).exists());
        assert!(root
            .path()
            .join("agent-runtime/archives-v4/session-1.jsonl")
            .is_file());
        assert!(store
            .append(
                "session-1",
                None,
                None,
                AgentSessionEventPayload::TaskEvidence {
                    evidence_id: "late".into(),
                    kind: "invalid".into(),
                    summary: "must not append".into(),
                },
            )
            .is_err());

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert!(restarted.snapshot("session-1").unwrap().archived);
    }

    #[test]
    fn previous_namespaces_remain_byte_for_byte_isolated() {
        let root = tempfile::tempdir().unwrap();
        let previous_root = root.path().join("agent-runtime/sessions-v2");
        fs::create_dir_all(&previous_root).unwrap();
        let previous_path = previous_root.join("session-previous.jsonl");
        let sentinel = b"{\"version\":3,\"sessionId\":\"session-previous\"}\n";
        fs::write(&previous_path, sentinel).unwrap();

        let store = AgentSessionStore::default();
        store.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(fs::read(&previous_path).unwrap(), sentinel);
        assert!(store.snapshot("session-previous").is_err());
        assert!(root.path().join("agent-runtime/sessions-v4").is_dir());
    }

    #[test]
    fn restart_preserves_fifo_claims_and_message_id_tombstones() {
        let (root, store) = configured();
        create(&store);
        for id in ["turn-1", "turn-2"] {
            store
                .enqueue("session-1", AgentInboxLane::NextTurn, message(id, id))
                .unwrap();
        }
        for id in ["step-1", "step-2"] {
            store
                .enqueue("session-1", AgentInboxLane::NextStep, message(id, id))
                .unwrap();
        }
        assert_eq!(
            store.claim_turn("session-1").unwrap()[0].message_id,
            "turn-1"
        );
        assert_eq!(store.claim_step("session-1").unwrap().len(), 2);

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(
            restarted.snapshot("session-1").unwrap().inbox.next_turn[0].message_id,
            "turn-2"
        );
        assert!(restarted
            .enqueue(
                "session-1",
                AgentInboxLane::NextStep,
                message("turn-1", "reuse")
            )
            .is_err());
    }

    #[test]
    fn append_failure_does_not_update_memory_or_publish() {
        let (root, store) = configured();
        create(&store);
        let published = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&published);
        store
            .set_publisher(Arc::new(move |event| {
                observed.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        let path = log_path(&root);
        fs::rename(&path, path.with_extension("saved")).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("message-failed", "must not appear"),
            )
            .is_err());
        let snapshot = store.snapshot("session-1").unwrap();
        assert_eq!(snapshot.event_count, 2);
        assert!(snapshot.inbox.next_turn.is_empty());
        assert!(published.lock().unwrap().is_empty());
    }

    #[test]
    fn inbox_update_remove_and_reorder_commit_with_expected_revision() {
        let (root, store) = configured();
        create(&store);
        for (id, lane) in [
            ("turn-a", AgentInboxLane::NextTurn),
            ("turn-b", AgentInboxLane::NextTurn),
            ("step-a", AgentInboxLane::NextStep),
        ] {
            store.enqueue("session-1", lane, message(id, id)).unwrap();
        }

        let reordered = store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 5,
                client_operation_id: "reorder-1".into(),
                mutation: AgentInboxMutation::Reorder {
                    lane: AgentInboxLane::NextTurn,
                    ordered_item_ids: vec!["turn-b".into(), "turn-a".into()],
                },
            })
            .unwrap();
        assert_eq!(reordered.event_count, 6);
        assert_eq!(reordered.inbox.next_turn[0].message_id, "turn-b");

        let updated = store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 6,
                client_operation_id: "update-1".into(),
                mutation: AgentInboxMutation::Update {
                    item_id: "turn-b".into(),
                    content: "updated text".into(),
                },
            })
            .unwrap();
        assert_eq!(updated.inbox.next_turn[0].content, "updated text");

        let removed = store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 7,
                client_operation_id: "remove-1".into(),
                mutation: AgentInboxMutation::Remove {
                    item_id: "turn-a".into(),
                },
            })
            .unwrap();
        assert_eq!(removed.event_count, 8);
        assert_eq!(removed.inbox.next_turn.len(), 1);
        assert_eq!(removed.inbox.next_step[0].message_id, "step-a");
        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let replayed = restarted.snapshot("session-1").unwrap();
        assert_eq!(replayed.inbox.next_turn[0].message_id, "turn-b");
        assert_eq!(replayed.inbox.next_turn[0].content, "updated text");
    }

    #[test]
    fn inbox_mutations_reject_conflicts_claimed_missing_and_terminal_items() {
        let (_root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("turn-a", "queued"),
            )
            .unwrap();

        let conflict = store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 2,
                client_operation_id: "conflict-1".into(),
                mutation: AgentInboxMutation::Remove {
                    item_id: "turn-a".into(),
                },
            })
            .unwrap_err();
        assert!(conflict.contains("current revision 3"));

        store.claim_turn("session-1").unwrap();
        let claimed_revision = store.snapshot("session-1").unwrap().event_count;
        assert!(store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: claimed_revision,
                client_operation_id: "claimed-1".into(),
                mutation: AgentInboxMutation::Update {
                    item_id: "turn-a".into(),
                    content: "late".into(),
                },
            })
            .unwrap_err()
            .contains("no longer queued"));
        assert!(store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: claimed_revision,
                client_operation_id: "missing-1".into(),
                mutation: AgentInboxMutation::Remove {
                    item_id: "missing".into(),
                },
            })
            .unwrap_err()
            .contains("not found"));

        store.cancel("session-1").unwrap();
        let terminal_revision = store.snapshot("session-1").unwrap().event_count;
        assert!(store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: terminal_revision,
                client_operation_id: "terminal-1".into(),
                mutation: AgentInboxMutation::Reorder {
                    lane: AgentInboxLane::NextTurn,
                    ordered_item_ids: Vec::new(),
                },
            })
            .unwrap_err()
            .contains("terminal"));
        assert!(store
            .rename(AgentSessionRenameInput {
                session_id: "session-1".into(),
                expected_revision: terminal_revision,
                client_operation_id: "rename-terminal".into(),
                title: "Too late".into(),
            })
            .unwrap_err()
            .contains("terminal"));
    }

    #[test]
    fn mutation_persistence_failure_keeps_snapshot_and_publish_unchanged() {
        let (root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("turn-a", "before"),
            )
            .unwrap();
        let published = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&published);
        store
            .set_publisher(Arc::new(move |event| {
                observed.lock().unwrap().push(event.clone());
            }))
            .unwrap();
        let path = log_path(&root);
        fs::rename(&path, path.with_extension("saved")).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 3,
                client_operation_id: "update-failed".into(),
                mutation: AgentInboxMutation::Update {
                    item_id: "turn-a".into(),
                    content: "after".into(),
                },
            })
            .is_err());
        let snapshot = store.snapshot("session-1").unwrap();
        assert_eq!(snapshot.event_count, 3);
        assert_eq!(snapshot.inbox.next_turn[0].content, "before");
        assert!(published.lock().unwrap().is_empty());
    }

    #[test]
    fn mutation_publish_observes_the_already_committed_log() {
        let (root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("turn-a", "before"),
            )
            .unwrap();
        let observed = Arc::new(Mutex::new(false));
        let callback_observed = Arc::clone(&observed);
        let path = log_path(&root);
        store
            .set_publisher(Arc::new(move |event| {
                if matches!(
                    event.payload,
                    AgentSessionEventPayload::InboxItemUpdated { .. }
                ) {
                    let encoded = fs::read_to_string(&path).unwrap();
                    *callback_observed.lock().unwrap() = encoded.contains("update-committed");
                }
            }))
            .unwrap();
        store
            .mutate_inbox(AgentInboxMutationInput {
                session_id: "session-1".into(),
                expected_revision: 3,
                client_operation_id: "update-committed".into(),
                mutation: AgentInboxMutation::Update {
                    item_id: "turn-a".into(),
                    content: "after".into(),
                },
            })
            .unwrap();
        assert!(*observed.lock().unwrap());
    }

    #[test]
    fn client_submission_ids_are_idempotent_per_session_and_survive_restart() {
        let (root, store) = configured();
        create(&store);
        let first = store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("submission-1", "inspect"),
            )
            .unwrap();
        let retry = store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("submission-1", "inspect"),
            )
            .unwrap();
        assert_eq!(retry.event_count, first.event_count);
        assert!(store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("submission-1", "different"),
            )
            .is_err());

        store
            .create(CreateAgentSessionRequest {
                session_id: "session-2".into(),
                task_id: "task-2".into(),
                goal: "Other".into(),
                parent_session_id: None,
                target: None,
                permission_mode: None,
                success_criteria: Vec::new(),
                capability_scope: None,
                subagent: None,
            })
            .unwrap();
        assert_eq!(
            store
                .enqueue(
                    "session-2",
                    AgentInboxLane::NextTurn,
                    message("submission-1", "independent"),
                )
                .unwrap()
                .inbox
                .next_turn
                .len(),
            1
        );

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        let recovered = restarted.snapshot("session-1").unwrap();
        assert_eq!(
            recovered.inbox.next_turn[0].client_submission_id.as_deref(),
            Some("submission-1")
        );
        assert_eq!(
            restarted
                .enqueue(
                    "session-1",
                    AgentInboxLane::NextTurn,
                    message("submission-1", "inspect"),
                )
                .unwrap()
                .event_count,
            recovered.event_count
        );
    }

    #[test]
    fn rename_is_durable_and_task_goal_cannot_override_the_manual_title() {
        let (root, store) = configured();
        create(&store);
        let renamed = store
            .rename(AgentSessionRenameInput {
                session_id: "session-1".into(),
                expected_revision: 2,
                client_operation_id: "rename-1".into(),
                title: "  手动标题  ".into(),
            })
            .unwrap();
        assert_eq!(renamed.header.title.as_deref(), Some("手动标题"));
        assert_eq!(renamed.header.goal, "Inspect nginx");
        store
            .append(
                "session-1",
                None,
                None,
                AgentSessionEventPayload::TaskLinked {
                    task_id: "task-1".into(),
                    goal: Some("Automatic title candidate".into()),
                },
            )
            .unwrap();
        assert_eq!(
            store.snapshot("session-1").unwrap().header.title.as_deref(),
            Some("手动标题")
        );

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(
            restarted
                .snapshot("session-1")
                .unwrap()
                .header
                .title
                .as_deref(),
            Some("手动标题")
        );
    }

    #[test]
    fn oversized_event_is_rejected_before_persistence() {
        let (_root, store) = configured();
        create(&store);
        let oversized = "x".repeat(MAX_SESSION_EVENT_BYTES);
        assert!(store
            .append(
                "session-1",
                Some("turn-1".into()),
                Some("step-1".into()),
                AgentSessionEventPayload::ToolResult {
                    call_id: "call-1".into(),
                    name: "inspect".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Completed,
                    summary: "bounded summary".into(),
                    data: Some(serde_json::json!({ "output": oversized })),
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                },
            )
            .is_err());
        assert_eq!(store.snapshot("session-1").unwrap().event_count, 2);
    }

    #[test]
    fn cancel_discards_both_lanes_before_the_terminal_event() {
        let (_root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("turn-1", "turn"),
            )
            .unwrap();
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextStep,
                message("step-1", "step"),
            )
            .unwrap();
        let snapshot = store.cancel("session-1").unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Cancelled);
        assert!(snapshot.inbox.next_turn.is_empty());
        assert!(snapshot.inbox.next_step.is_empty());
        let page = store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 32,
            })
            .unwrap();
        let operations = page
            .events
            .iter()
            .filter_map(|event| match event.payload {
                AgentSessionEventPayload::InboxSpliced { operation, .. } => Some(operation),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            operations,
            vec![
                AgentInboxOperation::Enqueued,
                AgentInboxOperation::Enqueued,
                AgentInboxOperation::Discarded,
                AgentInboxOperation::Discarded,
            ]
        );
        assert!(store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("late", "late")
            )
            .is_err());
    }

    #[test]
    fn ending_requires_an_empty_inbox_and_one_complete_terminal_transition() {
        let (_root, store) = configured();
        create(&store);
        store
            .enqueue(
                "session-1",
                AgentInboxLane::NextTurn,
                message("turn-1", "pending"),
            )
            .unwrap();
        assert!(store
            .append(
                "session-1",
                None,
                None,
                AgentSessionEventPayload::SessionEnded {
                    status: AgentSessionStatus::Completed,
                    reason: None,
                },
            )
            .is_err());
        store.claim_turn("session-1").unwrap();
        store
            .append(
                "session-1",
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Completed,
                    reason: None,
                },
            )
            .unwrap();
        assert!(!store.snapshot("session-1").unwrap().ended);
        let snapshot = store
            .end("session-1", AgentSessionStatus::Completed, None)
            .unwrap();
        assert!(snapshot.ended);
        assert_eq!(snapshot.status, AgentSessionStatus::Completed);
    }

    #[test]
    fn startup_discards_and_audits_only_an_uncommitted_bad_tail() {
        let (root, store) = configured();
        create(&store);
        let path = log_path(&root);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(br#"{"version":1,"sessionId":"session-1""#)
            .unwrap();
        drop(store);

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(restarted.snapshot("session-1").unwrap().event_count, 2);
        let list = restarted
            .list_page(AgentSessionListRequest {
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(list.recovery_notices.len(), 1);
        assert_eq!(
            list.recovery_notices[0].action,
            AgentSessionRecoveryAction::BadTailDiscarded
        );
        assert!(root
            .path()
            .join("agent-runtime/sessions-v4")
            .read_dir()
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("bad-tail")));
    }

    #[test]
    fn startup_quarantines_complete_corruption_without_hiding_the_notice() {
        let (root, store) = configured();
        create(&store);
        OpenOptions::new()
            .append(true)
            .open(log_path(&root))
            .unwrap()
            .write_all(b"not-json\n")
            .unwrap();
        drop(store);

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert!(restarted.snapshot("session-1").is_err());
        let list = restarted
            .list_page(AgentSessionListRequest {
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(list.sessions.len(), 0);
        assert_eq!(
            list.recovery_notices[0].action,
            AgentSessionRecoveryAction::CorruptLogQuarantined
        );
    }

    #[test]
    fn strict_replay_rejects_sequence_version_identity_and_timestamp_drift() {
        let base = vec![
            AgentSessionEvent::new(
                "session-1".into(),
                0,
                1_000,
                None,
                None,
                AgentSessionEventPayload::SessionCreated {
                    task_id: "task-1".into(),
                    goal: "goal".into(),
                    parent_session_id: None,
                    target: None,
                    permission_mode: None,
                    success_criteria: Vec::new(),
                    capability_scope: None,
                    subagent: None,
                },
            ),
            AgentSessionEvent::new(
                "session-1".into(),
                1,
                1_001,
                None,
                None,
                AgentSessionEventPayload::AgentCreated {
                    agent_id: "session-1".into(),
                    parent_agent_id: None,
                },
            ),
        ];
        for mutation in ["seq", "version", "identity", "timestamp"] {
            let mut events = base.clone();
            match mutation {
                "seq" => events[1].seq = 2,
                "version" => events[1].version = 99,
                "identity" => events[1].session_id = "session-2".into(),
                "timestamp" => events[1].time_unix_ms = 999,
                _ => unreachable!(),
            }
            assert!(
                AgentSessionRecord::from_events(events).is_err(),
                "{mutation}"
            );
        }
    }

    #[test]
    fn pagination_cursors_and_limits_are_bounded() {
        let (_root, store) = configured();
        create(&store);
        for index in 0..3 {
            store
                .enqueue(
                    "session-1",
                    AgentInboxLane::NextTurn,
                    message(&format!("message-{index}"), "queued"),
                )
                .unwrap();
        }
        let first = store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 2,
            })
            .unwrap();
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.next_cursor, Some(2));
        let second = store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: first.next_cursor,
                limit: 10,
            })
            .unwrap();
        assert_eq!(second.events[0].seq, 2);
        assert!(store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: Some(99),
                limit: 1,
            })
            .is_err());
        assert!(store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 0,
            })
            .is_err());
    }

    #[test]
    fn compaction_advances_one_generation_and_keeps_raw_events() {
        let (_root, store) = configured();
        create(&store);
        store
            .append(
                "session-1",
                Some("turn-1".into()),
                None,
                AgentSessionEventPayload::TurnStart,
            )
            .unwrap();
        store
            .append(
                "session-1",
                Some("turn-1".into()),
                Some("step-1".into()),
                AgentSessionEventPayload::StepStart,
            )
            .unwrap();
        store
            .append(
                "session-1",
                Some("turn-1".into()),
                Some("step-1".into()),
                AgentSessionEventPayload::UserMessage {
                    message: message("surface-user", "old model-visible content"),
                },
            )
            .unwrap();
        store
            .append(
                "session-1",
                Some("turn-1".into()),
                Some("step-1".into()),
                AgentSessionEventPayload::StepEnd {
                    reason: "completed".into(),
                },
            )
            .unwrap();
        let turn_end = store
            .append(
                "session-1",
                Some("turn-1".into()),
                None,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            )
            .unwrap();
        store
            .append(
                "session-1",
                Some("turn-2".into()),
                Some("step-2".into()),
                AgentSessionEventPayload::CompactionSummary {
                    summary: "bounded summary".into(),
                    replaced_through_seq: turn_end.seq,
                    surface_generation: 1,
                },
            )
            .unwrap();
        store
            .append(
                "session-1",
                Some("turn-2".into()),
                Some("step-2".into()),
                AgentSessionEventPayload::CompactionEnd {
                    surface_generation: 1,
                    replaced_through_seq: turn_end.seq,
                    status: crate::agent_runtime::AgentCompactionStatus::Completed,
                },
            )
            .unwrap();

        let snapshot = store.snapshot("session-1").unwrap();
        assert_eq!(snapshot.surface.generation, 1);
        assert_eq!(snapshot.surface.replaced_through_seq, Some(turn_end.seq));
        assert!(matches!(
            &snapshot.surface.messages[0],
            crate::agent_runtime::AgentSurfaceMessage::User { content, .. }
                if content == "bounded summary"
        ));
        let raw = store
            .events_page(AgentSessionEventsRequest {
                session_id: "session-1".into(),
                cursor: None,
                limit: 32,
            })
            .unwrap();
        assert!(raw.events.iter().any(|event| matches!(
            &event.payload,
            AgentSessionEventPayload::UserMessage { message }
                if message.content == "old model-visible content"
        )));
        let count_before = snapshot.event_count;
        assert!(store
            .append(
                "session-1",
                Some("turn-2".into()),
                Some("step-2".into()),
                AgentSessionEventPayload::CompactionSummary {
                    summary: "invalid generation".into(),
                    replaced_through_seq: turn_end.seq,
                    surface_generation: 3,
                },
            )
            .is_err());
        assert_eq!(
            store.snapshot("session-1").unwrap().event_count,
            count_before
        );
    }

    #[cfg(unix)]
    #[test]
    fn persisted_directories_and_logs_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let (root, store) = configured();
        create(&store);
        assert_eq!(
            fs::metadata(root.path().join("agent-runtime/sessions-v4"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(log_path(&root)).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_quarantines_log_symlinks_without_following_them() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let first = AgentSessionStore::default();
        first.configure(root.path().to_path_buf()).unwrap();
        drop(first);
        let external = root.path().join("external.txt");
        fs::write(&external, b"external").unwrap();
        fs::set_permissions(&external, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(
            &external,
            root.path()
                .join("agent-runtime/sessions-v4/session-link.jsonl"),
        )
        .unwrap();

        let restarted = AgentSessionStore::default();
        restarted.configure(root.path().to_path_buf()).unwrap();
        assert_eq!(
            fs::metadata(&external).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let page = restarted
            .list_page(AgentSessionListRequest {
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(
            page.recovery_notices[0].action,
            AgentSessionRecoveryAction::CorruptLogQuarantined
        );
    }
}
