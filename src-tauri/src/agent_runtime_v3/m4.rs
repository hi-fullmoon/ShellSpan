use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::agent_contract_v3::{
    AgentEffectKindV3, AgentNetworkDestinationV3, AgentObservedEffectV3, AgentPermissionModeV3,
    AgentRequestV3, AgentToolCallV3, AgentToolResultStatusV3, AgentToolResultV3, AgentToolTargetV3,
    ApplyPatchArgumentsV3, ListDirectoryArgumentsV3, PlanStepStatusV3, ReadFileArgumentsV3,
    SearchTextArgumentsV3, TransferFileArgumentsV3,
};
use crate::keychain::CredentialManager;
use crate::redaction::redact_sensitive_text;

use super::{AgentPlanV3, RegisteredToolV3, ToolImplementationStateV3};

const STORE_VERSION: u16 = 1;
const MAX_STORE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PERSISTED_TASKS: usize = 128;
const MAX_CALLS_PER_TASK: usize = 512;
const MAX_NOTIFICATIONS: usize = 256;
const MAX_AUDIT_ENTRIES: usize = 1024;
const MAX_OPERATOR_TTL_MS: u64 = 30 * 60 * 1_000;
const MAX_BROKER_TTL_MS: u64 = 5 * 60 * 1_000;
const OPERATOR_EXPIRY_NOTICE_MS: u64 = 60_000;
pub(crate) const REMOTE_PROFILE_BROKER_SERVICE: &str = "com.shellspan.remote-profile";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecoveryDispositionV3 {
    SafeToResume,
    NeedsReconciliation,
    Lost,
    Cancelled,
    Completed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskPhaseV3 {
    Planning,
    Running,
    WaitingApproval,
    WaitingExternal,
    Verifying,
    Reconciliation,
    Completed,
    Failed,
    Cancelled,
    Lost,
}

fn default_task_phase() -> TaskPhaseV3 {
    TaskPhaseV3::Planning
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecoveryCallStateV3 {
    Started,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryCallV3 {
    pub(crate) call_id: String,
    pub(crate) tool_name: String,
    pub(crate) target_id: String,
    pub(crate) effect: AgentEffectKindV3,
    pub(crate) state: RecoveryCallStateV3,
    pub(crate) started_at_unix_ms: u64,
    pub(crate) updated_at_unix_ms: u64,
    pub(crate) automatic_replay_allowed: bool,
    #[serde(default)]
    pub(crate) network_destinations: Vec<AgentNetworkDestinationV3>,
    #[serde(default)]
    pub(crate) sensitive_path_count: usize,
    #[serde(default)]
    pub(crate) critical_path_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveredProcessV3 {
    pub(crate) process_handle: String,
    pub(crate) target_id: String,
    pub(crate) owner_target_id: String,
    pub(crate) channel: String,
    pub(crate) state: String,
    pub(crate) started_at_unix_ms: u64,
    pub(crate) updated_at_unix_ms: u64,
    pub(crate) recovery_advice: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskRecoverySnapshotV3 {
    pub(crate) disposition: RecoveryDispositionV3,
    pub(crate) phase: TaskPhaseV3,
    pub(crate) progress_completed: usize,
    pub(crate) progress_total: usize,
    pub(crate) calls: Vec<RecoveryCallV3>,
    pub(crate) processes: Vec<RecoveredProcessV3>,
    pub(crate) recovery_advice: String,
    pub(crate) requires_human_action: bool,
    pub(crate) requires_session_rebind: bool,
    pub(crate) last_failure: Option<String>,
    pub(crate) last_effect: Option<AgentObservedEffectV3>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NotificationKindV3 {
    Completed,
    Failed,
    HumanActionRequired,
    OperatorExpiring,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentNotificationV3 {
    pub(crate) notification_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) kind: NotificationKindV3,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) delivered: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentAuditEventV3 {
    pub(crate) event_id: String,
    pub(crate) action: String,
    pub(crate) task_id: Option<String>,
    pub(crate) target_id: Option<String>,
    pub(crate) tool_name: Option<String>,
    pub(crate) effect: Option<AgentEffectKindV3>,
    pub(crate) network_destinations: Vec<AgentNetworkDestinationV3>,
    pub(crate) sensitive_path_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) scope_target_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) scope_tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) scope_effects: Vec<AgentEffectKindV3>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) scope_path_count: usize,
    pub(crate) decision: String,
    pub(crate) recorded_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryStoreStatusV3 {
    pub(crate) format_version: u16,
    pub(crate) loaded: bool,
    pub(crate) migrated: bool,
    pub(crate) task_count: usize,
    pub(crate) corruption_recovered: bool,
    pub(crate) warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedTaskV3 {
    pub(crate) request: AgentRequestV3,
    pub(crate) state: String,
    #[serde(default = "default_task_phase")]
    pub(crate) phase: TaskPhaseV3,
    pub(crate) sequence: u64,
    pub(crate) results: Vec<AgentToolResultV3>,
    pub(crate) plan: Option<AgentPlanV3>,
    pub(crate) calls: Vec<RecoveryCallV3>,
    pub(crate) processes: Vec<RecoveredProcessV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_failure: Option<String>,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistenceEnvelopeV3 {
    version: u16,
    written_at_unix_ms: u64,
    tasks: Vec<PersistedTaskV3>,
    notifications: Vec<AgentNotificationV3>,
    audit: Vec<AgentAuditEventV3>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistenceEnvelopeV0 {
    #[serde(rename = "version")]
    _version: u16,
    tasks: Vec<PersistedTaskV3>,
}

#[derive(Debug, Clone, Default)]
struct PersistenceStateV3 {
    root: Option<PathBuf>,
    tasks: HashMap<String, PersistedTaskV3>,
    notifications: Vec<AgentNotificationV3>,
    audit: Vec<AgentAuditEventV3>,
    status: Option<RecoveryStoreStatusV3>,
}

#[derive(Clone, Default)]
pub(crate) struct M4PersistenceV3 {
    inner: Arc<Mutex<PersistenceStateV3>>,
}

impl M4PersistenceV3 {
    pub(crate) fn configure(&self, app_data_root: &Path) -> Result<Vec<PersistedTaskV3>, String> {
        let root = app_data_root.join("agent-m4");
        fs::create_dir_all(&root)
            .map_err(|error| format!("failed to create Agent M4 store: {error}"))?;
        let path = root.join("tasks-v1.json");
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        if let Some(existing) = state.root.as_ref() {
            if existing != &root {
                return Err("Agent M4 persistence root changed after initialization".into());
            }
            return Ok(state.tasks.values().cloned().collect());
        }
        state.root = Some(root.clone());
        if !path.exists() {
            state.status = Some(RecoveryStoreStatusV3 {
                format_version: STORE_VERSION,
                loaded: true,
                migrated: false,
                task_count: 0,
                corruption_recovered: false,
                warning: None,
            });
            return Ok(Vec::new());
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("failed to inspect Agent M4 store: {error}"))?;
        if metadata.len() as usize > MAX_STORE_BYTES {
            return recover_corrupt_store(&mut state, &path, "persistence file exceeded its limit");
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("failed to read Agent M4 store: {error}"))?;
        let raw: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                return recover_corrupt_store(&mut state, &path, "persistence JSON was corrupt")
            }
        };
        let version = raw
            .get("version")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX);
        let (envelope, migrated) = match version {
            1 => match serde_json::from_value::<PersistenceEnvelopeV3>(raw) {
                Ok(envelope) => (envelope, false),
                Err(_) => {
                    return recover_corrupt_store(
                        &mut state,
                        &path,
                        "persistence schema was invalid",
                    )
                }
            },
            0 => {
                let old = match serde_json::from_value::<PersistenceEnvelopeV0>(raw) {
                    Ok(old) => old,
                    Err(_) => {
                        return recover_corrupt_store(
                            &mut state,
                            &path,
                            "legacy persistence schema was invalid",
                        )
                    }
                };
                (
                    PersistenceEnvelopeV3 {
                        version: STORE_VERSION,
                        written_at_unix_ms: current_unix_ms(),
                        tasks: old.tasks,
                        notifications: Vec::new(),
                        audit: Vec::new(),
                    },
                    true,
                )
            }
            _ => {
                return recover_corrupt_store(
                    &mut state,
                    &path,
                    "persistence version was unsupported",
                )
            }
        };
        if envelope.tasks.len() > MAX_PERSISTED_TASKS
            || envelope
                .tasks
                .iter()
                .any(|task| task.calls.len() > MAX_CALLS_PER_TASK)
        {
            return recover_corrupt_store(&mut state, &path, "persistence bounds were exceeded");
        }
        for mut task in envelope.tasks {
            if !matches!(
                task.state.as_str(),
                "active" | "needsReconciliation" | "lost" | "cancelled" | "completed"
            ) {
                task.state = "needsReconciliation".into();
                task.phase = TaskPhaseV3::Reconciliation;
            }
            sanitize_persisted_task(&mut task);
            if task.phase == TaskPhaseV3::WaitingApproval {
                task.phase = TaskPhaseV3::Running;
            }
            task.processes.iter_mut().for_each(|process| {
                if !matches!(
                    process.state.as_str(),
                    "exited" | "cancelled" | "timedout" | "failed" | "acknowledgedLost"
                ) {
                    process.state = "lost".into();
                    process.recovery_advice = "The native process handle cannot be reattached after restart; inspect the target before continuing.".into();
                    process.updated_at_unix_ms = current_unix_ms();
                }
            });
            let recovery = recovery_snapshot(&task);
            match recovery.disposition {
                RecoveryDispositionV3::SafeToResume => {}
                RecoveryDispositionV3::NeedsReconciliation => {
                    task.state = "needsReconciliation".into();
                    task.phase = TaskPhaseV3::Reconciliation;
                }
                RecoveryDispositionV3::Lost => {
                    task.state = "lost".into();
                    task.phase = TaskPhaseV3::Lost;
                }
                RecoveryDispositionV3::Cancelled => {
                    task.state = "cancelled".into();
                    task.phase = TaskPhaseV3::Cancelled;
                }
                RecoveryDispositionV3::Completed => {
                    task.state = "completed".into();
                    task.phase = TaskPhaseV3::Completed;
                }
            }
            state.tasks.insert(task.request.task_id.clone(), task);
        }
        state.notifications = envelope
            .notifications
            .into_iter()
            .rev()
            .take(MAX_NOTIFICATIONS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        state.audit = envelope
            .audit
            .into_iter()
            .rev()
            .take(MAX_AUDIT_ENTRIES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        state.status = Some(RecoveryStoreStatusV3 {
            format_version: STORE_VERSION,
            loaded: true,
            migrated,
            task_count: state.tasks.len(),
            corruption_recovered: false,
            warning: None,
        });
        let tasks = state.tasks.values().cloned().collect::<Vec<_>>();
        // Rewrite every accepted snapshot through the current sanitizer and
        // recovery classifier before any task can resume.
        persist_locked(&state)?;
        Ok(tasks)
    }

    pub(crate) fn upsert_task(&self, mut task: PersistedTaskV3) -> Result<(), String> {
        sanitize_persisted_task(&mut task);
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        if !state.tasks.contains_key(&task.request.task_id)
            && state.tasks.len() >= MAX_PERSISTED_TASKS
        {
            return Err("Agent M4 persistence reached its task limit".into());
        }
        state.tasks.insert(task.request.task_id.clone(), task);
        update_store_status(&mut state);
        persist_locked(&state)
    }

    pub(crate) fn mark_call_started(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: AgentEffectKindV3,
        scope: Option<&CallPolicyScopeV3>,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not persisted".to_string())?;
        if task.calls.len() >= MAX_CALLS_PER_TASK {
            return Err("Agent M4 recovery journal reached its call limit".into());
        }
        if task.calls.iter().any(|entry| entry.call_id == call.call_id) {
            return Err("Agent M4 recovery journal rejected a duplicate call id".into());
        }
        let now = current_unix_ms();
        task.calls.push(RecoveryCallV3 {
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            effect,
            state: RecoveryCallStateV3::Started,
            started_at_unix_ms: now,
            updated_at_unix_ms: now,
            automatic_replay_allowed: false,
            network_destinations: scope
                .map(|scope| scope.network_destinations.clone())
                .unwrap_or_default(),
            sensitive_path_count: scope.map_or(0, |scope| scope.sensitive_path_count),
            critical_path_count: scope.map_or(0, |scope| scope.critical_path_count),
        });
        task.phase = TaskPhaseV3::Running;
        task.updated_at_unix_ms = now;
        persist_locked(&state)
    }

    pub(crate) fn mark_call_finished(
        &self,
        task_id: &str,
        call_id: &str,
        status: AgentToolResultStatusV3,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not persisted".to_string())?;
        let call = task
            .calls
            .iter_mut()
            .find(|entry| entry.call_id == call_id)
            .ok_or_else(|| "Agent M4 recovery journal did not own the call".to_string())?;
        call.state = match status {
            AgentToolResultStatusV3::Completed => RecoveryCallStateV3::Completed,
            AgentToolResultStatusV3::Cancelled => RecoveryCallStateV3::Cancelled,
            AgentToolResultStatusV3::Rejected
            | AgentToolResultStatusV3::Failed
            | AgentToolResultStatusV3::TimedOut => RecoveryCallStateV3::Failed,
        };
        call.updated_at_unix_ms = current_unix_ms();
        task.updated_at_unix_ms = call.updated_at_unix_ms;
        persist_locked(&state)
    }

    pub(crate) fn set_phase(&self, task_id: &str, phase: TaskPhaseV3) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not found".to_string())?;
        task.phase = phase;
        task.updated_at_unix_ms = current_unix_ms();
        persist_locked(&state)
    }

    pub(crate) fn set_last_failure(&self, task_id: &str, summary: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not found".to_string())?;
        task.last_failure = Some(bounded_redacted_text(summary, 2_048));
        task.updated_at_unix_ms = current_unix_ms();
        persist_locked(&state)
    }

    pub(crate) fn resolve_reconciliation(
        &self,
        task_id: &str,
        continue_task: bool,
    ) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not found".to_string())?;
        for call in &mut task.calls {
            if call.state == RecoveryCallStateV3::Started {
                call.state = RecoveryCallStateV3::Cancelled;
                call.updated_at_unix_ms = current_unix_ms();
                call.automatic_replay_allowed = false;
            }
        }
        for process in &mut task.processes {
            if process.state == "lost" || process.state == "running" {
                process.state = "acknowledgedLost".into();
                process.updated_at_unix_ms = current_unix_ms();
            }
        }
        task.state = if continue_task { "active" } else { "cancelled" }.into();
        task.phase = if continue_task {
            TaskPhaseV3::Running
        } else {
            TaskPhaseV3::Cancelled
        };
        task.updated_at_unix_ms = current_unix_ms();
        persist_locked(&state)
    }

    pub(crate) fn task_recovery(&self, task_id: &str) -> Result<TaskRecoverySnapshotV3, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        let task = state
            .tasks
            .get(task_id)
            .ok_or_else(|| "Agent M4 task metadata was not found".to_string())?;
        Ok(recovery_snapshot(task))
    }

    pub(crate) fn status(&self) -> Result<RecoveryStoreStatusV3, String> {
        self.inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?
            .status
            .clone()
            .ok_or_else(|| "Agent M4 persistence is not configured".to_string())
    }

    pub(crate) fn notifications(&self) -> Result<Vec<AgentNotificationV3>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?
            .notifications
            .clone())
    }

    pub(crate) fn push_notification(
        &self,
        task_id: Option<&str>,
        kind: NotificationKindV3,
    ) -> Result<AgentNotificationV3, String> {
        let (title, body) = notification_copy(kind);
        let notification = AgentNotificationV3 {
            notification_id: format!("notice-{}", Uuid::new_v4().simple()),
            task_id: task_id.map(str::to_string),
            kind,
            title: title.into(),
            body: body.into(),
            created_at_unix_ms: current_unix_ms(),
            delivered: false,
        };
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        state.notifications.push(notification.clone());
        if state.notifications.len() > MAX_NOTIFICATIONS {
            state.notifications.remove(0);
        }
        persist_locked(&state)?;
        Ok(notification)
    }

    pub(crate) fn mark_notification_delivered(&self, id: &str) -> Result<(), String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        if let Some(notification) = state
            .notifications
            .iter_mut()
            .find(|notification| notification.notification_id == id)
        {
            notification.delivered = true;
        }
        persist_locked(&state)
    }

    pub(crate) fn audit(&self, mut event: AgentAuditEventV3) -> Result<(), String> {
        event.decision = redact_sensitive_text(&event.decision);
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?;
        state.audit.push(event.clone());
        if state.audit.len() > MAX_AUDIT_ENTRIES {
            state.audit.remove(0);
        }
        append_audit_jsonl(&state, &event)?;
        persist_locked(&state)
    }

    pub(crate) fn audit_entries(&self) -> Result<Vec<AgentAuditEventV3>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Agent M4 persistence is unavailable".to_string())?
            .audit
            .clone())
    }
}

fn notification_copy(kind: NotificationKindV3) -> (&'static str, &'static str) {
    match kind {
        NotificationKindV3::Completed => (
            "ShellSpan task completed",
            "A background task completed with native verification evidence.",
        ),
        NotificationKindV3::Failed => (
            "ShellSpan task needs attention",
            "A native task operation failed. Open the task center for redacted recovery guidance.",
        ),
        NotificationKindV3::HumanActionRequired => (
            "ShellSpan reconciliation required",
            "A restarted task requires native reconciliation or session rebind. No prior operation will be replayed automatically.",
        ),
        NotificationKindV3::OperatorExpiring => (
            "ShellSpan Operator expiring",
            "An Operator grant will expire soon. It will not be renewed automatically.",
        ),
    }
}

fn sanitize_persisted_task(task: &mut PersistedTaskV3) {
    task.request.goal = redact_sensitive_text(&task.request.goal);
    task.request.success_criteria = task
        .request
        .success_criteria
        .iter()
        .map(|criterion| redact_sensitive_text(criterion))
        .collect();
    task.results.truncate(MAX_CALLS_PER_TASK);
    for result in &mut task.results {
        result.summary = redact_sensitive_text(&result.summary);
        result.data = None;
        result.artifacts.clear();
        for effect in &mut result.effects {
            effect.summary = redact_sensitive_text(&effect.summary);
        }
    }
    task.calls.truncate(MAX_CALLS_PER_TASK);
    task.calls
        .iter_mut()
        .for_each(|call| call.automatic_replay_allowed = false);
    task.processes.truncate(256);
    task.last_failure = task
        .last_failure
        .as_deref()
        .map(|summary| bounded_redacted_text(summary, 2_048));
    if let Some(plan) = task.plan.as_mut() {
        plan.explanation = plan.explanation.as_deref().map(redact_sensitive_text);
        for step in &mut plan.steps {
            step.description = redact_sensitive_text(&step.description);
            step.success_criteria = step
                .success_criteria
                .iter()
                .map(|criterion| redact_sensitive_text(criterion))
                .collect();
            step.rollback_or_compensation = redact_sensitive_text(&step.rollback_or_compensation);
        }
    }
}

fn recovery_snapshot(task: &PersistedTaskV3) -> TaskRecoverySnapshotV3 {
    let unfinished = task
        .calls
        .iter()
        .filter(|call| call.state == RecoveryCallStateV3::Started)
        .collect::<Vec<_>>();
    let has_unknown_write = unfinished.iter().any(|call| {
        matches!(
            call.effect,
            AgentEffectKindV3::StateChange
                | AgentEffectKindV3::Destructive
                | AgentEffectKindV3::ExternalSideEffect
        ) || call.tool_name.starts_with("mcp::")
    });
    let has_lost_process = task.processes.iter().any(|process| process.state == "lost");
    let disposition = match task.state.as_str() {
        "cancelled" => RecoveryDispositionV3::Cancelled,
        "completed" => RecoveryDispositionV3::Completed,
        "needsReconciliation" => RecoveryDispositionV3::NeedsReconciliation,
        "lost" => RecoveryDispositionV3::Lost,
        _ if has_unknown_write || task.phase == TaskPhaseV3::WaitingExternal => {
            RecoveryDispositionV3::NeedsReconciliation
        }
        _ if has_lost_process => RecoveryDispositionV3::Lost,
        _ => RecoveryDispositionV3::SafeToResume,
    };
    let phase = match disposition {
        RecoveryDispositionV3::SafeToResume if last_result_failed(task) => TaskPhaseV3::Failed,
        RecoveryDispositionV3::SafeToResume => task.phase,
        RecoveryDispositionV3::NeedsReconciliation => TaskPhaseV3::Reconciliation,
        RecoveryDispositionV3::Lost => TaskPhaseV3::Lost,
        RecoveryDispositionV3::Cancelled => TaskPhaseV3::Cancelled,
        RecoveryDispositionV3::Completed => TaskPhaseV3::Completed,
    };
    let (progress_completed, progress_total) = task.plan.as_ref().map_or((0, 0), |plan| {
        (
            plan.steps
                .iter()
                .filter(|step| step.status == PlanStepStatusV3::Completed)
                .count(),
            plan.steps.len(),
        )
    });
    let last_failure = task.last_failure.clone().or_else(|| {
        task.results
            .iter()
            .rev()
            .find(|result| result.status != AgentToolResultStatusV3::Completed)
            .map(|result| redact_sensitive_text(&result.summary))
    });
    let last_effect = task
        .results
        .iter()
        .rev()
        .find_map(|result| result.effects.last().cloned());
    let recovery_advice = match disposition {
        RecoveryDispositionV3::SafeToResume => "Target identity, roots, rollout, policy, and permissions must be revalidated before the next call; no prior call will be replayed.".into(),
        RecoveryDispositionV3::NeedsReconciliation => "Inspect the target and choose continue or cancel. The uncertain write/external call is permanently non-replayable.".into(),
        RecoveryDispositionV3::Lost => "The native process cannot be reattached. Inspect the host before deciding whether to continue; no success or termination is assumed.".into(),
        RecoveryDispositionV3::Cancelled => "The task is cancelled and cannot resume without creating a new authorization flow.".into(),
        RecoveryDispositionV3::Completed => "The task completed with native evidence and is retained for audit.".into(),
    };
    TaskRecoverySnapshotV3 {
        disposition,
        phase,
        progress_completed,
        progress_total,
        calls: task.calls.clone(),
        processes: task.processes.clone(),
        recovery_advice,
        requires_human_action: matches!(
            disposition,
            RecoveryDispositionV3::NeedsReconciliation | RecoveryDispositionV3::Lost
        ),
        requires_session_rebind: false,
        last_failure,
        last_effect,
    }
}

fn last_result_failed(task: &PersistedTaskV3) -> bool {
    task.results
        .last()
        .is_some_and(|result| result.status != AgentToolResultStatusV3::Completed)
}

fn bounded_redacted_text(value: &str, maximum_chars: usize) -> String {
    redact_sensitive_text(value)
        .chars()
        .take(maximum_chars)
        .collect()
}

fn update_store_status(state: &mut PersistenceStateV3) {
    if let Some(status) = state.status.as_mut() {
        status.task_count = state.tasks.len();
    }
}

fn recover_corrupt_store(
    state: &mut PersistenceStateV3,
    path: &Path,
    reason: &str,
) -> Result<Vec<PersistedTaskV3>, String> {
    let quarantine = path.with_extension(format!("corrupt-{}", current_unix_ms()));
    fs::rename(path, &quarantine)
        .map_err(|error| format!("failed to quarantine corrupt Agent M4 store: {error}"))?;
    state.status = Some(RecoveryStoreStatusV3 {
        format_version: STORE_VERSION,
        loaded: true,
        migrated: false,
        task_count: 0,
        corruption_recovered: true,
        warning: Some(reason.into()),
    });
    Ok(Vec::new())
}

fn persist_locked(state: &PersistenceStateV3) -> Result<(), String> {
    let Some(root) = state.root.as_ref() else {
        return Err("Agent M4 persistence is not configured".into());
    };
    let mut tasks = state.tasks.values().cloned().collect::<Vec<_>>();
    tasks.sort_by_key(|task| task.created_at_unix_ms);
    let envelope = PersistenceEnvelopeV3 {
        version: STORE_VERSION,
        written_at_unix_ms: current_unix_ms(),
        tasks,
        notifications: state.notifications.clone(),
        audit: state.audit.clone(),
    };
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|error| format!("failed to encode Agent M4 store: {error}"))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Agent M4 persistence exceeded its size limit".into());
    }
    atomic_write(&root.join("tasks-v1.json"), &bytes)
}

fn append_audit_jsonl(state: &PersistenceStateV3, event: &AgentAuditEventV3) -> Result<(), String> {
    let Some(root) = state.root.as_ref() else {
        return Err("Agent M4 persistence is not configured".into());
    };
    let path = root.join("audit-v1.jsonl");
    if fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
        > 1024 * 1024
    {
        let rotated = root.join("audit-v1.previous.jsonl");
        let _ = fs::remove_file(&rotated);
        fs::rename(&path, rotated)
            .map_err(|error| format!("failed to rotate Agent M4 audit: {error}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("failed to open Agent M4 audit: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict Agent M4 audit: {error}"))?;
    }
    serde_json::to_writer(&mut file, event)
        .map_err(|error| format!("failed to encode Agent M4 audit: {error}"))?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("failed to persist Agent M4 audit: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent M4 store has no parent".to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to stage Agent M4 store: {error}"))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| format!("failed to flush Agent M4 store: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to restrict Agent M4 store: {error}"))?;
    }
    let temp_path = temp
        .into_temp_path()
        .keep()
        .map_err(|error| format!("failed to retain staged Agent M4 store: {error}"))?;
    replace_file(&temp_path, path)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("failed to atomically replace Agent M4 store: {error}"))?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Agent M4 store has no parent after replacement".to_string())?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to flush Agent M4 store directory: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let success = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                source_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if success == 0 {
        let error = std::io::Error::last_os_error();
        let _ = fs::remove_file(source);
        return Err(format!(
            "failed to atomically replace Agent M4 store: {error}"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallPolicyScopeV3 {
    pub(crate) paths: Vec<String>,
    pub(crate) network_destinations: Vec<AgentNetworkDestinationV3>,
    pub(crate) sensitive_path_count: usize,
    pub(crate) critical_path_count: usize,
    pub(crate) unknown_write: bool,
    pub(crate) unknown_network_egress: bool,
}

pub(crate) fn inspect_call_policy_scope_v3(
    call: &AgentToolCallV3,
) -> Result<CallPolicyScopeV3, String> {
    let paths = match call.tool_name.as_str() {
        "read_file" => vec![
            serde_json::from_value::<ReadFileArgumentsV3>(call.arguments.clone())
                .map_err(|_| "read_file policy arguments were invalid".to_string())?
                .path,
        ],
        "list_directory" => vec![
            serde_json::from_value::<ListDirectoryArgumentsV3>(call.arguments.clone())
                .map_err(|_| "list_directory policy arguments were invalid".to_string())?
                .path,
        ],
        "search_text" => vec![
            serde_json::from_value::<SearchTextArgumentsV3>(call.arguments.clone())
                .map_err(|_| "search_text policy arguments were invalid".to_string())?
                .path,
        ],
        "apply_patch" => serde_json::from_value::<ApplyPatchArgumentsV3>(call.arguments.clone())
            .map_err(|_| "apply_patch policy arguments were invalid".to_string())?
            .preconditions
            .into_iter()
            .map(|item| item.path)
            .collect(),
        "transfer_file" => {
            let arguments =
                serde_json::from_value::<TransferFileArgumentsV3>(call.arguments.clone())
                    .map_err(|_| "transfer_file policy arguments were invalid".to_string())?;
            vec![arguments.source_path, arguments.destination_path]
        }
        "exec_command" => {
            let mut paths = call
                .arguments
                .get("cwd")
                .and_then(Value::as_str)
                .map(|path| vec![path.to_string()])
                .unwrap_or_default();
            if let Some(command) = call.arguments.get("command").and_then(Value::as_str) {
                paths.extend(extract_command_paths(command));
            }
            paths
        }
        _ => Vec::new(),
    };
    let mut network_destinations = Vec::new();
    if let Some(command) = call.arguments.get("command").and_then(Value::as_str) {
        network_destinations.extend(extract_network_destinations(command));
    }
    if call.tool_name == "transfer_file" {
        if let AgentToolTargetV3::Remote { host, port, .. } = &call.target {
            network_destinations.push(AgentNetworkDestinationV3 {
                protocol: "sftp".into(),
                host: normalize_host(host),
                port: *port,
            });
        }
    }
    network_destinations.sort_by(|left, right| {
        (&left.protocol, &left.host, left.port).cmp(&(&right.protocol, &right.host, right.port))
    });
    network_destinations.dedup();
    let sensitive_path_count = paths
        .iter()
        .filter(|path| path_is_sensitive_v3(path))
        .count();
    let critical_path_count = paths
        .iter()
        .filter(|path| path_is_critical_v3(path))
        .count();
    let unknown_network_egress = call
        .arguments
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            network_destinations.is_empty()
                || command.chars().any(|character| {
                    matches!(character, '$' | '%' | '`' | ';' | '|' | '&' | '\n' | '\r')
                })
        });
    Ok(CallPolicyScopeV3 {
        paths,
        network_destinations,
        sensitive_path_count,
        critical_path_count,
        unknown_write: call.tool_name == "exec_command",
        unknown_network_egress,
    })
}

fn extract_network_destinations(command: &str) -> Vec<AgentNetworkDestinationV3> {
    let mut destinations = Vec::new();
    for token in command.split_ascii_whitespace() {
        let candidate = token.trim_matches(|character: char| {
            matches!(
                character,
                '\'' | '"' | '`' | ',' | ';' | '(' | ')' | '[' | ']'
            )
        });
        if let Ok(url) = Url::parse(candidate) {
            if let Some(host) = url.host_str() {
                let protocol = url.scheme().to_ascii_lowercase();
                if let Some(port) = url.port_or_known_default() {
                    destinations.push(AgentNetworkDestinationV3 {
                        protocol,
                        host: normalize_host(host),
                        port,
                    });
                }
            }
        }
    }
    destinations
}

fn extract_command_paths(command: &str) -> Vec<String> {
    command
        .split_ascii_whitespace()
        .map(|token| {
            token.trim_matches(|character: char| {
                matches!(
                    character,
                    '\'' | '"' | '`' | ',' | ';' | '(' | ')' | '[' | ']'
                )
            })
        })
        .filter(|token| {
            !token.contains("://")
                && (*token == "/"
                    || token.starts_with("/dev/")
                    || token.starts_with("/proc/")
                    || token.starts_with("/sys/")
                    || token.starts_with("~/")
                    || token
                        .get(1..3)
                        .is_some_and(|prefix| prefix == ":\\" || prefix == ":/")
                    || path_is_sensitive_v3(token))
        })
        .map(str::to_string)
        .collect()
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

pub(crate) fn path_is_sensitive_v3(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower.split('/').any(|component| {
        component == ".env"
            || component.starts_with(".env.")
            || matches!(component, ".ssh" | ".aws" | ".gnupg" | "credentials")
            || component.contains("secret")
            || component.ends_with(".pem")
            || component.ends_with(".key")
            || component.ends_with(".pfx")
    }) || lower == "/etc/shadow"
        || lower.contains("/windows/system32/config/")
}

fn path_is_critical_v3(path: &str) -> bool {
    let normalized = path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    normalized.is_empty()
        || normalized == "/"
        || (normalized.len() == 2 && normalized.ends_with(':'))
        || normalized == "/etc/shadow"
        || normalized.starts_with("/dev/")
        || normalized.starts_with("/proc/")
        || normalized.starts_with("/sys/")
        || normalized.contains("/windows/system32/config/")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OperatorRolloutV3 {
    Disabled,
    Enabled,
    Invalid,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperatorPolicyV3 {
    pub(crate) stage: String,
    pub(crate) default_enabled: bool,
    pub(crate) maximum_ttl_ms: u64,
    pub(crate) grants_survive_restart: bool,
}

pub(crate) fn operator_policy_v3() -> OperatorPolicyV3 {
    let stage = match operator_rollout_v3() {
        OperatorRolloutV3::Disabled => "disabled",
        OperatorRolloutV3::Enabled => "enabled",
        OperatorRolloutV3::Invalid => "invalid",
    };
    OperatorPolicyV3 {
        stage: stage.into(),
        default_enabled: false,
        maximum_ttl_ms: MAX_OPERATOR_TTL_MS,
        grants_survive_restart: false,
    }
}

pub(crate) fn operator_rollout_v3() -> OperatorRolloutV3 {
    match std::env::var("SHELLSPAN_AGENT_OPERATOR") {
        Err(std::env::VarError::NotPresent) => OperatorRolloutV3::Disabled,
        Ok(value) if value.eq_ignore_ascii_case("disabled") => OperatorRolloutV3::Disabled,
        Ok(value) if value.eq_ignore_ascii_case("enabled") => OperatorRolloutV3::Enabled,
        _ => OperatorRolloutV3::Invalid,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperatorConfigureRequestV3 {
    pub(crate) task_id: String,
    pub(crate) target_ids: Vec<String>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) effects: Vec<AgentEffectKindV3>,
    #[serde(default)]
    pub(crate) path_prefixes: Vec<String>,
    #[serde(default)]
    pub(crate) network_destinations: Vec<AgentNetworkDestinationV3>,
    #[serde(default)]
    pub(crate) allow_elevation: bool,
    pub(crate) ttl_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperatorGrantV3 {
    pub(crate) grant_id: String,
    pub(crate) task_id: String,
    pub(crate) target_ids: Vec<String>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) effects: Vec<AgentEffectKindV3>,
    pub(crate) path_prefixes: Vec<String>,
    pub(crate) network_destinations: Vec<AgentNetworkDestinationV3>,
    pub(crate) allow_elevation: bool,
    pub(crate) issued_at_unix_ms: u64,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) revoked_at_unix_ms: Option<u64>,
    pub(crate) last_used_at_unix_ms: Option<u64>,
}

#[derive(Clone, Default)]
pub(crate) struct OperatorStoreV3 {
    grants: Arc<Mutex<HashMap<String, OperatorGrantV3>>>,
    expiry_notified: Arc<Mutex<HashSet<String>>>,
}

impl OperatorStoreV3 {
    pub(crate) fn configure(
        &self,
        request: OperatorConfigureRequestV3,
        task: &AgentRequestV3,
        tools: &[RegisteredToolV3],
    ) -> Result<OperatorGrantV3, String> {
        if operator_rollout_v3() != OperatorRolloutV3::Enabled {
            return Err("Operator rollout is disabled or invalid".into());
        }
        self.configure_enabled(request, task, tools)
    }

    fn configure_enabled(
        &self,
        request: OperatorConfigureRequestV3,
        task: &AgentRequestV3,
        tools: &[RegisteredToolV3],
    ) -> Result<OperatorGrantV3, String> {
        if task.permission_mode != AgentPermissionModeV3::Operator
            || task.task_id != request.task_id
        {
            return Err("Operator configuration requires a matching Operator task".into());
        }
        if request.ttl_ms == 0 || request.ttl_ms > MAX_OPERATOR_TTL_MS {
            return Err("Operator TTL is outside the native limit".into());
        }
        if request.target_ids.is_empty()
            || request.tool_names.is_empty()
            || request.effects.is_empty()
            || request.target_ids.len() > 64
            || request.tool_names.len() > 64
            || request.effects.len() > 64
            || request.path_prefixes.len() > 64
            || request.network_destinations.len() > 64
        {
            return Err("Operator scope is empty or exceeds its native bounds".into());
        }
        if request
            .target_ids
            .iter()
            .any(|id| !task.targets.iter().any(|target| target.target_id() == id))
        {
            return Err("Operator scope contains a target outside the frozen task".into());
        }
        if request.tool_names.iter().any(|name| {
            !tools.iter().any(|tool| {
                tool.descriptor.name == *name
                    && tool.implementation_state == ToolImplementationStateV3::Implemented
            })
        }) {
            return Err("Operator scope contains an unavailable tool".into());
        }
        if request.effects.contains(&AgentEffectKindV3::None) {
            return Err("Operator scope cannot grant an effect-free pseudo permission".into());
        }
        if request.tool_names.iter().any(|name| {
            matches!(
                name.as_str(),
                "read_file" | "list_directory" | "search_text" | "apply_patch" | "transfer_file"
            )
        }) && request.path_prefixes.is_empty()
        {
            return Err("filesystem Operator tools require an explicit path scope".into());
        }
        if request.path_prefixes.iter().any(|path| {
            path.len() > 4_096
                || path.chars().any(char::is_control)
                || path_has_parent_component(path)
        }) {
            return Err("Operator path scope is invalid".into());
        }
        let mut network_destinations = request.network_destinations;
        if network_destinations.iter().any(|destination| {
            destination.protocol.is_empty()
                || destination.protocol.len() > 32
                || !destination
                    .protocol
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| {
                        if index == 0 {
                            byte.is_ascii_alphabetic()
                        } else {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')
                        }
                    })
                || destination.host.is_empty()
                || destination.host.len() > 255
                || destination.host.chars().any(char::is_control)
                || destination.port == 0
        }) {
            return Err("Operator network scope is invalid".into());
        }
        for destination in &mut network_destinations {
            destination.protocol.make_ascii_lowercase();
            destination.host = normalize_host(&destination.host);
        }
        network_destinations.sort_by(|left, right| {
            (&left.protocol, &left.host, left.port).cmp(&(&right.protocol, &right.host, right.port))
        });
        network_destinations.dedup();
        let now = current_unix_ms();
        let grant = OperatorGrantV3 {
            grant_id: format!("operator-{}", Uuid::new_v4().simple()),
            task_id: request.task_id,
            target_ids: unique(request.target_ids),
            tool_names: unique(request.tool_names),
            effects: request
                .effects
                .into_iter()
                .collect::<HashSet<_>>()
                .into_iter()
                .collect(),
            path_prefixes: unique(request.path_prefixes),
            network_destinations,
            allow_elevation: request.allow_elevation,
            issued_at_unix_ms: now,
            expires_at_unix_ms: now.saturating_add(request.ttl_ms),
            revoked_at_unix_ms: None,
            last_used_at_unix_ms: None,
        };
        self.grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?
            .insert(grant.grant_id.clone(), grant.clone());
        Ok(grant)
    }

    pub(crate) fn authorize(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        scope: &CallPolicyScopeV3,
    ) -> Result<Option<String>, String> {
        match operator_rollout_v3() {
            OperatorRolloutV3::Enabled => self.authorize_enabled(task_id, call, effect, scope),
            // A persisted Operator task has no surviving grant. Disabling the
            // independent rollout therefore falls back to the ordinary native
            // per-call confirmation path instead of reviving or implying a
            // grant.
            OperatorRolloutV3::Disabled => Ok(None),
            OperatorRolloutV3::Invalid => Err("Operator rollout value is invalid".into()),
        }
    }

    fn authorize_enabled(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        scope: &CallPolicyScopeV3,
    ) -> Result<Option<String>, String> {
        let now = current_unix_ms();
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?;
        let Some(grant) = grants.values_mut().find(|grant| {
            operator_grant_allows_call(grant, task_id, call, effect, scope, now)
                && operator_call_is_auto_approvable(effect, scope)
        }) else {
            // Outside the Operator envelope, the ordinary per-call native
            // confirmation flow remains available. This never auto-approves.
            return Ok(None);
        };
        Ok(Some(grant.grant_id.clone()))
    }

    pub(crate) fn validate_auto_approval_source(
        &self,
        grant_id: &str,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        scope: &CallPolicyScopeV3,
        mark_used: bool,
    ) -> Result<(), String> {
        if operator_rollout_v3() != OperatorRolloutV3::Enabled {
            return Err("Operator rollout is no longer enabled".into());
        }
        self.validate_auto_approval_source_enabled(
            grant_id, task_id, call, effect, scope, mark_used,
        )
    }

    fn validate_auto_approval_source_enabled(
        &self,
        grant_id: &str,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        scope: &CallPolicyScopeV3,
        mark_used: bool,
    ) -> Result<(), String> {
        let now = current_unix_ms();
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?;
        let grant = grants
            .get_mut(grant_id)
            .ok_or_else(|| "Operator capability source was not found".to_string())?;
        if !operator_grant_allows_call(grant, task_id, call, effect, scope, now)
            || !operator_call_is_auto_approvable(effect, scope)
        {
            return Err("Operator capability source is revoked, expired, or out of scope".into());
        }
        if mark_used {
            grant.last_used_at_unix_ms = Some(now);
        }
        Ok(())
    }

    pub(crate) fn revoke(&self, grant_id: &str) -> Result<OperatorGrantV3, String> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?;
        let grant = grants
            .get_mut(grant_id)
            .ok_or_else(|| "Operator grant was not found".to_string())?;
        grant.revoked_at_unix_ms = Some(current_unix_ms());
        Ok(grant.clone())
    }

    pub(crate) fn list(&self) -> Result<Vec<OperatorGrantV3>, String> {
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        grants.sort_by_key(|grant| grant.issued_at_unix_ms);
        Ok(grants)
    }

    pub(crate) fn expiring(&self) -> Result<Vec<OperatorGrantV3>, String> {
        let now = current_unix_ms();
        let grants = self.list()?;
        let mut notified = self
            .expiry_notified
            .lock()
            .map_err(|_| "Operator expiry state is unavailable".to_string())?;
        Ok(grants
            .into_iter()
            .filter(|grant| {
                grant.revoked_at_unix_ms.is_none()
                    && now < grant.expires_at_unix_ms
                    && grant.expires_at_unix_ms.saturating_sub(now) <= OPERATOR_EXPIRY_NOTICE_MS
                    && notified.insert(grant.grant_id.clone())
            })
            .collect())
    }

    pub(crate) fn allows_elevation(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        scope: &CallPolicyScopeV3,
    ) -> Result<(), String> {
        if operator_rollout_v3() != OperatorRolloutV3::Enabled {
            return Err("Operator rollout is no longer enabled".into());
        }
        let now = current_unix_ms();
        let grants = self
            .grants
            .lock()
            .map_err(|_| "Operator store is unavailable".to_string())?;
        if grants.values().any(|grant| {
            grant.task_id == task_id
                && grant.revoked_at_unix_ms.is_none()
                && now < grant.expires_at_unix_ms
                && grant.allow_elevation
                && grant
                    .target_ids
                    .iter()
                    .any(|id| id == call.target.target_id())
                && grant.tool_names.iter().any(|name| name == &call.tool_name)
                && grant.effects.contains(&effect.kind)
                && scope.paths.iter().all(|path| {
                    grant.path_prefixes.is_empty()
                        || grant
                            .path_prefixes
                            .iter()
                            .any(|prefix| path_within_prefix(path, prefix))
                })
                && scope
                    .network_destinations
                    .iter()
                    .all(|destination| grant.network_destinations.contains(destination))
        }) {
            Ok(())
        } else {
            Err("Operator scope does not allow elevation".into())
        }
    }
}

fn operator_call_is_auto_approvable(
    effect: &AgentObservedEffectV3,
    scope: &CallPolicyScopeV3,
) -> bool {
    !scope.unknown_write
        && scope.sensitive_path_count == 0
        && !matches!(
            effect.kind,
            AgentEffectKindV3::Destructive | AgentEffectKindV3::ExternalSideEffect
        )
}

fn operator_grant_allows_call(
    grant: &OperatorGrantV3,
    task_id: &str,
    call: &AgentToolCallV3,
    effect: &AgentObservedEffectV3,
    scope: &CallPolicyScopeV3,
    now: u64,
) -> bool {
    grant.task_id == task_id
        && grant.revoked_at_unix_ms.is_none()
        && now < grant.expires_at_unix_ms
        && grant
            .target_ids
            .iter()
            .any(|id| id == call.target.target_id())
        && grant.tool_names.iter().any(|name| name == &call.tool_name)
        && grant.effects.contains(&effect.kind)
        && scope.paths.iter().all(|path| {
            grant.path_prefixes.is_empty()
                || grant
                    .path_prefixes
                    .iter()
                    .any(|prefix| path_within_prefix(path, prefix))
        })
        && scope
            .network_destinations
            .iter()
            .all(|destination| grant.network_destinations.contains(destination))
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn path_within_prefix(path: &str, prefix: &str) -> bool {
    if path_has_parent_component(path) || path_has_parent_component(prefix) {
        return false;
    }
    let path = path.replace('\\', "/");
    let prefix = prefix.replace('\\', "/").trim_end_matches('/').to_string();
    path == prefix
        || path
            .strip_prefix(&prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn path_has_parent_component(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|component| component == "..")
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BrokerRequestKindV3 {
    Credential,
    Elevation,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BrokerPurposeV3 {
    RemoteAuthentication,
    McpAuthentication,
    Elevation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrokerAuthorizeRequestV3 {
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) target_id: String,
    pub(crate) tool_name: String,
    pub(crate) kind: BrokerRequestKindV3,
    pub(crate) purpose: BrokerPurposeV3,
    #[serde(default)]
    pub(crate) credential_service: Option<String>,
    #[serde(default)]
    pub(crate) credential_id: Option<String>,
    pub(crate) ttl_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrokerGrantV3 {
    pub(crate) grant_id: String,
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) target_id: String,
    pub(crate) tool_name: String,
    pub(crate) kind: BrokerRequestKindV3,
    pub(crate) purpose: BrokerPurposeV3,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) consumed_at_unix_ms: Option<u64>,
    pub(crate) revoked_at_unix_ms: Option<u64>,
    pub(crate) credential_reference_present: bool,
}

#[derive(Debug, Clone)]
struct BrokerRecordV3 {
    public: BrokerGrantV3,
    credential_service: Option<String>,
    credential_id: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct NativeBrokerV3 {
    records: Arc<Mutex<HashMap<String, BrokerRecordV3>>>,
}

pub(crate) struct ConsumedCredentialBundleV3 {
    pub(crate) grants: Vec<BrokerGrantV3>,
    pub(crate) values_by_id: HashMap<String, String>,
}

impl NativeBrokerV3 {
    pub(crate) fn authorize(
        &self,
        request: BrokerAuthorizeRequestV3,
        task: &AgentRequestV3,
    ) -> Result<BrokerGrantV3, String> {
        if request.task_id != task.task_id || request.request_id != task.request_id {
            return Err("broker request is outside the frozen task".into());
        }
        let target = task
            .targets
            .iter()
            .find(|target| target.target_id() == request.target_id)
            .ok_or_else(|| "broker request is outside the frozen task".to_string())?;
        if request.purpose == BrokerPurposeV3::RemoteAuthentication
            && !matches!(target, AgentToolTargetV3::Remote { .. })
        {
            return Err("remote-authentication broker purpose requires a remote target".into());
        }
        if request.ttl_ms == 0 || request.ttl_ms > MAX_BROKER_TTL_MS {
            return Err("broker TTL is outside the native limit".into());
        }
        match (request.kind, request.purpose) {
            (
                BrokerRequestKindV3::Credential,
                BrokerPurposeV3::RemoteAuthentication | BrokerPurposeV3::McpAuthentication,
            ) => {
                if request
                    .credential_service
                    .as_deref()
                    .is_none_or(str::is_empty)
                    || request.credential_id.as_deref().is_none_or(str::is_empty)
                    || request
                        .credential_service
                        .as_deref()
                        .is_some_and(|value| !valid_credential_reference(value))
                    || request
                        .credential_id
                        .as_deref()
                        .is_some_and(|value| !valid_credential_reference(value))
                {
                    return Err(
                        "credential broker requires an opaque native credential reference".into(),
                    );
                }
            }
            (BrokerRequestKindV3::Elevation, BrokerPurposeV3::Elevation) => {
                if request.credential_service.is_some() || request.credential_id.is_some() {
                    return Err(
                        "elevation broker does not accept credential text or references".into(),
                    );
                }
            }
            _ => return Err("broker kind and purpose do not match".into()),
        }
        let now = current_unix_ms();
        let public = BrokerGrantV3 {
            grant_id: format!("broker-{}", Uuid::new_v4().simple()),
            task_id: request.task_id,
            request_id: request.request_id,
            call_id: request.call_id,
            target_id: request.target_id,
            tool_name: request.tool_name,
            kind: request.kind,
            purpose: request.purpose,
            expires_at_unix_ms: now.saturating_add(request.ttl_ms),
            consumed_at_unix_ms: None,
            revoked_at_unix_ms: None,
            credential_reference_present: request.credential_id.is_some(),
        };
        self.records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?
            .insert(
                public.grant_id.clone(),
                BrokerRecordV3 {
                    public: public.clone(),
                    credential_service: request.credential_service,
                    credential_id: request.credential_id,
                },
            );
        Ok(public)
    }

    pub(crate) fn consume_elevation(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
    ) -> Result<BrokerGrantV3, String> {
        self.consume_matching(
            task_id,
            call,
            BrokerRequestKindV3::Elevation,
            BrokerPurposeV3::Elevation,
        )
        .map(|(grant, _)| grant)
    }

    pub(crate) fn consume_remote_authorization(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        profile_id: &str,
    ) -> Result<BrokerGrantV3, String> {
        let now = current_unix_ms();
        let mut records = self
            .records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?;
        let record = records
            .values_mut()
            .find(|record| {
                record.public.task_id == task_id
                    && record.public.request_id == call.request_id
                    && record.public.call_id == call.call_id
                    && record.public.target_id == call.target.target_id()
                    && record.public.tool_name == call.tool_name
                    && record.public.kind == BrokerRequestKindV3::Credential
                    && record.public.purpose == BrokerPurposeV3::RemoteAuthentication
                    && record.public.revoked_at_unix_ms.is_none()
                    && record.public.consumed_at_unix_ms.is_none()
                    && now < record.public.expires_at_unix_ms
                    && record.credential_service.as_deref() == Some(REMOTE_PROFILE_BROKER_SERVICE)
                    && record.credential_id.as_deref() == Some(profile_id)
            })
            .ok_or_else(|| {
                "no native remote-authentication grant matches the exact call".to_string()
            })?;
        record.public.consumed_at_unix_ms = Some(now);
        Ok(record.public.clone())
    }

    pub(crate) fn consume_credentials(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        purpose: BrokerPurposeV3,
        required_references: &[(String, String)],
        credentials: &CredentialManager,
    ) -> Result<ConsumedCredentialBundleV3, String> {
        if !matches!(
            purpose,
            BrokerPurposeV3::RemoteAuthentication | BrokerPurposeV3::McpAuthentication
        ) {
            return Err("credential broker purpose is invalid".into());
        }
        let now = current_unix_ms();
        let mut records = self
            .records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?;
        let mut unique_references = required_references.to_vec();
        unique_references.sort();
        unique_references.dedup();
        let mut selected = Vec::with_capacity(unique_references.len());
        let mut selected_ids = HashSet::new();
        let mut values_by_id = HashMap::new();
        for (service, credential_id) in unique_references {
            let (grant_id, public) = records
                .iter()
                .find(|(grant_id, record)| {
                    !selected_ids.contains(*grant_id)
                        && record.public.task_id == task_id
                        && record.public.request_id == call.request_id
                        && record.public.call_id == call.call_id
                        && record.public.target_id == call.target.target_id()
                        && record.public.tool_name == call.tool_name
                        && record.public.kind == BrokerRequestKindV3::Credential
                        && record.public.purpose == purpose
                        && record.public.revoked_at_unix_ms.is_none()
                        && record.public.consumed_at_unix_ms.is_none()
                        && now < record.public.expires_at_unix_ms
                        && record.credential_service.as_deref() == Some(service.as_str())
                        && record.credential_id.as_deref() == Some(credential_id.as_str())
                })
                .map(|(grant_id, record)| (grant_id.clone(), record.public.clone()))
                .ok_or_else(|| {
                    "no native credential grant matches every exact call reference".to_string()
                })?;
            let value = credentials
                .get_credential(&service, &credential_id)?
                .ok_or_else(|| "native credential reference could not be resolved".to_string())?;
            selected_ids.insert(grant_id.clone());
            selected.push((grant_id, public));
            values_by_id.insert(credential_id, value);
        }
        for (grant_id, _) in &selected {
            let record = records
                .get_mut(grant_id)
                .ok_or_else(|| "selected native broker grant disappeared".to_string())?;
            record.public.consumed_at_unix_ms = Some(now);
        }
        Ok(ConsumedCredentialBundleV3 {
            grants: selected.into_iter().map(|(_, grant)| grant).collect(),
            values_by_id,
        })
    }

    fn consume_matching(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        kind: BrokerRequestKindV3,
        purpose: BrokerPurposeV3,
    ) -> Result<(BrokerGrantV3, Option<(String, String)>), String> {
        let now = current_unix_ms();
        let mut records = self
            .records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?;
        let record = records
            .values_mut()
            .find(|record| {
                record.public.task_id == task_id
                    && record.public.request_id == call.request_id
                    && record.public.call_id == call.call_id
                    && record.public.target_id == call.target.target_id()
                    && record.public.tool_name == call.tool_name
                    && record.public.kind == kind
                    && record.public.purpose == purpose
                    && record.public.revoked_at_unix_ms.is_none()
                    && record.public.consumed_at_unix_ms.is_none()
                    && now < record.public.expires_at_unix_ms
            })
            .ok_or_else(|| "no native broker grant matches the exact call".to_string())?;
        record.public.consumed_at_unix_ms = Some(now);
        Ok((
            record.public.clone(),
            record
                .credential_service
                .clone()
                .zip(record.credential_id.clone()),
        ))
    }

    pub(crate) fn revoke(&self, grant_id: &str) -> Result<BrokerGrantV3, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?;
        let record = records
            .get_mut(grant_id)
            .ok_or_else(|| "broker grant was not found".to_string())?;
        record.public.revoked_at_unix_ms = Some(current_unix_ms());
        Ok(record.public.clone())
    }

    pub(crate) fn list(&self) -> Result<Vec<BrokerGrantV3>, String> {
        let mut grants = self
            .records
            .lock()
            .map_err(|_| "native broker is unavailable".to_string())?
            .values()
            .map(|record| record.public.clone())
            .collect::<Vec<_>>();
        grants.sort_by_key(|grant| grant.expires_at_unix_ms);
        Ok(grants)
    }
}

fn valid_credential_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

pub(crate) fn enforce_native_call_policy_v3(
    call: &AgentToolCallV3,
    effect: &AgentObservedEffectV3,
    scope: &CallPolicyScopeV3,
) -> Result<(), String> {
    if scope.critical_path_count > 0
        && matches!(
            effect.kind,
            AgentEffectKindV3::StateChange
                | AgentEffectKindV3::Destructive
                | AgentEffectKindV3::ExternalSideEffect
        )
        && !sensitive_writes_explicitly_enabled()
    {
        return Err("critical sensitive-path write is disabled by native policy".into());
    }
    if effect.kind == AgentEffectKindV3::ExternalSideEffect
        || !scope.network_destinations.is_empty()
    {
        if effect.kind == AgentEffectKindV3::ExternalSideEffect
            && call.tool_name == "exec_command"
            && scope.unknown_network_egress
        {
            return Err("unknown network egress is denied by native policy".into());
        }
        for destination in &scope.network_destinations {
            if !destination_matches_frozen_target(destination, &call.target)
                && !egress_allowlist()?.contains(destination)
            {
                return Err(format!(
                    "network egress to {}://{}:{} is not allowlisted",
                    destination.protocol, destination.host, destination.port
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn enforce_checkpoint_restore_policy_v3(path: &str) -> Result<(), String> {
    if path_is_critical_v3(path) && !sensitive_writes_explicitly_enabled() {
        return Err("critical sensitive-path restore is disabled by native policy".into());
    }
    Ok(())
}

fn sensitive_writes_explicitly_enabled() -> bool {
    matches!(
        std::env::var("SHELLSPAN_AGENT_SENSITIVE_WRITES"),
        Ok(value) if value.eq_ignore_ascii_case("enabled")
    )
}

pub(crate) fn validate_recovery_policy_configuration_v3(
    permission_mode: AgentPermissionModeV3,
) -> Result<(), String> {
    match std::env::var("SHELLSPAN_AGENT_SENSITIVE_WRITES") {
        Err(std::env::VarError::NotPresent) => {}
        Ok(value)
            if value.eq_ignore_ascii_case("disabled") || value.eq_ignore_ascii_case("enabled") => {}
        _ => return Err("unknown sensitive-path policy fails closed".into()),
    }
    let _ = egress_allowlist()?;
    if permission_mode == AgentPermissionModeV3::Operator
        && operator_rollout_v3() == OperatorRolloutV3::Invalid
    {
        return Err("unknown Operator rollout value fails closed".into());
    }
    Ok(())
}

fn egress_allowlist() -> Result<HashSet<AgentNetworkDestinationV3>, String> {
    match std::env::var("SHELLSPAN_AGENT_EGRESS_POLICY") {
        Err(std::env::VarError::NotPresent) => Ok(HashSet::new()),
        Ok(value) if value.eq_ignore_ascii_case("deny") => Ok(HashSet::new()),
        Ok(value) if value.eq_ignore_ascii_case("allowListed") => {
            let raw = std::env::var("SHELLSPAN_AGENT_EGRESS_ALLOWLIST")
                .map_err(|_| "egress allowlist policy requires an allowlist".to_string())?;
            raw.split(',').map(parse_egress_entry).collect()
        }
        _ => Err("unknown network egress policy fails closed".into()),
    }
}

fn parse_egress_entry(raw: &str) -> Result<AgentNetworkDestinationV3, String> {
    let url = Url::parse(raw.trim())
        .map_err(|_| "egress allowlist entry must be protocol://host:port".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "egress allowlist entry has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "egress allowlist entry has no known port".to_string())?;
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("egress allowlist entries may contain only protocol, host, and port".into());
    }
    Ok(AgentNetworkDestinationV3 {
        protocol: url.scheme().to_ascii_lowercase(),
        host: normalize_host(host),
        port,
    })
}

fn destination_matches_frozen_target(
    destination: &AgentNetworkDestinationV3,
    target: &AgentToolTargetV3,
) -> bool {
    matches!(
        target,
        AgentToolTargetV3::Remote { host, port, .. }
            if matches!(destination.protocol.as_str(), "ssh" | "sftp")
                && normalize_host(host) == destination.host
                && *port == destination.port
    )
}

pub(crate) fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

pub(crate) fn audit_event_v3(
    action: &str,
    task_id: Option<&str>,
    call: Option<&AgentToolCallV3>,
    effect: Option<&AgentObservedEffectV3>,
    scope: Option<&CallPolicyScopeV3>,
    decision: &str,
) -> AgentAuditEventV3 {
    AgentAuditEventV3 {
        event_id: format!("audit-{}", Uuid::new_v4().simple()),
        action: action.into(),
        task_id: task_id.map(str::to_string),
        target_id: call.map(|call| call.target.target_id().to_string()),
        tool_name: call.map(|call| call.tool_name.clone()),
        effect: effect.map(|effect| effect.kind),
        network_destinations: scope
            .map(|scope| scope.network_destinations.clone())
            .unwrap_or_default(),
        sensitive_path_count: scope.map_or(0, |scope| scope.sensitive_path_count),
        grant_id: None,
        purpose: None,
        expires_at_unix_ms: None,
        scope_target_ids: Vec::new(),
        scope_tool_names: Vec::new(),
        scope_effects: Vec::new(),
        scope_path_count: 0,
        decision: decision.into(),
        recorded_at_unix_ms: current_unix_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_contract_v3::{
        AgentExecutionChannelV3, AgentRequestSourceV3, ExecCommandArgumentsV3, PlanStepV3,
    };

    fn request() -> AgentRequestV3 {
        AgentRequestV3 {
            contract_version: 3,
            request_id: "req-1".into(),
            user_session_id: "user-1".into(),
            task_id: "task-1".into(),
            goal: "token=top-secret inspect".into(),
            success_criteria: vec!["password=hunter2".into()],
            targets: vec![AgentToolTargetV3::Local {
                target_id: "local-1".into(),
                session_id: "session-1".into(),
                cwd: Some("C:/workspace".into()),
            }],
            permission_mode: AgentPermissionModeV3::Operator,
            source_contract: AgentRequestSourceV3::V3,
        }
    }

    fn call(command: &str) -> AgentToolCallV3 {
        AgentToolCallV3 {
            request_id: "req-1".into(),
            call_id: "call-1".into(),
            tool_name: "exec_command".into(),
            arguments: serde_json::to_value(ExecCommandArgumentsV3 {
                command: command.into(),
                explanation: "test".into(),
                channel: AgentExecutionChannelV3::Direct,
                cwd: None,
                timeout_ms: None,
                background: None,
                elevated: None,
            })
            .unwrap(),
            target: request().targets[0].clone(),
            capability_id: "cap".into(),
        }
    }

    fn persisted(state: &str) -> PersistedTaskV3 {
        PersistedTaskV3 {
            request: request(),
            state: state.into(),
            phase: TaskPhaseV3::Planning,
            sequence: 1,
            results: Vec::new(),
            plan: None,
            calls: Vec::new(),
            processes: Vec::new(),
            last_failure: None,
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
        }
    }

    #[test]
    fn persistence_is_versioned_atomic_bounded_and_redacted() {
        let root = tempfile::tempdir().unwrap();
        let store = M4PersistenceV3::default();
        store.configure(root.path()).unwrap();
        let mut task = persisted("active");
        task.last_failure = Some("token=failure-secret".into());
        task.plan = Some(AgentPlanV3 {
            version: 1,
            explanation: Some("token=plan-secret".into()),
            steps: vec![PlanStepV3 {
                id: "step-1".into(),
                description: "password=description-secret".into(),
                dependencies: Vec::new(),
                target_ids: vec!["local-1".into()],
                required_tools: vec!["read_file".into()],
                expected_effect: AgentEffectKindV3::SensitiveRead,
                status: PlanStepStatusV3::Pending,
                success_criteria: vec!["api_key=criteria-secret".into()],
                rollback_or_compensation: "token=rollback-secret".into(),
                evidence_refs: Vec::new(),
            }],
            updated_at_unix_ms: 1,
        });
        store.upsert_task(task).unwrap();
        let path = root.path().join("agent-m4/tasks-v1.json");
        let raw = fs::read_to_string(path).unwrap();
        assert!(raw.contains("\"version\":1"));
        assert!(!raw.contains("top-secret"));
        assert!(!raw.contains("hunter2"));
        assert!(!raw.contains("plan-secret"));
        assert!(!raw.contains("description-secret"));
        assert!(!raw.contains("criteria-secret"));
        assert!(!raw.contains("rollback-secret"));
        assert!(!raw.contains("failure-secret"));
        assert!(raw.len() <= MAX_STORE_BYTES);
        assert_eq!(
            fs::read_dir(root.path().join("agent-m4")).unwrap().count(),
            1
        );
    }

    #[test]
    fn legacy_store_migrates_and_corruption_is_quarantined() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("agent-m4");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("tasks-v1.json"),
            serde_json::to_vec(&serde_json::json!({"version":0,"tasks":[persisted("active")]}))
                .unwrap(),
        )
        .unwrap();
        let store = M4PersistenceV3::default();
        assert_eq!(store.configure(root.path()).unwrap().len(), 1);
        assert!(store.status().unwrap().migrated);

        let corrupt_root = tempfile::tempdir().unwrap();
        let corrupt_dir = corrupt_root.path().join("agent-m4");
        fs::create_dir_all(&corrupt_dir).unwrap();
        fs::write(corrupt_dir.join("tasks-v1.json"), b"not-json").unwrap();
        let corrupt = M4PersistenceV3::default();
        assert!(corrupt.configure(corrupt_root.path()).unwrap().is_empty());
        assert!(corrupt.status().unwrap().corruption_recovered);
        assert_eq!(fs::read_dir(corrupt_dir).unwrap().count(), 1);

        let invalid_root = tempfile::tempdir().unwrap();
        let invalid_dir = invalid_root.path().join("agent-m4");
        fs::create_dir_all(&invalid_dir).unwrap();
        fs::write(
            invalid_dir.join("tasks-v1.json"),
            br#"{"version":1,"writtenAtUnixMs":1,"tasks":"invalid","notifications":[],"audit":[]}"#,
        )
        .unwrap();
        let invalid = M4PersistenceV3::default();
        assert!(invalid.configure(invalid_root.path()).unwrap().is_empty());
        assert!(invalid.status().unwrap().corruption_recovered);
        assert_eq!(fs::read_dir(invalid_dir).unwrap().count(), 1);
    }

    #[test]
    fn unknown_persisted_state_and_external_wait_fail_into_reconciliation() {
        let root = tempfile::tempdir().unwrap();
        let first = M4PersistenceV3::default();
        first.configure(root.path()).unwrap();
        let mut task = persisted("futureState");
        task.phase = TaskPhaseV3::WaitingExternal;
        first.upsert_task(task).unwrap();

        let restarted = M4PersistenceV3::default();
        let loaded = restarted.configure(root.path()).unwrap();
        assert_eq!(loaded[0].state, "needsReconciliation");
        assert_eq!(
            recovery_snapshot(&loaded[0]).disposition,
            RecoveryDispositionV3::NeedsReconciliation
        );
    }

    #[test]
    fn restart_never_replays_unknown_write_or_revives_process_handle() {
        let mut task = persisted("active");
        task.calls.push(RecoveryCallV3 {
            call_id: "write-1".into(),
            tool_name: "exec_command".into(),
            target_id: "local-1".into(),
            effect: AgentEffectKindV3::StateChange,
            state: RecoveryCallStateV3::Started,
            started_at_unix_ms: 1,
            updated_at_unix_ms: 1,
            automatic_replay_allowed: false,
            network_destinations: Vec::new(),
            sensitive_path_count: 0,
            critical_path_count: 0,
        });
        task.processes.push(RecoveredProcessV3 {
            process_handle: "proc-secret".into(),
            target_id: "process-1".into(),
            owner_target_id: "local-1".into(),
            channel: "direct".into(),
            state: "running".into(),
            started_at_unix_ms: 1,
            updated_at_unix_ms: 1,
            recovery_advice: String::new(),
        });
        let root = tempfile::tempdir().unwrap();
        let first = M4PersistenceV3::default();
        first.configure(root.path()).unwrap();
        first.upsert_task(task).unwrap();
        let restarted = M4PersistenceV3::default();
        let loaded = restarted.configure(root.path()).unwrap();
        let recovery = recovery_snapshot(&loaded[0]);
        assert_eq!(
            recovery.disposition,
            RecoveryDispositionV3::NeedsReconciliation
        );
        assert!(!recovery.calls[0].automatic_replay_allowed);
        assert_eq!(recovery.processes[0].state, "lost");
    }

    #[test]
    fn notification_copy_contains_no_task_content_or_secret() {
        for kind in [
            NotificationKindV3::Completed,
            NotificationKindV3::Failed,
            NotificationKindV3::HumanActionRequired,
            NotificationKindV3::OperatorExpiring,
        ] {
            let (title, body) = notification_copy(kind);
            assert!(!format!("{title}{body}").contains("secret"));
            assert!(!format!("{title}{body}").contains("command"));
        }
    }

    #[test]
    fn broker_is_call_bound_single_use_revocable_and_never_returns_secret() {
        let credentials = CredentialManager::in_memory_for_tests();
        credentials
            .set_credential("com.shellspan.fixture", "credential-1", "do-not-leak")
            .unwrap();
        let mut remote_request = request();
        remote_request.targets = vec![AgentToolTargetV3::Remote {
            target_id: "remote-1".into(),
            session_id: "session-remote".into(),
            profile_id: Some("profile-1".into()),
            host: "fixture.test".into(),
            port: 22,
            username: "fixture".into(),
            root_path: Some("/srv/app".into()),
            local_root: None,
        }];
        let remote_call = |call_id: &str| AgentToolCallV3 {
            request_id: "req-1".into(),
            call_id: call_id.into(),
            tool_name: "exec_command".into(),
            arguments: call("test").arguments,
            target: remote_request.targets[0].clone(),
            capability_id: "cap".into(),
        };
        let broker = NativeBrokerV3::default();
        let grant = broker
            .authorize(
                BrokerAuthorizeRequestV3 {
                    task_id: "task-1".into(),
                    request_id: "req-1".into(),
                    call_id: "call-1".into(),
                    target_id: "remote-1".into(),
                    tool_name: "exec_command".into(),
                    kind: BrokerRequestKindV3::Credential,
                    purpose: BrokerPurposeV3::RemoteAuthentication,
                    credential_service: Some("com.shellspan.fixture".into()),
                    credential_id: Some("credential-1".into()),
                    ttl_ms: 1_000,
                },
                &remote_request,
            )
            .unwrap();
        assert!(!serde_json::to_string(&grant)
            .unwrap()
            .contains("do-not-leak"));
        assert!(!serde_json::to_string(&grant)
            .unwrap()
            .contains("credential-1"));
        let wrong_call = remote_call("other-call");
        assert!(broker
            .consume_credentials(
                "task-1",
                &wrong_call,
                BrokerPurposeV3::RemoteAuthentication,
                &[("com.shellspan.fixture".into(), "credential-1".into())],
                &credentials,
            )
            .is_err());
        let bundle = broker
            .consume_credentials(
                "task-1",
                &remote_call("call-1"),
                BrokerPurposeV3::RemoteAuthentication,
                &[("com.shellspan.fixture".into(), "credential-1".into())],
                &credentials,
            )
            .unwrap();
        assert_eq!(bundle.grants.len(), 1);
        assert_eq!(
            bundle.values_by_id.get("credential-1").map(String::as_str),
            Some("do-not-leak")
        );
        assert!(broker
            .consume_credentials(
                "task-1",
                &remote_call("call-1"),
                BrokerPurposeV3::RemoteAuthentication,
                &[("com.shellspan.fixture".into(), "credential-1".into())],
                &credentials,
            )
            .is_err());

        let revoked_call = remote_call("call-revoked");
        let revoked = broker
            .authorize(
                BrokerAuthorizeRequestV3 {
                    task_id: "task-1".into(),
                    request_id: "req-1".into(),
                    call_id: revoked_call.call_id.clone(),
                    target_id: "remote-1".into(),
                    tool_name: "exec_command".into(),
                    kind: BrokerRequestKindV3::Credential,
                    purpose: BrokerPurposeV3::RemoteAuthentication,
                    credential_service: Some("com.shellspan.fixture".into()),
                    credential_id: Some("credential-1".into()),
                    ttl_ms: 1_000,
                },
                &remote_request,
            )
            .unwrap();
        broker.revoke(&revoked.grant_id).unwrap();
        assert!(broker
            .consume_credentials(
                "task-1",
                &revoked_call,
                BrokerPurposeV3::RemoteAuthentication,
                &[("com.shellspan.fixture".into(), "credential-1".into())],
                &credentials,
            )
            .is_err());
        let profile_call = remote_call("call-profile");
        let profile_grant = broker
            .authorize(
                BrokerAuthorizeRequestV3 {
                    task_id: "task-1".into(),
                    request_id: "req-1".into(),
                    call_id: profile_call.call_id.clone(),
                    target_id: "remote-1".into(),
                    tool_name: "exec_command".into(),
                    kind: BrokerRequestKindV3::Credential,
                    purpose: BrokerPurposeV3::RemoteAuthentication,
                    credential_service: Some(REMOTE_PROFILE_BROKER_SERVICE.into()),
                    credential_id: Some("profile-1".into()),
                    ttl_ms: 1_000,
                },
                &remote_request,
            )
            .unwrap();
        assert!(!serde_json::to_string(&profile_grant)
            .unwrap()
            .contains("profile-1"));
        assert!(broker
            .consume_remote_authorization("task-1", &profile_call, "profile-1")
            .is_ok());
        assert!(broker
            .consume_remote_authorization("task-1", &profile_call, "profile-1")
            .is_err());
        assert!(NativeBrokerV3::default().list().unwrap().is_empty());
    }

    #[test]
    fn operator_is_ttl_scoped_revocable_and_audited_without_arguments() {
        let store = OperatorStoreV3::default();
        let now = current_unix_ms();
        let grant = OperatorGrantV3 {
            grant_id: "operator-1".into(),
            task_id: "task-1".into(),
            target_ids: vec!["local-1".into()],
            tool_names: vec!["exec_command".into()],
            effects: vec![AgentEffectKindV3::StateChange],
            path_prefixes: vec!["C:/workspace".into()],
            network_destinations: Vec::new(),
            allow_elevation: false,
            issued_at_unix_ms: now,
            expires_at_unix_ms: now + 10_000,
            revoked_at_unix_ms: None,
            last_used_at_unix_ms: None,
        };
        store
            .grants
            .lock()
            .unwrap()
            .insert(grant.grant_id.clone(), grant);
        let call = call("custom-maintenance --password do-not-audit");
        let scope = CallPolicyScopeV3 {
            paths: Vec::new(),
            network_destinations: Vec::new(),
            sensitive_path_count: 0,
            critical_path_count: 0,
            unknown_write: true,
            unknown_network_egress: false,
        };
        let effect = AgentObservedEffectV3 {
            kind: AgentEffectKindV3::StateChange,
            target_id: "local-1".into(),
            summary: "native".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };
        assert!(store
            .authorize_enabled("task-1", &call, &effect, &scope)
            .unwrap()
            .is_none());
        assert!(store
            .revoke("operator-1")
            .unwrap()
            .revoked_at_unix_ms
            .is_some());
        assert!(store
            .authorize_enabled("task-1", &call, &effect, &scope)
            .unwrap()
            .is_none());

        let mut expired = store.list().unwrap()[0].clone();
        expired.grant_id = "operator-expired".into();
        expired.revoked_at_unix_ms = None;
        expired.expires_at_unix_ms = current_unix_ms().saturating_sub(1);
        store
            .grants
            .lock()
            .unwrap()
            .insert(expired.grant_id.clone(), expired);
        let auto_scope = CallPolicyScopeV3 {
            unknown_write: false,
            ..scope.clone()
        };
        let mut source = store.list().unwrap()[0].clone();
        source.grant_id = "operator-source".into();
        source.revoked_at_unix_ms = None;
        source.expires_at_unix_ms = current_unix_ms() + 10_000;
        store
            .grants
            .lock()
            .unwrap()
            .insert(source.grant_id.clone(), source);
        assert!(store
            .validate_auto_approval_source_enabled(
                "operator-source",
                "task-1",
                &call,
                &effect,
                &auto_scope,
                true,
            )
            .is_ok());
        assert!(store
            .list()
            .unwrap()
            .iter()
            .find(|grant| grant.grant_id == "operator-source")
            .unwrap()
            .last_used_at_unix_ms
            .is_some());
        store.revoke("operator-source").unwrap();
        assert!(store
            .validate_auto_approval_source_enabled(
                "operator-source",
                "task-1",
                &call,
                &effect,
                &auto_scope,
                false,
            )
            .is_err());
        assert!(store
            .authorize_enabled("task-1", &call, &effect, &auto_scope)
            .unwrap()
            .is_none());
        let mut expiring = store.list().unwrap()[0].clone();
        expiring.grant_id = "operator-expiring".into();
        expiring.revoked_at_unix_ms = None;
        expiring.expires_at_unix_ms = current_unix_ms() + 30_000;
        store
            .grants
            .lock()
            .unwrap()
            .insert(expiring.grant_id.clone(), expiring);
        assert_eq!(store.expiring().unwrap().len(), 1);
        assert!(store.expiring().unwrap().is_empty());

        let root = tempfile::tempdir().unwrap();
        let persistence = M4PersistenceV3::default();
        persistence.configure(root.path()).unwrap();
        persistence
            .audit(audit_event_v3(
                "operatorUsed",
                Some("task-1"),
                Some(&call),
                Some(&effect),
                Some(&scope),
                "allowed",
            ))
            .unwrap();
        let audit = fs::read_to_string(root.path().join("agent-m4/audit-v1.jsonl")).unwrap();
        assert!(!audit.contains("do-not-audit"));
        assert!(audit.contains("operatorUsed"));

        let registry = crate::agent_runtime_v3::ToolRegistryV3::from_builtin_manifest().unwrap();
        assert!(store
            .configure_enabled(
                OperatorConfigureRequestV3 {
                    task_id: "task-1".into(),
                    target_ids: vec!["local-1".into()],
                    tool_names: vec!["read_file".into()],
                    effects: vec![AgentEffectKindV3::ReadOnly],
                    path_prefixes: vec!["C:/workspace".into()],
                    network_destinations: Vec::new(),
                    allow_elevation: false,
                    ttl_ms: MAX_OPERATOR_TTL_MS + 1,
                },
                &request(),
                &registry.list(),
            )
            .is_err());
        assert!(!path_within_prefix("/Srv/App/config", "/srv/app"));
        assert!(!path_within_prefix(
            "C:/workspace/../secrets",
            "C:/workspace"
        ));
    }

    #[test]
    fn policy_detects_sensitive_paths_and_literal_network_targets() {
        let scope =
            inspect_call_policy_scope_v3(&call("curl https://api.example.test/v1")).unwrap();
        assert_eq!(
            scope.network_destinations,
            vec![AgentNetworkDestinationV3 {
                protocol: "https".into(),
                host: "api.example.test".into(),
                port: 443,
            }]
        );
        assert!(path_is_sensitive_v3(".ssh/id_ed25519"));
        assert!(path_is_critical_v3("/etc/shadow"));
        let unknown = inspect_call_policy_scope_v3(&call("curl $TARGET_URL")).unwrap();
        assert!(unknown.network_destinations.is_empty());
        let effect = AgentObservedEffectV3 {
            kind: AgentEffectKindV3::ExternalSideEffect,
            target_id: "local-1".into(),
            summary: "native".into(),
            paths: Vec::new(),
            network_destinations: Vec::new(),
        };
        assert!(
            enforce_native_call_policy_v3(&call("curl $TARGET_URL"), &effect, &unknown)
                .unwrap_err()
                .contains("unknown network egress")
        );
        let mixed = inspect_call_policy_scope_v3(&call(
            "curl https://api.example.test/v1; curl $SECOND_URL",
        ))
        .unwrap();
        assert!(mixed.unknown_network_egress);
        assert!(enforce_native_call_policy_v3(
            &call("curl https://api.example.test/v1; curl $SECOND_URL"),
            &effect,
            &mixed,
        )
        .unwrap_err()
        .contains("unknown network egress"));
        let drifted_effect = AgentObservedEffectV3 {
            kind: AgentEffectKindV3::ReadOnly,
            ..effect.clone()
        };
        assert!(enforce_native_call_policy_v3(
            &call("curl https://api.example.test/v1"),
            &drifted_effect,
            &scope,
        )
        .unwrap_err()
        .contains("not allowlisted"));
        assert!(parse_egress_entry("https://api.example.test:443/path").is_err());
    }
}
