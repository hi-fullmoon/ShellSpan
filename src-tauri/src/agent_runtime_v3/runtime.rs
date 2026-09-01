use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent_contract_v3::{
    validate_agent_request_v3, validate_result_correlation_v3, validate_tool_arguments_v3,
    AgentCapabilityVerificationContextV3, AgentEffectKindV3, AgentExecutionChannelV3,
    AgentObservedEffectV3, AgentPermissionModeV3, AgentPolicyEngineV3, AgentPolicyEvaluationV3,
    AgentPolicyOutcomeV3, AgentRequestSourceV3, AgentRequestV3, AgentToolCallV3,
    AgentToolResultStatusV3, AgentToolResultV3, AgentToolTargetV3, ExecCommandArgumentsV3,
    KillProcessArgumentsV3, M0ContractPolicyEngineV3, PlanStepStatusV3, PlanStepV3,
    UpdatePlanArgumentsV3, WaitProcessArgumentsV3, WriteStdinArgumentsV3,
};
use crate::connection::connect_sftp;
use crate::db::Database;
use crate::keychain::{CredentialManager, ProfileSecretKind};
use crate::models::{
    AuthMethod, JumpHostConfig, ProfileAuthMethod, RemoteConnectionRequest, SessionManager,
    SessionStatus, SessionTerminalKind,
};

use super::{
    assess_effect_v3, audit_event_v3, current_local_digest_v3, current_remote_digest_v3,
    enforce_checkpoint_restore_policy_v3, enforce_native_call_policy_v3, execute_file_tool_v3,
    inspect_call_policy_scope_v3, mcp_result_status, preview_file_call_v3,
    restore_local_checkpoint_v3, restore_remote_checkpoint_v3, spawn_local_process_v3,
    spawn_remote_process_v3, validate_m1_result_data_v3, validate_recovery_policy_configuration_v3,
    AgentAuditEventV3, AgentCallPreviewV3, AgentContextSnapshotV3, AgentFileCheckpointV3,
    AgentMcpAuthorizeRequestV3, AgentMcpCallV3, AgentMcpCapabilityGrantV3, AgentMcpResultV3,
    AgentNotificationV3, BrokerAuthorizeRequestV3, BrokerGrantV3, BrokerPurposeV3,
    BrokerRequestKindV3, CapabilityAuthorizationSourceV3, CapabilityIssueRequestV3,
    CheckpointOriginalMetadataV3, CheckpointStoreV3, ContextRetrievalRequestV3, ContextRetrievalV3,
    ContextRuntimeV3, ExtensionRuntimeV3, ExtensionSnapshotV3, FileExecutionContextV3,
    FileOperationRegistryV3, HookDecisionV3, HookEventV3, InstantiateRunbookRequestV3,
    IssuedCapabilityV3, LoadSkillRequestV3, LoadedSkillV3, M4PersistenceV3, McpRuntimeV3,
    McpServerSnapshotV3, McpSetEnabledRequestV3, McpToolSchemaRequestV3, McpToolSchemaV3,
    NativeBrokerV3, NativeCapabilityStoreV3, NotificationKindV3, OperatorConfigureRequestV3,
    OperatorGrantV3, OperatorStoreV3, PersistedTaskV3, ProcessLifecycleV3, ProcessRegistryV3,
    ProcessSnapshotV3, PtyLifecycleV3, PtyRegistryV3, RecoveredProcessV3, RecoveryDispositionV3,
    RecoveryStoreStatusV3, RegisteredToolV3, RemoteProcessStartV3, TaskPhaseV3,
    TaskRecoverySnapshotV3, ToolRegistryErrorV3, ToolRegistryV3, DEFAULT_CAPABILITY_TTL_MS,
    MAX_CAPABILITY_TTL_MS, MCP_CREDENTIAL_SERVICE, REMOTE_PROFILE_BROKER_SERVICE,
};

const MAX_ACTIVE_TASKS: usize = 128;
const MAX_RESULTS_PER_TASK: usize = 512;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskRuntimeStateV3 {
    Active,
    NeedsReconciliation,
    Lost,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTaskSnapshotV3 {
    pub(crate) request: AgentRequestV3,
    pub(crate) state: TaskRuntimeStateV3,
    pub(crate) sequence: u64,
    pub(crate) results: Vec<AgentToolResultV3>,
    pub(crate) processes: Vec<ProcessSnapshotV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) plan: Option<AgentPlanV3>,
    pub(crate) checkpoints: Vec<AgentFileCheckpointV3>,
    pub(crate) context: AgentContextSnapshotV3,
    pub(crate) extensions: ExtensionSnapshotV3,
    pub(crate) mcp_servers: Vec<McpServerSnapshotV3>,
    pub(crate) mcp_results: Vec<AgentMcpResultV3>,
    pub(crate) recovery: TaskRecoverySnapshotV3,
    pub(crate) notifications: Vec<AgentNotificationV3>,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPlanV3 {
    pub(crate) version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) explanation: Option<String>,
    pub(crate) steps: Vec<PlanStepV3>,
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Debug, Clone)]
struct AgentTaskRecordV3 {
    request: AgentRequestV3,
    state: TaskRuntimeStateV3,
    sequence: u64,
    active_call_ids: HashSet<String>,
    completed_call_ids: HashSet<String>,
    results: Vec<AgentToolResultV3>,
    plan: Option<AgentPlanV3>,
    restored: bool,
    created_at_unix_ms: u64,
    updated_at_unix_ms: u64,
}

#[derive(Clone, Default)]
struct AgentTaskStoreV3 {
    tasks: Arc<Mutex<HashMap<String, AgentTaskRecordV3>>>,
}

impl AgentTaskStoreV3 {
    fn register(&self, mut request: AgentRequestV3) -> Result<(), String> {
        validate_agent_request_v3(&request).map_err(|_| "invalid v3 Agent request".to_string())?;
        if request.source_contract != AgentRequestSourceV3::V3 {
            return Err("v2 compatibility views cannot become resumable v3 tasks".into());
        }
        if request.targets.len() != 1
            || !matches!(
                request.targets.first(),
                Some(AgentToolTargetV3::Local { .. } | AgentToolTargetV3::Remote { .. })
            )
        {
            return Err("M2 tasks require exactly one local or remote host target".into());
        }
        request.targets.push(AgentToolTargetV3::Task {
            target_id: format!("task-target:{}", request.task_id),
            task_id: request.task_id.clone(),
        });
        validate_agent_request_v3(&request)
            .map_err(|_| "native task target violated the v3 request contract".to_string())?;
        let now = current_unix_ms();
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        if let Some(existing) = tasks.get(&request.task_id) {
            return if existing.request == request {
                Ok(())
            } else {
                Err("task id already belongs to a different frozen request".into())
            };
        }
        if tasks.len() >= MAX_ACTIVE_TASKS {
            return Err("Agent task store reached its bounded capacity".into());
        }
        tasks.insert(
            request.task_id.clone(),
            AgentTaskRecordV3 {
                request,
                state: TaskRuntimeStateV3::Active,
                sequence: 1,
                active_call_ids: HashSet::new(),
                completed_call_ids: HashSet::new(),
                results: Vec::new(),
                plan: None,
                restored: false,
                created_at_unix_ms: now,
                updated_at_unix_ms: now,
            },
        );
        Ok(())
    }

    fn request(&self, task_id: &str) -> Result<AgentRequestV3, String> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if task.state != TaskRuntimeStateV3::Active {
            return Err("Agent task is not active".into());
        }
        if task.restored {
            return Err(
                "restarted Agent task requires native session rebind before authorization".into(),
            );
        }
        Ok(task.request.clone())
    }

    fn restore(&self, task: PersistedTaskV3, state: TaskRuntimeStateV3) -> Result<(), String> {
        validate_agent_request_v3(&task.request)
            .map_err(|_| "persisted v3 Agent request was invalid".to_string())?;
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        if tasks.contains_key(&task.request.task_id) {
            return Ok(());
        }
        if tasks.len() >= MAX_ACTIVE_TASKS {
            return Err("Agent task store reached its bounded capacity".into());
        }
        let completed_call_ids = task
            .results
            .iter()
            .map(|result| result.call_id.clone())
            .chain(task.calls.iter().map(|call| call.call_id.clone()))
            .collect();
        tasks.insert(
            task.request.task_id.clone(),
            AgentTaskRecordV3 {
                request: task.request,
                state,
                sequence: task.sequence.saturating_add(1),
                active_call_ids: HashSet::new(),
                completed_call_ids,
                results: task.results,
                plan: task.plan,
                restored: true,
                created_at_unix_ms: task.created_at_unix_ms,
                updated_at_unix_ms: current_unix_ms(),
            },
        );
        Ok(())
    }

    fn record(&self, task_id: &str) -> Result<AgentTaskRecordV3, String> {
        self.tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?
            .get(task_id)
            .cloned()
            .ok_or_else(|| "Agent task was not found".to_string())
    }

    fn add_process_target(&self, task_id: &str, target: AgentToolTargetV3) -> Result<(), String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if task
            .request
            .targets
            .iter()
            .any(|candidate| candidate.target_id() == target.target_id())
        {
            return Err("process target id already exists".into());
        }
        task.request.targets.push(target);
        validate_agent_request_v3(&task.request)
            .map_err(|_| "native process target violated the v3 request contract".to_string())?;
        task.sequence += 1;
        task.updated_at_unix_ms = current_unix_ms();
        Ok(())
    }

    fn begin_call(&self, task_id: &str, call_id: &str) -> Result<AgentRequestV3, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if task.state != TaskRuntimeStateV3::Active {
            return Err("Agent task is not active".into());
        }
        if task.results.len() >= MAX_RESULTS_PER_TASK {
            return Err("Agent task result history reached its bounded capacity".into());
        }
        if task.active_call_ids.contains(call_id) || task.completed_call_ids.contains(call_id) {
            return Err("tool call id was already used".into());
        }
        task.active_call_ids.insert(call_id.to_string());
        task.sequence += 1;
        task.updated_at_unix_ms = current_unix_ms();
        Ok(task.request.clone())
    }

    fn commit(
        &self,
        task_id: &str,
        call: &AgentToolCallV3,
        mut result: AgentToolResultV3,
    ) -> Result<AgentToolResultV3, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if task.results.len() >= MAX_RESULTS_PER_TASK {
            return Err("Agent task result history reached its bounded capacity".into());
        }
        if !task.active_call_ids.remove(&call.call_id) {
            return Err("tool result has no active native call".into());
        }
        if let Some(Value::Object(data)) = result.data.as_mut() {
            data.retain(|_, value| !value.is_null());
        }
        validate_m1_result_data_v3(&result)?;
        validate_result_correlation_v3(&task.request, call, &result)
            .map_err(|error| format!("tool result correlation failed: {error:?}"))?;
        task.completed_call_ids.insert(call.call_id.clone());
        task.results.push(result.clone());
        task.sequence += 1;
        task.updated_at_unix_ms = current_unix_ms();
        Ok(result)
    }

    fn cancel(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        task.state = TaskRuntimeStateV3::Cancelled;
        task.sequence += 1;
        task.updated_at_unix_ms = current_unix_ms();
        Ok(())
    }

    fn reconcile(&self, task_id: &str, continue_task: bool) -> Result<(), String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if !matches!(
            task.state,
            TaskRuntimeStateV3::NeedsReconciliation | TaskRuntimeStateV3::Lost
        ) {
            return Err("task is not awaiting restart reconciliation".into());
        }
        task.state = if continue_task {
            TaskRuntimeStateV3::Active
        } else {
            TaskRuntimeStateV3::Cancelled
        };
        task.restored = false;
        task.sequence = task.sequence.saturating_add(1);
        task.updated_at_unix_ms = current_unix_ms();
        Ok(())
    }

    fn rebind_session(&self, task_id: &str, replacement_session_id: &str) -> Result<(), String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if !(matches!(
            task.state,
            TaskRuntimeStateV3::NeedsReconciliation | TaskRuntimeStateV3::Lost
        ) || task.state == TaskRuntimeStateV3::Active && task.restored)
        {
            return Err("only a restarted task may rebind a recovery session".into());
        }
        let target = task
            .request
            .targets
            .iter_mut()
            .find(|target| {
                matches!(
                    target,
                    AgentToolTargetV3::Local { .. } | AgentToolTargetV3::Remote { .. }
                )
            })
            .ok_or_else(|| "recovery host target was not found".to_string())?;
        match target {
            AgentToolTargetV3::Local { session_id, .. }
            | AgentToolTargetV3::Remote { session_id, .. } => {
                *session_id = replacement_session_id.to_string();
            }
            _ => unreachable!("host target was selected above"),
        }
        validate_agent_request_v3(&task.request)
            .map_err(|_| "replacement session violated the frozen request".to_string())?;
        task.restored = false;
        task.sequence = task.sequence.saturating_add(1);
        task.updated_at_unix_ms = current_unix_ms();
        Ok(())
    }

    fn mark_completed_if_verified(&self, task_id: &str) -> Result<bool, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        let complete = task.plan.as_ref().is_some_and(|plan| {
            !plan.steps.is_empty()
                && plan
                    .steps
                    .iter()
                    .all(|step| step.status == PlanStepStatusV3::Completed)
        });
        if complete && task.state == TaskRuntimeStateV3::Active {
            task.state = TaskRuntimeStateV3::Completed;
            task.sequence = task.sequence.saturating_add(1);
            task.updated_at_unix_ms = current_unix_ms();
            return Ok(true);
        }
        Ok(false)
    }

    fn records(&self) -> Result<Vec<AgentTaskRecordV3>, String> {
        Ok(self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?
            .values()
            .cloned()
            .collect())
    }

    fn update_plan(
        &self,
        task_id: &str,
        arguments: UpdatePlanArgumentsV3,
        registry: &ToolRegistryV3,
    ) -> Result<AgentPlanV3, String> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "Agent task store is unavailable".to_string())?;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| "Agent task was not found".to_string())?;
        if task.state != TaskRuntimeStateV3::Active {
            return Err("Agent task is not active".into());
        }
        let current_version = task.plan.as_ref().map_or(0, |plan| plan.version);
        if arguments.plan_version != current_version {
            return Err("plan version precondition failed".into());
        }
        validate_plan_update(task, &arguments, registry)?;
        let plan = AgentPlanV3 {
            version: current_version.saturating_add(1),
            explanation: arguments.explanation,
            steps: arguments.steps,
            updated_at_unix_ms: current_unix_ms(),
        };
        task.plan = Some(plan.clone());
        task.sequence = task.sequence.saturating_add(1);
        task.updated_at_unix_ms = plan.updated_at_unix_ms;
        Ok(plan)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentAuthorizeCallRequestV3 {
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
    pub(crate) target: AgentToolTargetV3,
    #[serde(default)]
    pub(crate) ttl_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentCapabilityGrantV3 {
    pub(crate) capability_id: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) assessed_effect: AgentObservedEffectV3,
    pub(crate) effective_arguments: Value,
    pub(crate) hook_decisions: Vec<HookDecisionV3>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedAuthorizationV3 {
    request: AgentRequestV3,
    call: AgentToolCallV3,
    effect: AgentObservedEffectV3,
    ttl_ms: u64,
    pub(crate) requires_native_confirmation: bool,
    pub(crate) native_prompt: String,
    pub(crate) preview: AgentCallPreviewV3,
    hook_decisions: Vec<HookDecisionV3>,
    authorization_source: CapabilityAuthorizationSourceV3,
}

pub(crate) struct PreparedMcpAuthorizationV3 {
    request: AgentRequestV3,
    call: AgentMcpCallV3,
    canonical_tool_name: String,
    effect: AgentEffectKindV3,
    ttl_ms: u64,
    hook_decisions: Vec<HookDecisionV3>,
    pub(crate) requires_native_confirmation: bool,
    pub(crate) native_prompt: String,
}

pub(crate) struct PreparedCheckpointRestoreV3 {
    checkpoint: AgentFileCheckpointV3,
    target: AgentToolTargetV3,
    original: Option<Vec<u8>>,
    metadata: CheckpointOriginalMetadataV3,
    current_sha256: Option<String>,
    pub(crate) native_prompt: String,
}

#[derive(Clone)]
pub(crate) struct AgentRuntimeV3 {
    registry: Arc<ToolRegistryV3>,
    capabilities: NativeCapabilityStoreV3,
    tasks: AgentTaskStoreV3,
    processes: ProcessRegistryV3,
    pty: PtyRegistryV3,
    checkpoints: CheckpointStoreV3,
    context: ContextRuntimeV3,
    extensions: ExtensionRuntimeV3,
    mcp: McpRuntimeV3,
    file_operations: FileOperationRegistryV3,
    persistence: M4PersistenceV3,
    operator: OperatorStoreV3,
    broker: NativeBrokerV3,
    m4_loaded: Arc<Mutex<bool>>,
    shutdown_prepared: Arc<Mutex<bool>>,
    checkpoint_root: Arc<Mutex<Option<PathBuf>>>,
    policy: Arc<M0ContractPolicyEngineV3>,
}

impl Default for AgentRuntimeV3 {
    fn default() -> Self {
        Self {
            registry: Arc::new(
                ToolRegistryV3::from_builtin_manifest()
                    .expect("embedded Agent v3 tool manifest must be valid"),
            ),
            capabilities: NativeCapabilityStoreV3::default(),
            tasks: AgentTaskStoreV3::default(),
            processes: ProcessRegistryV3::default(),
            pty: PtyRegistryV3::default(),
            checkpoints: CheckpointStoreV3::default(),
            context: ContextRuntimeV3::default(),
            extensions: ExtensionRuntimeV3::default(),
            mcp: McpRuntimeV3::default(),
            file_operations: FileOperationRegistryV3::default(),
            persistence: M4PersistenceV3::default(),
            operator: OperatorStoreV3::default(),
            broker: NativeBrokerV3::default(),
            m4_loaded: Arc::new(Mutex::new(false)),
            shutdown_prepared: Arc::new(Mutex::new(false)),
            checkpoint_root: Arc::new(Mutex::new(None)),
            policy: Arc::new(M0ContractPolicyEngineV3),
        }
    }
}

impl AgentRuntimeV3 {
    pub(crate) fn configure_checkpoint_root(&self, root: PathBuf) -> Result<(), String> {
        self.context.configure_artifact_root(&root)?;
        let mut loaded = self
            .m4_loaded
            .lock()
            .map_err(|_| "Agent M4 initialization is unavailable".to_string())?;
        if !*loaded {
            let persisted = self.persistence.configure(&root)?;
            for task in persisted {
                let task_id = task.request.task_id.clone();
                let recovery = self.persistence.task_recovery(&task_id)?;
                let state = match recovery.disposition {
                    RecoveryDispositionV3::SafeToResume => TaskRuntimeStateV3::Active,
                    RecoveryDispositionV3::NeedsReconciliation => {
                        TaskRuntimeStateV3::NeedsReconciliation
                    }
                    RecoveryDispositionV3::Lost => TaskRuntimeStateV3::Lost,
                    RecoveryDispositionV3::Cancelled => TaskRuntimeStateV3::Cancelled,
                    RecoveryDispositionV3::Completed => TaskRuntimeStateV3::Completed,
                };
                self.context.register_task(&task.request)?;
                self.extensions.register_task(&task.request)?;
                self.mcp.register_task(&task.request)?;
                self.tasks.restore(task, state)?;
                if recovery.requires_human_action
                    || recovery.disposition == RecoveryDispositionV3::SafeToResume
                {
                    self.persistence.push_notification(
                        Some(&task_id),
                        NotificationKindV3::HumanActionRequired,
                    )?;
                }
            }
            *loaded = true;
        }
        let mut configured = self
            .checkpoint_root
            .lock()
            .map_err(|_| "checkpoint root is unavailable".to_string())?;
        match configured.as_ref() {
            Some(existing) if existing != &root => {
                Err("checkpoint root changed after runtime initialization".into())
            }
            Some(_) => Ok(()),
            None => {
                *configured = Some(root);
                Ok(())
            }
        }
    }

    fn checkpoint_root(&self) -> Result<PathBuf, String> {
        self.checkpoint_root
            .lock()
            .map_err(|_| "checkpoint root is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "checkpoint root is not configured".to_string())
    }

    pub(crate) fn tools(&self) -> Vec<RegisteredToolV3> {
        self.registry.list()
    }

    fn persist_task(&self, task_id: &str) -> Result<(), String> {
        let record = self.tasks.record(task_id)?;
        let processes = self
            .processes
            .list_for_task(task_id)?
            .into_iter()
            .map(|process| RecoveredProcessV3 {
                process_handle: process.process_handle,
                target_id: process.target_id,
                owner_target_id: process.owner_target_id,
                channel: format!("{:?}", process.channel).to_ascii_lowercase(),
                state: format!("{:?}", process.state).to_ascii_lowercase(),
                started_at_unix_ms: process.started_at_unix_ms,
                updated_at_unix_ms: process
                    .completed_at_unix_ms
                    .unwrap_or_else(current_unix_ms),
                recovery_advice: if process.state == ProcessLifecycleV3::Running {
                    "The handle is process-local; restart will mark it lost unless a native reattach proof is available.".into()
                } else {
                    "The process reached a native terminal state before persistence.".into()
                },
            })
            .collect::<Vec<_>>();
        let existing = self.persistence.task_recovery(task_id).ok();
        let calls = existing
            .as_ref()
            .map(|recovery| recovery.calls.clone())
            .unwrap_or_default();
        self.persistence.upsert_task(PersistedTaskV3 {
            request: record.request,
            state: match record.state {
                TaskRuntimeStateV3::Active => "active",
                TaskRuntimeStateV3::NeedsReconciliation => "needsReconciliation",
                TaskRuntimeStateV3::Lost => "lost",
                TaskRuntimeStateV3::Completed => "completed",
                TaskRuntimeStateV3::Cancelled => "cancelled",
            }
            .into(),
            phase: match record.state {
                TaskRuntimeStateV3::Active => existing
                    .as_ref()
                    .map_or(TaskPhaseV3::Planning, |recovery| recovery.phase),
                TaskRuntimeStateV3::NeedsReconciliation => TaskPhaseV3::Reconciliation,
                TaskRuntimeStateV3::Lost => TaskPhaseV3::Lost,
                TaskRuntimeStateV3::Completed => TaskPhaseV3::Completed,
                TaskRuntimeStateV3::Cancelled => TaskPhaseV3::Cancelled,
            },
            sequence: record.sequence,
            results: record.results,
            plan: record.plan,
            calls,
            processes,
            last_failure: existing.and_then(|recovery| recovery.last_failure),
            created_at_unix_ms: record.created_at_unix_ms,
            updated_at_unix_ms: record.updated_at_unix_ms,
        })
    }

    pub(crate) fn register_task(
        &self,
        request: AgentRequestV3,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<AgentTaskSnapshotV3, String> {
        if let Some(target) = request.targets.first() {
            self.revalidate_target(target, sessions, database)?;
        }
        let task_id = request.task_id.clone();
        self.context.register_task(&request)?;
        self.extensions.register_task(&request)?;
        self.mcp.register_task(&request)?;
        self.tasks.register(request)?;
        self.persist_task(&task_id)?;
        self.task_snapshot(&task_id)
    }

    pub(crate) fn prepare_authorization(
        &self,
        input: AgentAuthorizeCallRequestV3,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<PreparedAuthorizationV3, String> {
        let request = self.tasks.request(&input.task_id)?;
        if input.request_id != request.request_id {
            return Err("authorization request belongs to another Agent request".into());
        }
        let tool = self
            .registry
            .executable(&input.tool_name)
            .map_err(registry_error_message)?;
        let hook_application = self.extensions.apply_before_tool(
            &input.task_id,
            &input.tool_name,
            &input.arguments,
        )?;
        let call = AgentToolCallV3 {
            request_id: input.request_id,
            call_id: input.call_id,
            tool_name: input.tool_name,
            arguments: hook_application.effective_arguments,
            target: input.target,
            capability_id: "pending-native-capability".into(),
        };
        if !request.targets.iter().any(|target| target == &call.target) {
            return Err("authorization target is not frozen in the task".into());
        }
        validate_tool_arguments_v3(&call.tool_name, &call.arguments)?;
        self.revalidate_target(&call.target, sessions, database)?;
        self.revalidate_process_target(&call.target, &request)?;
        let effect = assess_effect_v3(&tool.descriptor, &call)?;
        let scope = inspect_call_policy_scope_v3(&call)?;
        if let Err(error) = enforce_native_call_policy_v3(&call, &effect, &scope) {
            let _ = self.persistence.audit(audit_event_v3(
                "toolAuthorization",
                Some(&request.task_id),
                Some(&call),
                Some(&effect),
                Some(&scope),
                &format!("denied: {error}"),
            ));
            return Err(error);
        }
        let operator_grant_id = if request.permission_mode == AgentPermissionModeV3::Operator {
            self.operator
                .authorize(&request.task_id, &call, &effect, &scope)?
        } else {
            None
        };
        let operator_auto_approved = operator_grant_id.is_some();
        let requires_native_confirmation = !operator_auto_approved
            && (request.permission_mode == AgentPermissionModeV3::RequestApproval
                || request.permission_mode == AgentPermissionModeV3::Operator
                || scope.sensitive_path_count > 0
                || matches!(
                    effect.kind,
                    AgentEffectKindV3::StateChange
                        | AgentEffectKindV3::Destructive
                        | AgentEffectKindV3::ExternalSideEffect
                ));
        let authorization_source = match operator_grant_id.as_ref() {
            Some(grant_id) => CapabilityAuthorizationSourceV3::OperatorGrant {
                grant_id: grant_id.clone(),
            },
            None if requires_native_confirmation => {
                CapabilityAuthorizationSourceV3::NativeConfirmation
            }
            None => CapabilityAuthorizationSourceV3::ScopedAutopilot,
        };
        let ttl_ms = input.ttl_ms.unwrap_or(DEFAULT_CAPABILITY_TTL_MS);
        if ttl_ms == 0 || ttl_ms > MAX_CAPABILITY_TTL_MS {
            return Err("capability TTL is outside the native limit".into());
        }
        let preview = preview_file_call_v3(&call, database, credentials, known_hosts_path)?;
        let preview_text = if matches!(
            call.tool_name.as_str(),
            "read_file" | "list_directory" | "search_text" | "apply_patch" | "transfer_file"
        ) {
            match preview.diff.as_deref() {
                Some(diff) => format!("{}\n\nExact diff:\n{diff}", preview.summary),
                None => preview.summary.clone(),
            }
        } else {
            native_call_preview(&call)
        };
        let network_summary = if scope.network_destinations.is_empty() {
            "none".to_string()
        } else {
            scope
                .network_destinations
                .iter()
                .map(|destination| {
                    format!(
                        "{}://{}:{}",
                        destination.protocol, destination.host, destination.port
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        let native_prompt = format!(
            "Allow {} on target {} for task {}?\n\nNative effect: {:?}\nSensitive paths: {}\nNetwork destinations: {}\nTTL: {} ms\n{}",
            call.tool_name,
            call.target.target_id(),
            request.task_id,
            effect.kind,
            scope.sensitive_path_count,
            network_summary,
            ttl_ms,
            preview_text
        );
        let mut audit = audit_event_v3(
            "toolAuthorization",
            Some(&request.task_id),
            Some(&call),
            Some(&effect),
            Some(&scope),
            match &authorization_source {
                CapabilityAuthorizationSourceV3::NativeConfirmation => {
                    "native confirmation required"
                }
                CapabilityAuthorizationSourceV3::ScopedAutopilot => {
                    "allowed by native Scoped Autopilot policy"
                }
                CapabilityAuthorizationSourceV3::OperatorGrant { .. } => {
                    "allowed by exact Operator scope"
                }
            },
        );
        audit.grant_id = operator_grant_id.clone();
        self.persistence.audit(audit)?;
        self.persistence.set_phase(
            &request.task_id,
            if requires_native_confirmation {
                TaskPhaseV3::WaitingApproval
            } else {
                TaskPhaseV3::Running
            },
        )?;
        self.extensions.record_event(
            &input.task_id,
            HookEventV3::PermissionRequested,
            Some(&call.tool_name),
            Some(&call.call_id),
            "native policy evaluation requested",
        );
        Ok(PreparedAuthorizationV3 {
            request,
            call,
            effect,
            ttl_ms,
            requires_native_confirmation,
            native_prompt,
            preview,
            hook_decisions: hook_application.decisions,
            authorization_source,
        })
    }

    pub(crate) fn issue_prepared_authorization(
        &self,
        prepared: PreparedAuthorizationV3,
        native_approved: bool,
    ) -> Result<AgentCapabilityGrantV3, String> {
        if prepared.requires_native_confirmation && !native_approved {
            let _ = self
                .persistence
                .set_phase(&prepared.request.task_id, TaskPhaseV3::Failed);
            return Err("native capability approval was denied".into());
        }
        let operator_scope = if let CapabilityAuthorizationSourceV3::OperatorGrant { grant_id } =
            &prepared.authorization_source
        {
            let scope = inspect_call_policy_scope_v3(&prepared.call)?;
            self.operator.validate_auto_approval_source(
                grant_id,
                &prepared.request.task_id,
                &prepared.call,
                &prepared.effect,
                &scope,
                false,
            )?;
            Some((grant_id.clone(), scope))
        } else {
            None
        };
        let bound_call_digest = call_digest(&prepared.call)?;
        let IssuedCapabilityV3 {
            capability_id,
            expires_at_unix_ms,
        } = self
            .capabilities
            .issue(
                CapabilityIssueRequestV3 {
                    request_id: prepared.request.request_id.clone(),
                    user_session_id: prepared.request.user_session_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    call_digest: bound_call_digest,
                    allowed_tools: vec![prepared.call.tool_name.clone()],
                    allowed_effects: vec![prepared.effect.kind],
                    target_ids: vec![prepared.call.target.target_id().to_string()],
                    ttl_ms: prepared.ttl_ms,
                    max_uses: 1,
                    authorization_source: prepared.authorization_source.clone(),
                },
                current_unix_ms(),
            )
            .map_err(|error| format!("native capability issuance failed: {error:?}"))?;
        if let Some((grant_id, scope)) = operator_scope {
            if let Err(error) = self.operator.validate_auto_approval_source(
                &grant_id,
                &prepared.request.task_id,
                &prepared.call,
                &prepared.effect,
                &scope,
                false,
            ) {
                let _ = self.capabilities.revoke(&capability_id);
                return Err(format!(
                    "Operator capability source changed during issuance: {error}"
                ));
            }
        }
        if let AgentToolTargetV3::Remote {
            profile_id: Some(profile_id),
            ..
        } = &prepared.call.target
        {
            let broker_grant = match self.broker.authorize(
                BrokerAuthorizeRequestV3 {
                    task_id: prepared.request.task_id.clone(),
                    request_id: prepared.request.request_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    target_id: prepared.call.target.target_id().to_string(),
                    tool_name: prepared.call.tool_name.clone(),
                    kind: BrokerRequestKindV3::Credential,
                    purpose: BrokerPurposeV3::RemoteAuthentication,
                    credential_service: Some(REMOTE_PROFILE_BROKER_SERVICE.into()),
                    credential_id: Some(profile_id.clone()),
                    ttl_ms: prepared.ttl_ms,
                },
                &prepared.request,
            ) {
                Ok(grant) => grant,
                Err(error) => {
                    let _ = self.capabilities.revoke(&capability_id);
                    return Err(error);
                }
            };
            let mut audit = audit_event_v3(
                "brokerAuthorized",
                Some(&prepared.request.task_id),
                Some(&prepared.call),
                Some(&prepared.effect),
                None,
                "single-use remote-authentication grant derived from exact native authorization",
            );
            audit.grant_id = Some(broker_grant.grant_id.clone());
            audit.purpose = Some(format!("{:?}", broker_grant.purpose));
            audit.expires_at_unix_ms = Some(broker_grant.expires_at_unix_ms);
            if let Err(error) = self.persistence.audit(audit) {
                let _ = self.broker.revoke(&broker_grant.grant_id);
                let _ = self.capabilities.revoke(&capability_id);
                return Err(error);
            }
        }
        self.persistence
            .set_phase(&prepared.request.task_id, TaskPhaseV3::Running)?;
        Ok(AgentCapabilityGrantV3 {
            capability_id,
            expires_at_unix_ms,
            assessed_effect: prepared.effect,
            effective_arguments: prepared.call.arguments,
            hook_decisions: prepared.hook_decisions,
        })
    }

    pub(crate) fn revoke_capability(&self, capability_id: &str) -> Result<(), String> {
        self.capabilities
            .revoke(capability_id)
            .map_err(|error| format!("native capability revocation failed: {error:?}"))
    }

    pub(crate) fn prepare_checkpoint_restore(
        &self,
        task_id: &str,
        checkpoint_id: &str,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<PreparedCheckpointRestoreV3, String> {
        let root = self.checkpoint_root()?;
        let (checkpoint, original, metadata) =
            self.checkpoints
                .load_for_restore(&root, task_id, checkpoint_id)?;
        enforce_checkpoint_restore_policy_v3(&checkpoint.target_path)?;
        let request = self.tasks.request(task_id)?;
        let target = request
            .targets
            .iter()
            .find(|target| target.target_id() == checkpoint.target_id)
            .cloned()
            .ok_or_else(|| "checkpoint target is outside the frozen task".to_string())?;
        self.revalidate_target(&target, sessions, database)?;
        let current_sha256 = checkpoint_current_digest(
            &target,
            &checkpoint,
            database,
            credentials,
            known_hosts_path,
        )?;
        let native_prompt = format!(
            "Restore checkpoint {} for task {}?\n\nExact target: {}\nCurrent SHA-256: {}\nRestored SHA-256: {}",
            checkpoint.checkpoint_id,
            checkpoint.task_id,
            checkpoint.target_path,
            current_sha256.as_deref().unwrap_or("<missing>"),
            checkpoint.original_sha256.as_deref().unwrap_or("<delete created file>")
        );
        Ok(PreparedCheckpointRestoreV3 {
            checkpoint,
            target,
            original,
            metadata,
            current_sha256,
            native_prompt,
        })
    }

    pub(crate) fn restore_prepared_checkpoint(
        &self,
        prepared: PreparedCheckpointRestoreV3,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentFileCheckpointV3, String> {
        enforce_checkpoint_restore_policy_v3(&prepared.checkpoint.target_path)?;
        let live_digest = checkpoint_current_digest(
            &prepared.target,
            &prepared.checkpoint,
            database,
            credentials,
            known_hosts_path,
        )?;
        if live_digest != prepared.current_sha256 {
            return Err("checkpoint restore target drifted after approval".into());
        }
        restore_checkpoint_content(
            &prepared.target,
            &prepared.checkpoint,
            prepared.original.as_deref(),
            live_digest.as_deref(),
            &prepared.metadata,
            database,
            credentials,
            known_hosts_path,
        )?;
        let verified = checkpoint_current_digest(
            &prepared.target,
            &prepared.checkpoint,
            database,
            credentials,
            known_hosts_path,
        )?;
        if verified != prepared.checkpoint.original_sha256 {
            return Err("checkpoint restore verification failed".into());
        }
        let root = self.checkpoint_root()?;
        self.checkpoints
            .mark_restored(&root, &prepared.checkpoint.checkpoint_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn execute_tool(
        &self,
        task_id: &str,
        call: AgentToolCallV3,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentToolResultV3, String> {
        let registry_result = self.registry.executable(&call.tool_name);
        if registry_result == Err(ToolRegistryErrorV3::UnregisteredTool) {
            return Err("tool is not registered".into());
        }
        let request = self.tasks.begin_call(task_id, &call.call_id)?;
        let tool = match registry_result {
            Ok(tool) => tool,
            Err(error) => {
                let message = registry_error_message(error);
                return self.commit_rejection(task_id, &request, &call, &message);
            }
        };
        if request.request_id != call.request_id
            || !request.targets.iter().any(|target| target == &call.target)
        {
            return self.commit_rejection(task_id, &request, &call, "invalid frozen call target");
        }
        if let Err(error) = self.revalidate_target(&call.target, sessions, database) {
            return self.commit_rejection(task_id, &request, &call, &error);
        }
        if let Err(error) = self.revalidate_process_target(&call.target, &request) {
            return self.commit_rejection(task_id, &request, &call, &error);
        }
        let effect = match assess_effect_v3(&tool.descriptor, &call) {
            Ok(effect) => effect,
            Err(error) => return self.commit_rejection(task_id, &request, &call, &error),
        };
        let scope = match inspect_call_policy_scope_v3(&call) {
            Ok(scope) => scope,
            Err(error) => return self.commit_rejection(task_id, &request, &call, &error),
        };
        if let Err(error) = enforce_native_call_policy_v3(&call, &effect, &scope) {
            let _ = self.persistence.audit(audit_event_v3(
                "toolDispatchPolicy",
                Some(task_id),
                Some(&call),
                Some(&effect),
                Some(&scope),
                &format!("denied at dispatch: {error}"),
            ));
            return self.commit_rejection(task_id, &request, &call, &error);
        }
        let digest = match call_digest(&call) {
            Ok(digest) => digest,
            Err(error) => return self.commit_rejection(task_id, &request, &call, &error),
        };
        let capability = match self.capabilities.verify_bound_call(
            &call.capability_id,
            AgentCapabilityVerificationContextV3 {
                request_id: &request.request_id,
                user_session_id: &request.user_session_id,
                call_id: &call.call_id,
                target_id: call.target.target_id(),
            },
            &digest,
            current_unix_ms(),
        ) {
            Ok(capability) => capability,
            Err(error) => {
                return self.commit_rejection(
                    task_id,
                    &request,
                    &call,
                    &format!("native capability verification failed: {error:?}"),
                )
            }
        };
        let authorization_source = match self.capabilities.authorization_source(&call.capability_id)
        {
            Ok(source) => source,
            Err(error) => {
                return self.commit_rejection(
                    task_id,
                    &request,
                    &call,
                    &format!("native capability source verification failed: {error:?}"),
                )
            }
        };
        if let CapabilityAuthorizationSourceV3::OperatorGrant { grant_id } = &authorization_source {
            if let Err(error) = self
                .operator
                .validate_auto_approval_source(grant_id, task_id, &call, &effect, &scope, false)
            {
                let mut audit = audit_event_v3(
                    "operatorDispatch",
                    Some(task_id),
                    Some(&call),
                    Some(&effect),
                    Some(&scope),
                    &format!("denied at dispatch: {error}"),
                );
                audit.grant_id = Some(grant_id.clone());
                let _ = self.persistence.audit(audit);
                return self.commit_rejection(task_id, &request, &call, &error);
            }
        }
        let decision = self.policy.evaluate(AgentPolicyEvaluationV3 {
            request: &request,
            call: &call,
            assessed_effect: Some(&effect),
            capability: Some(&capability),
            now_unix_ms: current_unix_ms(),
        });
        if decision.outcome != AgentPolicyOutcomeV3::Allow {
            return self.commit_rejection(
                task_id,
                &request,
                &call,
                &format!("native policy denied the call: {:?}", decision.reason),
            );
        }
        if let Err(error) = self
            .capabilities
            .consume(&call.capability_id, current_unix_ms())
        {
            return self.commit_rejection(
                task_id,
                &request,
                &call,
                &format!("native capability could not be consumed: {error:?}"),
            );
        }
        if let CapabilityAuthorizationSourceV3::OperatorGrant { grant_id } = &authorization_source {
            if let Err(error) = self
                .operator
                .validate_auto_approval_source(grant_id, task_id, &call, &effect, &scope, true)
            {
                return self.commit_rejection(task_id, &request, &call, &error);
            }
            let mut audit = audit_event_v3(
                "operatorUsed",
                Some(task_id),
                Some(&call),
                Some(&effect),
                Some(&scope),
                "active exact-scope Operator source verified at dispatch",
            );
            audit.grant_id = Some(grant_id.clone());
            if let Err(error) = self.persistence.audit(audit) {
                return self.commit_rejection(task_id, &request, &call, &error);
            }
        }
        if let AgentToolTargetV3::Remote { profile_id, .. } = &call.target {
            let Some(profile_id) = profile_id.as_deref() else {
                return self.commit_rejection(
                    task_id,
                    &request,
                    &call,
                    "remote dispatch requires a frozen profile id",
                );
            };
            let broker_grant = match self
                .broker
                .consume_remote_authorization(task_id, &call, profile_id)
            {
                Ok(grant) => grant,
                Err(error) => {
                    return self.commit_rejection(task_id, &request, &call, &error);
                }
            };
            let mut audit = audit_event_v3(
                "brokerConsumed",
                Some(task_id),
                Some(&call),
                Some(&effect),
                Some(&scope),
                "single-use remote-authentication grant consumed inside Rust",
            );
            audit.grant_id = Some(broker_grant.grant_id);
            audit.purpose = Some(format!("{:?}", broker_grant.purpose));
            audit.expires_at_unix_ms = Some(broker_grant.expires_at_unix_ms);
            if let Err(error) = self.persistence.audit(audit) {
                return self.commit_rejection(task_id, &request, &call, &error);
            }
        }
        if let Err(error) = self.persistence.audit(audit_event_v3(
            "toolDispatchPolicy",
            Some(task_id),
            Some(&call),
            Some(&effect),
            Some(&scope),
            "native policy revalidated at dispatch",
        )) {
            return self.commit_rejection(task_id, &request, &call, &error);
        }
        if let Err(error) =
            self.persistence
                .mark_call_started(task_id, &call, effect.kind, Some(&scope))
        {
            return self.commit_rejection(
                task_id,
                &request,
                &call,
                &format!("durable recovery journal rejected execution: {error}"),
            );
        }

        let result = match call.tool_name.as_str() {
            "exec_command" => self.execute_command(
                task_id,
                &request,
                &call,
                &effect,
                sessions,
                database,
                credentials,
                known_hosts_path,
                tool.descriptor.default_timeout_ms,
                tool.descriptor.max_concurrency,
            ),
            "write_stdin" => self.write_process(&request, &call, &effect),
            "wait_process" => self.wait_process(&request, &call, &effect),
            "kill_process" => self.kill_process(&request, &call, &effect),
            "read_file" | "list_directory" | "search_text" | "apply_patch" | "transfer_file" => {
                self.execute_file_tool(
                    task_id,
                    &request,
                    &call,
                    &effect,
                    database,
                    credentials,
                    known_hosts_path,
                )
            }
            "update_plan" => self.update_plan(&request, &call, &effect),
            _ => Err("known tool has no M2 execution driver".into()),
        }
        .unwrap_or_else(|error| failed_result(&call, &effect, &error));
        let committed = self.tasks.commit(task_id, &call, result)?;
        self.persistence
            .mark_call_finished(task_id, &call.call_id, committed.status)?;
        let completed_task = self.tasks.mark_completed_if_verified(task_id)?;
        self.persist_task(task_id)?;
        if completed_task {
            self.persistence
                .set_phase(task_id, TaskPhaseV3::Completed)?;
            self.persistence
                .push_notification(Some(task_id), NotificationKindV3::Completed)?;
        } else if committed.status != AgentToolResultStatusV3::Completed {
            self.persistence.set_phase(task_id, TaskPhaseV3::Failed)?;
            self.persistence
                .push_notification(Some(task_id), NotificationKindV3::Failed)?;
        } else {
            self.persistence.set_phase(task_id, TaskPhaseV3::Running)?;
        }
        let event = if committed.status == AgentToolResultStatusV3::Completed {
            HookEventV3::AfterTool
        } else {
            HookEventV3::ToolFailed
        };
        self.extensions.record_event(
            task_id,
            event,
            Some(&call.tool_name),
            Some(&call.call_id),
            &format!("{:?}", committed.status),
        );
        Ok(committed)
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_command(
        &self,
        task_id: &str,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        default_timeout_ms: u64,
        max_concurrency: u16,
    ) -> Result<AgentToolResultV3, String> {
        let arguments: ExecCommandArgumentsV3 = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid exec_command arguments: {error}"))?;
        if arguments.elevated.unwrap_or(false) {
            if request.permission_mode != AgentPermissionModeV3::Operator {
                return Err("elevated execution requires an explicit Operator task".into());
            }
            let scope = inspect_call_policy_scope_v3(call)?;
            self.operator
                .allows_elevation(task_id, call, effect, &scope)?;
            let broker_grant = self.broker.consume_elevation(task_id, call)?;
            let mut audit = audit_event_v3(
                "brokerConsumed",
                Some(task_id),
                Some(call),
                Some(effect),
                None,
                "single-use elevation grant consumed inside Rust",
            );
            audit.grant_id = Some(broker_grant.grant_id);
            audit.purpose = Some(format!("{:?}", broker_grant.purpose));
            audit.expires_at_unix_ms = Some(broker_grant.expires_at_unix_ms);
            self.persistence.audit(audit)?;
            if arguments.channel == AgentExecutionChannelV3::Pty {
                return Err(
                    "elevated PTY execution is denied because prompts could expose credentials"
                        .into(),
                );
            }
        }
        let execution_command = if arguments.elevated.unwrap_or(false) {
            elevated_command_v3(&arguments.command)?
        } else {
            arguments.command.clone()
        };
        let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(default_timeout_ms));
        let background = arguments.background.unwrap_or(false);
        let started = current_unix_ms();
        if arguments.channel == AgentExecutionChannelV3::Pty {
            if background {
                return Err(
                    "M1 PTY execution cannot detach; use Direct Exec for background work".into(),
                );
            }
            let session_id = match &call.target {
                AgentToolTargetV3::Local { session_id, .. }
                | AgentToolTargetV3::Remote { session_id, .. } => session_id,
                _ => return Err("PTY execution requires a terminal target".into()),
            };
            let powershell = matches!(call.target, AgentToolTargetV3::Local { .. })
                && cfg!(target_os = "windows");
            let operation = self
                .pty
                .start(sessions, session_id, &arguments.command, powershell)?;
            let snapshot = operation.wait(timeout)?;
            if snapshot.state == PtyLifecycleV3::TimedOut {
                self.pty
                    .interrupt(sessions, session_id, PtyLifecycleV3::TimedOut);
            }
            self.pty.remove(session_id)?;
            let status = match snapshot.state {
                PtyLifecycleV3::Exited => AgentToolResultStatusV3::Completed,
                PtyLifecycleV3::Cancelled => AgentToolResultStatusV3::Cancelled,
                PtyLifecycleV3::TimedOut => AgentToolResultStatusV3::TimedOut,
                PtyLifecycleV3::Failed => AgentToolResultStatusV3::Failed,
                PtyLifecycleV3::Running => AgentToolResultStatusV3::Failed,
            };
            return Ok(AgentToolResultV3 {
                request_id: request.request_id.clone(),
                call_id: call.call_id.clone(),
                tool_name: call.tool_name.clone(),
                target_id: call.target.target_id().to_string(),
                status,
                summary: snapshot
                    .error
                    .unwrap_or_else(|| format!("PTY command reached {:?}.", snapshot.state)),
                data: Some(json!({
                    "channel": "pty",
                    "state": "exited",
                    "exitCode": snapshot.exit_code,
                    "stdout": "",
                    "stderr": "",
                    "combinedOutput": snapshot.combined_output,
                    "durationMs": current_unix_ms().saturating_sub(started),
                    "truncated": snapshot.truncated
                })),
                artifacts: Vec::new(),
                effects: vec![effect.clone()],
                truncated: Some(snapshot.truncated),
            });
        }

        if self.processes.running_count()? >= max_concurrency as usize {
            return Err("exec_command native concurrency limit was reached".into());
        }
        self.processes.ensure_capacity()?;
        validate_frozen_cwd(&call.target, arguments.cwd.as_deref())?;
        let process = match &call.target {
            AgentToolTargetV3::Local { target_id, cwd, .. } => spawn_local_process_v3(
                task_id.to_string(),
                request.request_id.clone(),
                target_id.clone(),
                &execution_command,
                cwd.as_deref().map(Path::new),
                timeout,
            )?,
            AgentToolTargetV3::Remote { target_id, .. } => {
                let connection = connection_for_remote_target(&call.target, database, credentials)?;
                spawn_remote_process_v3(RemoteProcessStartV3 {
                    task_id: task_id.to_string(),
                    request_id: request.request_id.clone(),
                    owner_target_id: target_id.clone(),
                    command: execution_command,
                    connection,
                    known_hosts_path: known_hosts_path.to_path_buf(),
                    timeout,
                })?
            }
            _ => return Err("Direct Exec requires a local or remote target".into()),
        };
        if let Err(error) = self.processes.insert(Arc::clone(&process)) {
            let _ = process.kill(
                crate::agent_contract_v3::ProcessSignalV3::Kill,
                Duration::from_secs(2),
            );
            return Err(error);
        }
        if let Err(error) = self
            .tasks
            .add_process_target(task_id, process.process_target())
        {
            let _ = process.kill(
                crate::agent_contract_v3::ProcessSignalV3::Kill,
                Duration::from_secs(2),
            );
            return Err(error);
        }

        let snapshot = if background {
            process.snapshot()?
        } else {
            process.wait(timeout.saturating_add(Duration::from_secs(1)))?
        };
        Ok(exec_process_result(
            request, call, effect, snapshot, background,
        ))
    }

    fn write_process(
        &self,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
    ) -> Result<AgentToolResultV3, String> {
        let arguments: WriteStdinArgumentsV3 = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid write_stdin arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        let accepted = self
            .processes
            .get(handle)?
            .write_stdin(arguments.input, arguments.close.unwrap_or(false))?;
        Ok(completed_result(
            request,
            call,
            effect,
            "Process input was accepted.",
            json!({
                "acceptedBytes": accepted,
                "closed": arguments.close.unwrap_or(false)
            }),
            false,
        ))
    }

    fn wait_process(
        &self,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
    ) -> Result<AgentToolResultV3, String> {
        let arguments: WaitProcessArgumentsV3 = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid wait_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        let snapshot = self.processes.get(handle)?.wait(Duration::from_millis(
            arguments.timeout_ms.unwrap_or(30_000),
        ))?;
        let limit = arguments.max_output_bytes.unwrap_or(1_048_576) as usize;
        let (stdout, stdout_cut) = truncate_utf8(&snapshot.stdout, limit.saturating_mul(3) / 4);
        let (stderr, stderr_cut) = truncate_utf8(&snapshot.stderr, limit / 4);
        let truncated =
            snapshot.stdout_truncated || snapshot.stderr_truncated || stdout_cut || stderr_cut;
        Ok(completed_result(
            request,
            call,
            effect,
            if snapshot.state == ProcessLifecycleV3::Running {
                "Process is still running."
            } else {
                "Process reached a terminal state."
            },
            json!({
                "state": if snapshot.state == ProcessLifecycleV3::Running { "running" } else { "exited" },
                "exitCode": snapshot.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": truncated
            }),
            truncated,
        ))
    }

    fn kill_process(
        &self,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
    ) -> Result<AgentToolResultV3, String> {
        let arguments: KillProcessArgumentsV3 = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid kill_process arguments: {error}"))?;
        let handle = process_handle(&call.target)?;
        let snapshot = self.processes.get(handle)?.kill(
            arguments.signal,
            Duration::from_millis(arguments.timeout_ms.unwrap_or(10_000)),
        )?;
        let state = if snapshot.state == ProcessLifecycleV3::Running {
            "terminationRequested"
        } else if snapshot.termination_confirmed {
            "terminated"
        } else {
            "unknown"
        };
        Ok(completed_result(
            request,
            call,
            effect,
            "Process termination request was handled.",
            json!({ "state": state }),
            false,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_file_tool(
        &self,
        task_id: &str,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentToolResultV3, String> {
        let checkpoint_root = self.checkpoint_root()?;
        let output = execute_file_tool_v3(FileExecutionContextV3 {
            task_id,
            call,
            database,
            credentials,
            known_hosts_path,
            checkpoint_root: &checkpoint_root,
            checkpoints: &self.checkpoints,
            operations: &self.file_operations,
        })?;
        let mut observed = effect.clone();
        observed.paths = output.paths;
        Ok(completed_result(
            request,
            call,
            &observed,
            &output.summary,
            output.data,
            output.truncated,
        ))
    }

    fn update_plan(
        &self,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        effect: &AgentObservedEffectV3,
    ) -> Result<AgentToolResultV3, String> {
        let AgentToolTargetV3::Task { task_id, .. } = &call.target else {
            return Err("update_plan requires the Rust-owned task target".into());
        };
        if task_id != &request.task_id {
            return Err("update_plan target belongs to another task".into());
        }
        let arguments: UpdatePlanArgumentsV3 = serde_json::from_value(call.arguments.clone())
            .map_err(|error| format!("invalid update_plan arguments: {error}"))?;
        let plan = self
            .tasks
            .update_plan(&request.task_id, arguments, &self.registry)?;
        Ok(completed_result(
            request,
            call,
            effect,
            "Updated the Rust-authoritative task plan.",
            json!({
                "planVersion": plan.version,
                "acceptedSteps": plan.steps.len()
            }),
            false,
        ))
    }

    fn commit_rejection(
        &self,
        task_id: &str,
        request: &AgentRequestV3,
        call: &AgentToolCallV3,
        reason: &str,
    ) -> Result<AgentToolResultV3, String> {
        let result = AgentToolResultV3 {
            request_id: request.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target.target_id().to_string(),
            status: AgentToolResultStatusV3::Rejected,
            summary: reason.to_string(),
            data: None,
            artifacts: Vec::new(),
            effects: Vec::new(),
            truncated: None,
        };
        // Unknown tool names cannot form a schema-valid v3 result. They still
        // fail closed as a Tauri error and never enter task history.
        if self.registry.get(&call.tool_name).is_err() {
            return Err(reason.to_string());
        }
        let committed = self.tasks.commit(task_id, call, result)?;
        self.persist_task(task_id)?;
        self.persistence.set_phase(task_id, TaskPhaseV3::Failed)?;
        self.persistence
            .push_notification(Some(task_id), NotificationKindV3::Failed)?;
        self.extensions.record_event(
            task_id,
            HookEventV3::ToolFailed,
            Some(&call.tool_name),
            Some(&call.call_id),
            "Rejected",
        );
        Ok(committed)
    }

    fn revalidate_target(
        &self,
        target: &AgentToolTargetV3,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<(), String> {
        match target {
            AgentToolTargetV3::Local { session_id, .. } => {
                let state = sessions.target_state(session_id)?;
                if state.terminal_kind != SessionTerminalKind::Local
                    || state.status != SessionStatus::Connected
                    || state.identity.host != "local"
                {
                    return Err(
                        "local terminal target no longer matches its frozen identity".into(),
                    );
                }
                Ok(())
            }
            AgentToolTargetV3::Remote {
                session_id,
                profile_id,
                host,
                port,
                username,
                ..
            } => {
                let state = sessions.target_state(session_id)?;
                if state.terminal_kind != SessionTerminalKind::Remote
                    || state.status != SessionStatus::Connected
                    || state.identity.host != *host
                    || state.identity.port != *port
                    || state.identity.username != *username
                {
                    return Err(
                        "remote terminal target no longer matches its frozen identity".into(),
                    );
                }
                if let Some(profile_id) = profile_id {
                    let profile = database
                        .get_profile(profile_id)?
                        .ok_or_else(|| "frozen remote profile was not found".to_string())?;
                    if profile.host != *host
                        || profile.port != *port
                        || profile.username != *username
                    {
                        return Err("stored remote profile drifted from the frozen target".into());
                    }
                }
                Ok(())
            }
            AgentToolTargetV3::Process { .. } => Ok(()),
            AgentToolTargetV3::Task { .. } => Ok(()),
            AgentToolTargetV3::Ui { .. } => Err("ask_user is unavailable in the M2 runtime".into()),
        }
    }

    fn revalidate_process_target(
        &self,
        target: &AgentToolTargetV3,
        request: &AgentRequestV3,
    ) -> Result<(), String> {
        let AgentToolTargetV3::Process {
            target_id,
            owner_target_id,
            process_handle,
        } = target
        else {
            return Ok(());
        };
        if !request.targets.iter().any(|candidate| candidate == target) {
            return Err("process target is not registered by Rust".into());
        }
        let process = self.processes.get(process_handle)?;
        let snapshot = process.snapshot()?;
        if snapshot.target_id != *target_id
            || snapshot.owner_target_id != *owner_target_id
            || snapshot.request_id != request.request_id
            || snapshot.task_id != request.task_id
        {
            return Err("process handle does not match its frozen owner".into());
        }
        Ok(())
    }

    pub(crate) fn task_snapshot(&self, task_id: &str) -> Result<AgentTaskSnapshotV3, String> {
        self.tasks
            .records()?
            .into_iter()
            .find(|record| record.request.task_id == task_id)
            .map(|record| self.snapshot_record(record))
            .transpose()?
            .ok_or_else(|| "Agent task was not found".to_string())
    }

    pub(crate) fn list_tasks(&self) -> Result<Vec<AgentTaskSnapshotV3>, String> {
        let mut snapshots = self
            .tasks
            .records()?
            .into_iter()
            .map(|record| self.snapshot_record(record))
            .collect::<Result<Vec<_>, _>>()?;
        snapshots.sort_by_key(|snapshot| snapshot.created_at_unix_ms);
        Ok(snapshots)
    }

    fn snapshot_record(&self, record: AgentTaskRecordV3) -> Result<AgentTaskSnapshotV3, String> {
        self.context.sync_task_state(
            &record.request.task_id,
            record.plan.as_ref(),
            &record.results,
        )?;
        let context = self.context.snapshot(&record.request.task_id)?;
        let extensions = self.extensions.snapshot(&record.request.task_id)?;
        let mcp_servers = self.mcp.snapshots(&record.request.task_id)?;
        let mcp_results = self.mcp.results(&record.request.task_id)?;
        let mut recovery = self.persistence.task_recovery(&record.request.task_id)?;
        recovery.requires_session_rebind = record.restored;
        if record.restored && recovery.disposition == RecoveryDispositionV3::SafeToResume {
            recovery.recovery_advice = "The call journal is safe to resume, but the restarted task must first bind a live session with the same native identity and root; no old capability or process handle is restored.".into();
        }
        Ok(AgentTaskSnapshotV3 {
            processes: self.processes.list_for_task(&record.request.task_id)?,
            plan: record.plan,
            checkpoints: self
                .checkpoint_root
                .lock()
                .map_err(|_| "checkpoint root is unavailable".to_string())?
                .as_ref()
                .map(|root| self.checkpoints.list(root, &record.request.task_id))
                .transpose()?
                .unwrap_or_default(),
            context,
            extensions,
            mcp_servers,
            mcp_results,
            recovery,
            notifications: self
                .persistence
                .notifications()?
                .into_iter()
                .filter(|notification| {
                    notification.task_id.as_deref() == Some(&record.request.task_id)
                })
                .collect(),
            request: record.request,
            state: record.state,
            sequence: record.sequence,
            results: record.results,
            created_at_unix_ms: record.created_at_unix_ms,
            updated_at_unix_ms: record.updated_at_unix_ms,
        })
    }

    pub(crate) fn refresh_context(&self, task_id: &str) -> Result<AgentContextSnapshotV3, String> {
        self.tasks.request(task_id)?;
        self.context.refresh_workspace(task_id)
    }

    pub(crate) fn compact_context(
        &self,
        task_id: &str,
        reason: &str,
    ) -> Result<AgentContextSnapshotV3, String> {
        self.extensions
            .record_event(task_id, HookEventV3::BeforeCompact, None, None, reason);
        let snapshot = self.task_snapshot(task_id)?;
        self.context.compact(
            task_id,
            snapshot.plan.as_ref(),
            &snapshot.results,
            &snapshot.checkpoints,
            reason,
        )
    }

    pub(crate) fn retrieve_context(
        &self,
        request: ContextRetrievalRequestV3,
    ) -> Result<ContextRetrievalV3, String> {
        self.tasks.request(&request.task_id)?;
        self.context.retrieve(request)
    }

    pub(crate) fn refresh_extensions(&self, task_id: &str) -> Result<ExtensionSnapshotV3, String> {
        self.tasks.request(task_id)?;
        let snapshot = self.extensions.refresh(task_id, &self.registry)?;
        self.mcp.reload_config(task_id)?;
        Ok(snapshot)
    }

    pub(crate) fn load_skill(&self, request: LoadSkillRequestV3) -> Result<LoadedSkillV3, String> {
        self.tasks.request(&request.task_id)?;
        self.extensions.load_skill(request, &self.registry)
    }

    pub(crate) fn instantiate_runbook(
        &self,
        request: InstantiateRunbookRequestV3,
    ) -> Result<AgentPlanV3, String> {
        let task = self.task_snapshot(&request.task_id)?;
        let plan_version = task.plan.as_ref().map_or(0, |plan| plan.version);
        let task_id = request.task_id.clone();
        let arguments =
            self.extensions
                .instantiate_runbook(request, plan_version, &self.registry)?;
        self.tasks.update_plan(&task_id, arguments, &self.registry)
    }

    pub(crate) fn mcp_servers(&self, task_id: &str) -> Result<Vec<McpServerSnapshotV3>, String> {
        self.tasks.request(task_id)?;
        self.mcp.snapshots(task_id)
    }

    pub(crate) fn set_mcp_enabled(
        &self,
        request: McpSetEnabledRequestV3,
    ) -> Result<Vec<McpServerSnapshotV3>, String> {
        self.tasks.request(&request.task_id)?;
        self.mcp.set_enabled(request)
    }

    pub(crate) fn refresh_mcp_server(
        &self,
        task_id: &str,
        server_id: &str,
        credentials: &CredentialManager,
    ) -> Result<McpServerSnapshotV3, String> {
        self.tasks.request(task_id)?;
        self.mcp.refresh_server(task_id, server_id, credentials)
    }

    pub(crate) fn mcp_tool_schema(
        &self,
        request: McpToolSchemaRequestV3,
    ) -> Result<McpToolSchemaV3, String> {
        self.tasks.request(&request.task_id)?;
        self.mcp.tool_schema(request)
    }

    pub(crate) fn prepare_mcp_authorization(
        &self,
        input: AgentMcpAuthorizeRequestV3,
        sessions: &SessionManager,
        database: &Database,
    ) -> Result<PreparedMcpAuthorizationV3, String> {
        let request = self.tasks.request(&input.task_id)?;
        if request.request_id != input.request_id {
            return Err("MCP authorization belongs to another Agent request".into());
        }
        let target = request
            .targets
            .iter()
            .find(|target| target.target_id() == input.target_id)
            .ok_or_else(|| "MCP target is outside the frozen task".to_string())?;
        self.revalidate_target(target, sessions, database)?;
        let canonical_requested = format!("mcp::{}::{}", input.server_id, input.tool_name);
        let hook_application = self.extensions.apply_before_tool(
            &input.task_id,
            &canonical_requested,
            &input.arguments,
        )?;
        let assessment = self.mcp.assess_call(
            &input.task_id,
            &input.server_id,
            &input.tool_name,
            &hook_application.effective_arguments,
        )?;
        let ttl_ms = input.ttl_ms.unwrap_or(DEFAULT_CAPABILITY_TTL_MS);
        if ttl_ms == 0 || ttl_ms > MAX_CAPABILITY_TTL_MS {
            return Err("MCP capability TTL is outside the native limit".into());
        }
        // A workspace MCP config names an executable. Even a tool declared
        // read-only therefore starts an untrusted external process and always
        // needs native confirmation in the experimental M3 path.
        let requires_native_confirmation = true;
        let call = AgentMcpCallV3 {
            request_id: input.request_id,
            call_id: input.call_id,
            server_id: input.server_id,
            tool_name: input.tool_name,
            arguments: hook_application.effective_arguments,
            target_id: input.target_id,
            capability_id: "pending-native-capability".into(),
        };
        let native_prompt = format!(
            "Allow experimental MCP tool {} on server {} for task {}?\n\nNative effect: {:?}\nTarget: {}\nTTL: {} ms\n\n{}",
            call.tool_name,
            call.server_id,
            request.task_id,
            assessment.effect,
            call.target_id,
            ttl_ms,
            assessment.summary
        );
        self.extensions.record_event(
            &input.task_id,
            HookEventV3::PermissionRequested,
            Some(&assessment.canonical_tool_name),
            Some(&call.call_id),
            "native MCP policy evaluation requested",
        );
        self.persistence
            .set_phase(&request.task_id, TaskPhaseV3::WaitingApproval)?;
        Ok(PreparedMcpAuthorizationV3 {
            request,
            call,
            canonical_tool_name: assessment.canonical_tool_name,
            effect: assessment.effect,
            ttl_ms,
            hook_decisions: hook_application.decisions,
            requires_native_confirmation,
            native_prompt,
        })
    }

    pub(crate) fn issue_prepared_mcp_authorization(
        &self,
        prepared: PreparedMcpAuthorizationV3,
        native_approved: bool,
    ) -> Result<AgentMcpCapabilityGrantV3, String> {
        if prepared.requires_native_confirmation && !native_approved {
            let _ = self
                .persistence
                .set_phase(&prepared.request.task_id, TaskPhaseV3::Failed);
            return Err("native MCP capability approval was denied".into());
        }
        let digest = mcp_call_digest(&prepared.call)?;
        let credential_ids = self
            .mcp
            .credential_ids(&prepared.request.task_id, &prepared.call.server_id)?;
        let mut broker_grants: Vec<BrokerGrantV3> = Vec::with_capacity(credential_ids.len());
        for credential_id in credential_ids {
            let grant = match self.broker.authorize(
                BrokerAuthorizeRequestV3 {
                    task_id: prepared.request.task_id.clone(),
                    request_id: prepared.request.request_id.clone(),
                    call_id: prepared.call.call_id.clone(),
                    target_id: prepared.call.target_id.clone(),
                    tool_name: prepared.canonical_tool_name.clone(),
                    kind: BrokerRequestKindV3::Credential,
                    purpose: BrokerPurposeV3::McpAuthentication,
                    credential_service: Some(MCP_CREDENTIAL_SERVICE.into()),
                    credential_id: Some(credential_id),
                    ttl_ms: prepared.ttl_ms,
                },
                &prepared.request,
            ) {
                Ok(grant) => grant,
                Err(error) => {
                    for issued in &broker_grants {
                        let _ = self.broker.revoke(&issued.grant_id);
                    }
                    return Err(error);
                }
            };
            let mut audit = audit_event_v3(
                "brokerAuthorized",
                Some(&prepared.request.task_id),
                None,
                None,
                None,
                "single-use MCP credential grant issued after native confirmation",
            );
            audit.grant_id = Some(grant.grant_id.clone());
            audit.target_id = Some(grant.target_id.clone());
            audit.tool_name = Some(grant.tool_name.clone());
            audit.purpose = Some(format!("{:?}", grant.purpose));
            audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
            if let Err(error) = self.persistence.audit(audit) {
                let _ = self.broker.revoke(&grant.grant_id);
                for issued in &broker_grants {
                    let _ = self.broker.revoke(&issued.grant_id);
                }
                return Err(error);
            }
            broker_grants.push(grant);
        }
        let issued = match self.capabilities.issue(
            CapabilityIssueRequestV3 {
                request_id: prepared.request.request_id.clone(),
                user_session_id: prepared.request.user_session_id.clone(),
                call_id: prepared.call.call_id.clone(),
                call_digest: digest,
                allowed_tools: vec![prepared.canonical_tool_name.clone()],
                allowed_effects: vec![prepared.effect],
                target_ids: vec![prepared.call.target_id.clone()],
                ttl_ms: prepared.ttl_ms,
                max_uses: 1,
                authorization_source: CapabilityAuthorizationSourceV3::NativeConfirmation,
            },
            current_unix_ms(),
        ) {
            Ok(issued) => issued,
            Err(error) => {
                for grant in &broker_grants {
                    let _ = self.broker.revoke(&grant.grant_id);
                }
                return Err(format!("native MCP capability issuance failed: {error:?}"));
            }
        };
        self.persistence
            .set_phase(&prepared.request.task_id, TaskPhaseV3::Running)?;
        Ok(AgentMcpCapabilityGrantV3 {
            capability_id: issued.capability_id,
            expires_at_unix_ms: issued.expires_at_unix_ms,
            assessed_effect: prepared.effect,
            effective_arguments: prepared.call.arguments,
            hook_decisions: prepared.hook_decisions,
        })
    }

    pub(crate) fn execute_mcp_call(
        &self,
        task_id: &str,
        call: AgentMcpCallV3,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
    ) -> Result<AgentMcpResultV3, String> {
        let request = self.tasks.request(task_id)?;
        if request.request_id != call.request_id {
            return Err("MCP call belongs to another Agent request".into());
        }
        let target = request
            .targets
            .iter()
            .find(|target| target.target_id() == call.target_id)
            .ok_or_else(|| "MCP call target is outside the frozen task".to_string())?;
        self.revalidate_target(target, sessions, database)?;
        let assessment =
            self.mcp
                .assess_call(task_id, &call.server_id, &call.tool_name, &call.arguments)?;
        self.capabilities
            .verify_extension_bound_call(
                &call.capability_id,
                AgentCapabilityVerificationContextV3 {
                    request_id: &request.request_id,
                    user_session_id: &request.user_session_id,
                    call_id: &call.call_id,
                    target_id: &call.target_id,
                },
                &mcp_call_digest(&call)?,
                &assessment.canonical_tool_name,
                assessment.effect,
                current_unix_ms(),
            )
            .map_err(|error| format!("native MCP capability verification failed: {error:?}"))?;
        self.capabilities
            .consume(&call.capability_id, current_unix_ms())
            .map_err(|error| format!("native MCP capability could not be consumed: {error:?}"))?;
        let recovery_call = AgentToolCallV3 {
            request_id: call.request_id.clone(),
            call_id: call.call_id.clone(),
            tool_name: assessment.canonical_tool_name.clone(),
            arguments: call.arguments.clone(),
            target: target.clone(),
            capability_id: call.capability_id.clone(),
        };
        self.persistence
            .mark_call_started(task_id, &recovery_call, assessment.effect, None)?;
        let invocation = (|| {
            let required_references = self
                .mcp
                .credential_ids(task_id, &call.server_id)?
                .into_iter()
                .map(|credential_id| (MCP_CREDENTIAL_SERVICE.to_string(), credential_id))
                .collect::<Vec<_>>();
            let bundle = self.broker.consume_credentials(
                task_id,
                &recovery_call,
                BrokerPurposeV3::McpAuthentication,
                &required_references,
                credentials,
            )?;
            for grant in &bundle.grants {
                let mut audit = audit_event_v3(
                    "brokerConsumed",
                    Some(task_id),
                    Some(&recovery_call),
                    None,
                    None,
                    "single-use MCP credential grant consumed inside Rust",
                );
                audit.grant_id = Some(grant.grant_id.clone());
                audit.purpose = Some(format!("{:?}", grant.purpose));
                audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
                self.persistence.audit(audit)?;
            }
            self.mcp.invoke_call(task_id, &call, &bundle.values_by_id)
        })();
        let (status, data, truncated) = match invocation {
            Ok((data, truncated)) => (mcp_result_status(&data), data, truncated),
            Err(error) => (
                "failed",
                json!({"error": crate::redaction::redact_sensitive_text(&error)}),
                false,
            ),
        };
        let result = AgentMcpResultV3 {
            request_id: call.request_id.clone(),
            call_id: call.call_id.clone(),
            server_id: call.server_id.clone(),
            tool_name: call.tool_name.clone(),
            target_id: call.target_id.clone(),
            status: status.into(),
            data,
            effect: assessment.effect,
            untrusted: true,
            truncated,
        };
        self.mcp.record_result(task_id, result.clone())?;
        self.persistence.mark_call_finished(
            task_id,
            &call.call_id,
            if status == "completed" {
                AgentToolResultStatusV3::Completed
            } else {
                AgentToolResultStatusV3::Failed
            },
        )?;
        self.persist_task(task_id)?;
        if status != "completed" {
            let failure = result
                .data
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("MCP tool execution returned a native failure");
            self.persistence.set_last_failure(task_id, failure)?;
            self.persistence.set_phase(task_id, TaskPhaseV3::Failed)?;
            self.persistence
                .push_notification(Some(task_id), NotificationKindV3::Failed)?;
        } else {
            self.persistence.set_phase(task_id, TaskPhaseV3::Running)?;
        }
        self.extensions.record_event(
            task_id,
            if status == "completed" {
                HookEventV3::AfterTool
            } else {
                HookEventV3::ToolFailed
            },
            Some(&assessment.canonical_tool_name),
            Some(&call.call_id),
            status,
        );
        Ok(result)
    }

    pub(crate) fn recovery_status(&self) -> Result<RecoveryStoreStatusV3, String> {
        self.persistence.status()
    }

    pub(crate) fn notifications(&self) -> Result<Vec<AgentNotificationV3>, String> {
        self.persistence.notifications()
    }

    pub(crate) fn mark_notification_delivered(&self, id: &str) -> Result<(), String> {
        self.persistence.mark_notification_delivered(id)
    }

    pub(crate) fn audit_entries(&self) -> Result<Vec<AgentAuditEventV3>, String> {
        self.persistence.audit_entries()
    }

    pub(crate) fn configure_operator(
        &self,
        request: OperatorConfigureRequestV3,
    ) -> Result<OperatorGrantV3, String> {
        let task = self.tasks.request(&request.task_id)?;
        let grant = self
            .operator
            .configure(request, &task, &self.registry.list())?;
        let mut audit = audit_event_v3(
            "operatorConfigured",
            Some(&task.task_id),
            None,
            None,
            None,
            "allowed with bounded scope and TTL",
        );
        audit.grant_id = Some(grant.grant_id.clone());
        audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
        audit.scope_target_ids = grant.target_ids.clone();
        audit.scope_tool_names = grant.tool_names.clone();
        audit.scope_effects = grant.effects.clone();
        audit.scope_path_count = grant.path_prefixes.len();
        audit.network_destinations = grant.network_destinations.clone();
        self.persistence.audit(audit)?;
        Ok(grant)
    }

    pub(crate) fn operator_grants(&self) -> Result<Vec<OperatorGrantV3>, String> {
        for grant in self.operator.expiring()? {
            self.persistence
                .push_notification(Some(&grant.task_id), NotificationKindV3::OperatorExpiring)?;
        }
        self.operator.list()
    }

    pub(crate) fn revoke_operator(&self, grant_id: &str) -> Result<OperatorGrantV3, String> {
        let grant = self.operator.revoke(grant_id)?;
        let revoked_capabilities = self
            .capabilities
            .revoke_operator_capabilities(grant_id)
            .map_err(|error| {
                format!("failed to revoke Operator-derived capabilities: {error:?}")
            })?;
        let mut audit = audit_event_v3(
            "operatorRevoked",
            Some(&grant.task_id),
            None,
            None,
            None,
            &format!("revoked with {revoked_capabilities} derived capability record(s)"),
        );
        audit.grant_id = Some(grant.grant_id.clone());
        audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
        audit.scope_target_ids = grant.target_ids.clone();
        audit.scope_tool_names = grant.tool_names.clone();
        audit.scope_effects = grant.effects.clone();
        audit.scope_path_count = grant.path_prefixes.len();
        audit.network_destinations = grant.network_destinations.clone();
        self.persistence.audit(audit)?;
        Ok(grant)
    }

    pub(crate) fn authorize_broker(
        &self,
        request: BrokerAuthorizeRequestV3,
    ) -> Result<BrokerGrantV3, String> {
        let task = self.tasks.request(&request.task_id)?;
        let grant = self.broker.authorize(request, &task)?;
        let mut audit = audit_event_v3(
            "brokerAuthorized",
            Some(&task.task_id),
            None,
            None,
            None,
            "single-use native broker grant issued",
        );
        audit.grant_id = Some(grant.grant_id.clone());
        audit.target_id = Some(grant.target_id.clone());
        audit.tool_name = Some(grant.tool_name.clone());
        audit.purpose = Some(format!("{:?}", grant.purpose));
        audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
        self.persistence.audit(audit)?;
        Ok(grant)
    }

    pub(crate) fn broker_grants(&self) -> Result<Vec<BrokerGrantV3>, String> {
        self.broker.list()
    }

    pub(crate) fn revoke_broker(&self, grant_id: &str) -> Result<BrokerGrantV3, String> {
        let grant = self.broker.revoke(grant_id)?;
        let mut audit = audit_event_v3(
            "brokerRevoked",
            Some(&grant.task_id),
            None,
            None,
            None,
            "revoked",
        );
        audit.grant_id = Some(grant.grant_id.clone());
        audit.target_id = Some(grant.target_id.clone());
        audit.tool_name = Some(grant.tool_name.clone());
        audit.purpose = Some(format!("{:?}", grant.purpose));
        audit.expires_at_unix_ms = Some(grant.expires_at_unix_ms);
        self.persistence.audit(audit)?;
        Ok(grant)
    }

    pub(crate) fn reconcile_task(
        &self,
        task_id: &str,
        continue_task: bool,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentTaskSnapshotV3, String> {
        let record = self.tasks.record(task_id)?;
        if continue_task {
            validate_recovery_policy_configuration_v3(record.request.permission_mode)?;
            let targets = record
                .request
                .targets
                .iter()
                .filter(|target| {
                    matches!(
                        target,
                        AgentToolTargetV3::Local { .. } | AgentToolTargetV3::Remote { .. }
                    )
                })
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return Err("recovery target was not found".into());
            }
            for target in targets {
                self.revalidate_target(target, sessions, database)?;
                self.revalidate_recovery_root_and_host(
                    target,
                    database,
                    credentials,
                    known_hosts_path,
                )?;
            }
        }
        self.tasks.reconcile(task_id, continue_task)?;
        self.persistence
            .resolve_reconciliation(task_id, continue_task)?;
        self.persist_task(task_id)?;
        self.persistence.audit(audit_event_v3(
            "taskReconciled",
            Some(task_id),
            None,
            None,
            None,
            if continue_task {
                "continued without replay"
            } else {
                "cancelled without replay"
            },
        ))?;
        self.task_snapshot(task_id)
    }

    pub(crate) fn rebind_recovery_session(
        &self,
        task_id: &str,
        replacement_session_id: &str,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<AgentTaskSnapshotV3, String> {
        let record = self.tasks.record(task_id)?;
        if !(matches!(
            record.state,
            TaskRuntimeStateV3::NeedsReconciliation | TaskRuntimeStateV3::Lost
        ) || record.state == TaskRuntimeStateV3::Active && record.restored)
        {
            return Err("task is not awaiting recovery session rebind".into());
        }
        let host_targets = record
            .request
            .targets
            .iter()
            .filter(|target| {
                matches!(
                    target,
                    AgentToolTargetV3::Local { .. } | AgentToolTargetV3::Remote { .. }
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        if host_targets.len() != 1 {
            return Err("recovery session rebind requires exactly one frozen host target".into());
        }
        let mut candidate = host_targets
            .into_iter()
            .next()
            .ok_or_else(|| "recovery host target was not found".to_string())?;
        match &mut candidate {
            AgentToolTargetV3::Local { session_id, .. }
            | AgentToolTargetV3::Remote { session_id, .. } => {
                *session_id = replacement_session_id.to_string();
            }
            _ => unreachable!("host target was selected above"),
        }
        self.revalidate_target(&candidate, sessions, database)?;
        self.revalidate_recovery_root_and_host(
            &candidate,
            database,
            credentials,
            known_hosts_path,
        )?;
        self.tasks.rebind_session(task_id, replacement_session_id)?;
        let rebound = self.tasks.record(task_id)?.request;
        self.context.rebind_task_request(&rebound)?;
        self.extensions.rebind_task_request(&rebound)?;
        self.mcp.rebind_task_request(&rebound)?;
        self.persist_task(task_id)?;
        self.persistence.audit(audit_event_v3(
            "recoverySessionRebound",
            Some(task_id),
            None,
            None,
            None,
            "replacement session matched frozen native identity and roots",
        ))?;
        self.task_snapshot(task_id)
    }

    fn revalidate_recovery_root_and_host(
        &self,
        target: &AgentToolTargetV3,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
    ) -> Result<(), String> {
        match target {
            AgentToolTargetV3::Local { cwd: Some(cwd), .. } => {
                let path = Path::new(cwd);
                let metadata = fs::symlink_metadata(path).map_err(|error| {
                    format!("failed to revalidate local recovery root: {error}")
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("local recovery root is not a real directory".into());
                }
                path.canonicalize().map_err(|error| {
                    format!("failed to canonicalize local recovery root: {error}")
                })?;
                Ok(())
            }
            AgentToolTargetV3::Local { cwd: None, .. } => Ok(()),
            AgentToolTargetV3::Remote {
                root_path: Some(root_path),
                ..
            } => {
                let connection = connection_for_remote_target(target, database, credentials)?;
                let connected =
                    connect_sftp(&connection, None, Some(known_hosts_path)).map_err(|error| {
                        format!("failed to reconnect remote recovery target: {error:?}")
                    })?;
                let connected = connected
                    .lock()
                    .map_err(|_| "remote recovery connection is unavailable".to_string())?;
                let canonical = connected
                    .sftp
                    .realpath(Path::new(root_path))
                    .map_err(|error| format!("failed to revalidate remote recovery root: {error}"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if canonical.trim_end_matches('/') != root_path.trim_end_matches('/') {
                    return Err("remote recovery root identity drifted".into());
                }
                Ok(())
            }
            AgentToolTargetV3::Remote {
                root_path: None, ..
            } => {
                let connection = connection_for_remote_target(target, database, credentials)?;
                let _verified =
                    connect_sftp(&connection, None, Some(known_hosts_path)).map_err(|error| {
                        format!("failed to reconnect remote recovery target: {error:?}")
                    })?;
                Ok(())
            }
            _ => Err("recovery requires a frozen local or remote host target".into()),
        }
    }

    pub(crate) fn cancel_task(
        &self,
        task_id: &str,
        sessions: &SessionManager,
    ) -> Result<(), String> {
        let request = self.tasks.request(task_id)?;
        self.processes.cancel_task(task_id)?;
        self.file_operations.cancel_task(task_id)?;
        for target in &request.targets {
            if let AgentToolTargetV3::Local { session_id, .. }
            | AgentToolTargetV3::Remote { session_id, .. } = target
            {
                self.pty
                    .interrupt(sessions, session_id, PtyLifecycleV3::Cancelled);
                let _ = self.pty.remove(session_id);
            }
        }
        self.tasks.cancel(task_id)?;
        self.persist_task(task_id)?;
        self.extensions
            .record_event(task_id, HookEventV3::SessionEnd, None, None, "cancelled");
        Ok(())
    }

    pub(crate) fn prepare_for_shutdown(&self, sessions: &SessionManager) -> Result<usize, String> {
        let mut prepared = self
            .shutdown_prepared
            .lock()
            .map_err(|_| "Agent M4 shutdown state is unavailable".to_string())?;
        if *prepared {
            return Ok(0);
        }
        let records = self.tasks.records()?;
        let active = records
            .into_iter()
            .filter(|record| record.state == TaskRuntimeStateV3::Active)
            .collect::<Vec<_>>();
        for record in &active {
            let task_id = &record.request.task_id;
            self.persist_task(task_id)?;
            self.processes.cancel_task(task_id)?;
            self.file_operations.cancel_task(task_id)?;
            for target in &record.request.targets {
                if let AgentToolTargetV3::Local { session_id, .. }
                | AgentToolTargetV3::Remote { session_id, .. } = target
                {
                    self.pty
                        .interrupt(sessions, session_id, PtyLifecycleV3::Cancelled);
                    let _ = self.pty.remove(session_id);
                }
            }
        }
        *prepared = true;
        Ok(active.len())
    }

    pub(crate) fn observe_pty_output(&self, session_id: &str, chunk: &str) {
        self.pty.observe(session_id, chunk);
    }
}

fn validate_plan_update(
    task: &AgentTaskRecordV3,
    arguments: &UpdatePlanArgumentsV3,
    registry: &ToolRegistryV3,
) -> Result<(), String> {
    let mut steps_by_id = HashMap::new();
    for step in &arguments.steps {
        if steps_by_id.insert(step.id.as_str(), step).is_some() {
            return Err("plan contains duplicate step ids".into());
        }
        if step
            .dependencies
            .iter()
            .any(|dependency| dependency == &step.id)
        {
            return Err("plan step cannot depend on itself".into());
        }
        for target_id in &step.target_ids {
            if !task
                .request
                .targets
                .iter()
                .any(|target| target.target_id() == target_id)
            {
                return Err("plan references a target outside the frozen task".into());
            }
        }
        let mut effect_is_supported = false;
        for tool_name in &step.required_tools {
            let tool = registry
                .executable(tool_name)
                .map_err(|error| match error {
                    ToolRegistryErrorV3::UnregisteredTool => {
                        "plan references an unregistered tool".to_string()
                    }
                    ToolRegistryErrorV3::ToolUnavailable => {
                        "plan references a tool unavailable in M2".to_string()
                    }
                    _ => "plan tool descriptor is invalid".to_string(),
                })?;
            if !step.target_ids.iter().any(|target_id| {
                task.request.targets.iter().any(|target| {
                    target.target_id() == target_id
                        && tool.descriptor.target_kinds.contains(&target.kind())
                })
            }) {
                return Err("plan tool cannot operate on any selected target".into());
            }
            effect_is_supported |= tool
                .descriptor
                .allowed_effects
                .contains(&step.expected_effect);
        }
        if !effect_is_supported {
            return Err("plan expected effect is outside its required tool set".into());
        }
        if step.status == PlanStepStatusV3::Completed {
            if step.evidence_refs.is_empty() {
                return Err("completed plan steps require verification evidence".into());
            }
            let mut has_verification_evidence = false;
            for evidence in &step.evidence_refs {
                let result = task
                    .results
                    .iter()
                    .find(|result| result.call_id == *evidence)
                    .ok_or_else(|| "plan evidence does not belong to this task".to_string())?;
                if result.status != AgentToolResultStatusV3::Completed {
                    return Err("plan evidence is not a completed native result".into());
                }
                has_verification_evidence |=
                    result.effects.iter().any(|effect| {
                        matches!(
                            effect.kind,
                            AgentEffectKindV3::ReadOnly | AgentEffectKindV3::SensitiveRead
                        )
                    }) || matches!(result.tool_name.as_str(), "apply_patch" | "transfer_file")
                        && result
                            .data
                            .as_ref()
                            .and_then(|data| data.get("verified"))
                            .and_then(Value::as_bool)
                            == Some(true);
            }
            if !has_verification_evidence {
                return Err("completed plan step has no native verification evidence".into());
            }
        }
    }
    for step in &arguments.steps {
        for dependency in &step.dependencies {
            if !steps_by_id.contains_key(dependency.as_str()) {
                return Err("plan dependency does not exist".into());
            }
            if matches!(
                step.status,
                PlanStepStatusV3::InProgress | PlanStepStatusV3::Completed
            ) && steps_by_id[dependency.as_str()].status != PlanStepStatusV3::Completed
            {
                return Err("active or completed plan step has an incomplete dependency".into());
            }
        }
    }

    let mut remaining_dependencies = arguments
        .steps
        .iter()
        .map(|step| (step.id.as_str(), step.dependencies.len()))
        .collect::<HashMap<_, _>>();
    let mut ready = remaining_dependencies
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for step in &arguments.steps {
            if step.dependencies.iter().any(|dependency| dependency == id) {
                let count = remaining_dependencies
                    .get_mut(step.id.as_str())
                    .expect("validated plan step exists");
                *count -= 1;
                if *count == 0 {
                    ready.push(step.id.as_str());
                }
            }
        }
    }
    if visited != arguments.steps.len() {
        return Err("plan dependency graph contains a cycle".into());
    }
    Ok(())
}

fn checkpoint_local_root(target: &AgentToolTargetV3) -> Result<&Path, String> {
    match target {
        AgentToolTargetV3::Local {
            cwd: Some(root), ..
        } => Ok(Path::new(root)),
        AgentToolTargetV3::Remote {
            local_root: Some(root),
            ..
        } => Ok(Path::new(root)),
        _ => Err("checkpoint has no frozen local root".into()),
    }
}

fn checkpoint_current_digest(
    target: &AgentToolTargetV3,
    checkpoint: &AgentFileCheckpointV3,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
) -> Result<Option<String>, String> {
    match checkpoint.target_kind {
        super::CheckpointTargetKindV3::Local => {
            current_local_digest_v3(checkpoint_local_root(target)?, &checkpoint.target_path)
        }
        super::CheckpointTargetKindV3::Remote => {
            let AgentToolTargetV3::Remote {
                root_path: Some(root),
                ..
            } = target
            else {
                return Err("remote checkpoint has no frozen remote root".into());
            };
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("failed to connect for checkpoint restore: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            current_remote_digest_v3(&connected.sftp, root, &checkpoint.target_path)
        }
    }
}

fn restore_checkpoint_content(
    target: &AgentToolTargetV3,
    checkpoint: &AgentFileCheckpointV3,
    original: Option<&[u8]>,
    current_digest: Option<&str>,
    metadata: &CheckpointOriginalMetadataV3,
    database: &Database,
    credentials: &CredentialManager,
    known_hosts_path: &Path,
) -> Result<(), String> {
    match checkpoint.target_kind {
        super::CheckpointTargetKindV3::Local => restore_local_checkpoint_v3(
            checkpoint_local_root(target)?,
            &checkpoint.target_path,
            original,
            current_digest,
            metadata,
        ),
        super::CheckpointTargetKindV3::Remote => {
            let AgentToolTargetV3::Remote {
                root_path: Some(root),
                ..
            } = target
            else {
                return Err("remote checkpoint has no frozen remote root".into());
            };
            let connection = connection_for_remote_target(target, database, credentials)?;
            let connected = connect_sftp(&connection, None, Some(known_hosts_path))
                .map_err(|error| format!("failed to connect for checkpoint restore: {error:?}"))?;
            let connected = connected
                .lock()
                .map_err(|_| "native SFTP connection is unavailable".to_string())?;
            restore_remote_checkpoint_v3(
                &connected.sftp,
                root,
                &checkpoint.target_path,
                original,
                current_digest,
                metadata,
            )
        }
    }
}

fn registry_error_message(error: ToolRegistryErrorV3) -> String {
    match error {
        ToolRegistryErrorV3::UnregisteredTool => "tool is not registered".into(),
        ToolRegistryErrorV3::ToolUnavailable => {
            "tool is known but unavailable in the M2 runtime".into()
        }
        _ => "tool registry rejected the descriptor".into(),
    }
}

fn call_digest(call: &AgentToolCallV3) -> Result<String, String> {
    let canonical = serde_json::to_vec(&json!({
        "requestId": call.request_id,
        "callId": call.call_id,
        "toolName": call.tool_name,
        "arguments": call.arguments,
        "target": call.target,
    }))
    .map_err(|error| format!("failed to bind capability to tool call: {error}"))?;
    Ok(Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn mcp_call_digest(call: &AgentMcpCallV3) -> Result<String, String> {
    let canonical = serde_json::to_vec(&json!({
        "requestId": call.request_id,
        "callId": call.call_id,
        "serverId": call.server_id,
        "toolName": call.tool_name,
        "arguments": call.arguments,
        "targetId": call.target_id,
    }))
    .map_err(|error| format!("failed to bind capability to MCP call: {error}"))?;
    Ok(Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn native_call_preview(call: &AgentToolCallV3) -> String {
    match call.tool_name.as_str() {
        "exec_command" => call
            .arguments
            .get("command")
            .and_then(Value::as_str)
            .map(|command| format!("Command:\n{command}"))
            .unwrap_or_else(|| "Command arguments are invalid.".into()),
        "write_stdin" => call
            .arguments
            .get("input")
            .and_then(Value::as_str)
            .map(|input| format!("Input bytes: {}", input.len()))
            .unwrap_or_else(|| "Process input arguments are invalid.".into()),
        "wait_process" => "Wait for or read the bound process handle.".into(),
        "kill_process" => call
            .arguments
            .get("signal")
            .and_then(Value::as_str)
            .map(|signal| format!("Signal: {signal}"))
            .unwrap_or_else(|| "Process termination arguments are invalid.".into()),
        _ => "Unavailable M1 tool.".into(),
    }
}

fn process_handle(target: &AgentToolTargetV3) -> Result<&str, String> {
    match target {
        AgentToolTargetV3::Process { process_handle, .. } => Ok(process_handle),
        _ => Err("process tool requires a Rust-issued process target".into()),
    }
}

fn validate_frozen_cwd(
    target: &AgentToolTargetV3,
    argument_cwd: Option<&str>,
) -> Result<(), String> {
    match target {
        AgentToolTargetV3::Local { cwd, .. } => {
            if cwd.as_deref() != argument_cwd {
                return Err("exec_command cwd differs from the frozen target".into());
            }
            Ok(())
        }
        AgentToolTargetV3::Remote { .. } if argument_cwd.is_some() => {
            Err("M1 remote Direct Exec does not accept an unfrozen cwd".into())
        }
        _ => Ok(()),
    }
}

fn elevated_command_v3(command: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        let _ = command;
        Err("captured Windows elevation is unavailable; native policy fails closed".into())
    }
    #[cfg(not(windows))]
    {
        let quoted = format!("'{}'", command.replace('\'', "'\\''"));
        Ok(format!("sudo -n -- /bin/sh -lc {quoted}"))
    }
}

pub(super) fn connection_for_remote_target(
    target: &AgentToolTargetV3,
    database: &Database,
    credentials: &CredentialManager,
) -> Result<RemoteConnectionRequest, String> {
    let AgentToolTargetV3::Remote {
        profile_id: Some(profile_id),
        host,
        port,
        username,
        ..
    } = target
    else {
        return Err("remote Direct Exec requires a frozen profile id".into());
    };
    let profile = database
        .get_profile(profile_id)?
        .ok_or_else(|| "remote Direct Exec profile was not found".to_string())?;
    if profile.host != *host || profile.port != *port || profile.username != *username {
        return Err("remote Direct Exec profile identity drifted".into());
    }
    let auth_method = match profile.auth_method {
        ProfileAuthMethod::Password => AuthMethod::Password,
        ProfileAuthMethod::Key => AuthMethod::Key,
    };
    let mut jump_host = profile
        .jump_host_config
        .as_deref()
        .map(serde_json::from_str::<JumpHostConfig>)
        .transpose()
        .map_err(|error| format!("stored jump-host identity is invalid: {error}"))?;
    if let Some(jump) = jump_host.as_mut() {
        match jump.auth_method {
            AuthMethod::Password => {
                jump.password = credentials
                    .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassword)?;
                if jump.password.is_none() {
                    return Err("jump-host password is unavailable".into());
                }
            }
            AuthMethod::Key => {
                jump.passphrase = credentials
                    .retrieve_profile_secret(profile_id, ProfileSecretKind::JumpPassphrase)?;
            }
        }
    }
    let mut connection = RemoteConnectionRequest {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        auth_method,
        password: if auth_method == AuthMethod::Password {
            credentials.retrieve_profile_password(profile_id)?
        } else {
            None
        },
        keychain_key_id: profile.keychain_key_id,
        private_key_data: None,
        passphrase: if auth_method == AuthMethod::Key {
            credentials.retrieve_profile_secret(profile_id, ProfileSecretKind::Passphrase)?
        } else {
            None
        },
        jump_host,
    };
    if auth_method == AuthMethod::Password && connection.password.is_none() {
        return Err("remote profile password is unavailable".into());
    }
    crate::commands::resolve_keychain_key_for_remote(credentials, &mut connection)?;
    if auth_method == AuthMethod::Key && connection.private_key_data.is_none() {
        return Err("remote profile private key is unavailable".into());
    }
    Ok(connection)
}

fn exec_process_result(
    request: &AgentRequestV3,
    call: &AgentToolCallV3,
    effect: &AgentObservedEffectV3,
    snapshot: ProcessSnapshotV3,
    background: bool,
) -> AgentToolResultV3 {
    let status = if background && snapshot.state == ProcessLifecycleV3::Running {
        AgentToolResultStatusV3::Completed
    } else {
        match snapshot.state {
            ProcessLifecycleV3::Running => AgentToolResultStatusV3::Failed,
            ProcessLifecycleV3::Exited => AgentToolResultStatusV3::Completed,
            ProcessLifecycleV3::Cancelled => AgentToolResultStatusV3::Cancelled,
            ProcessLifecycleV3::TimedOut => AgentToolResultStatusV3::TimedOut,
            ProcessLifecycleV3::Failed => AgentToolResultStatusV3::Failed,
        }
    };
    let truncated = snapshot.stdout_truncated || snapshot.stderr_truncated;
    AgentToolResultV3 {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status,
        summary: snapshot.error.unwrap_or_else(|| {
            if snapshot.state == ProcessLifecycleV3::Running {
                "Direct command is running under a native process handle.".into()
            } else {
                format!("Direct command reached {:?}.", snapshot.state)
            }
        }),
        data: Some(json!({
            "channel": "direct",
            "state": if snapshot.state == ProcessLifecycleV3::Running { "running" } else { "exited" },
            "exitCode": snapshot.exit_code,
            "stdout": snapshot.stdout,
            "stderr": snapshot.stderr,
            "processHandle": snapshot.process_handle,
            "durationMs": snapshot.completed_at_unix_ms.unwrap_or_else(current_unix_ms)
                .saturating_sub(snapshot.started_at_unix_ms),
            "truncated": truncated
        })),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: Some(truncated),
    }
}

fn completed_result(
    request: &AgentRequestV3,
    call: &AgentToolCallV3,
    effect: &AgentObservedEffectV3,
    summary: &str,
    data: Value,
    truncated: bool,
) -> AgentToolResultV3 {
    AgentToolResultV3 {
        request_id: request.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status: AgentToolResultStatusV3::Completed,
        summary: summary.into(),
        data: Some(data),
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: Some(truncated),
    }
}

fn failed_result(
    call: &AgentToolCallV3,
    effect: &AgentObservedEffectV3,
    error: &str,
) -> AgentToolResultV3 {
    let data = if call.tool_name == "exec_command" {
        let channel = call
            .arguments
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("direct");
        Some(if channel == "pty" {
            json!({
                "channel": "pty",
                "state": "exited",
                "stdout": "",
                "stderr": "",
                "combinedOutput": "",
                "truncated": false
            })
        } else {
            json!({
                "channel": "direct",
                "state": "exited",
                "stdout": "",
                "stderr": "",
                "truncated": false
            })
        })
    } else {
        None
    };
    AgentToolResultV3 {
        request_id: call.request_id.clone(),
        call_id: call.call_id.clone(),
        tool_name: call.tool_name.clone(),
        target_id: call.target.target_id().to_string(),
        status: AgentToolResultStatusV3::Failed,
        summary: error.into(),
        data,
        artifacts: Vec::new(),
        effects: vec![effect.clone()],
        truncated: (call.tool_name == "exec_command").then_some(false),
    }
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime_v3::sha256_hex;
    use crate::models::{
        ManagedSession, ProfileRow, SessionCommand, SessionCommandSender, SessionIdentity,
        StatusEvent,
    };
    use crossbeam_channel::unbounded;
    use ssh2::{HostKeyType, KnownHostFileKind, KnownHostKeyFormat, Session};
    use std::fs;
    use std::net::TcpStream;
    use std::sync::atomic::AtomicBool;

    fn request(task_id: &str, target_id: &str) -> AgentRequestV3 {
        AgentRequestV3 {
            contract_version: 3,
            request_id: format!("req-{task_id}"),
            user_session_id: "user-1".into(),
            task_id: task_id.into(),
            goal: "Run a bounded command".into(),
            success_criteria: vec!["Return structured evidence".into()],
            targets: vec![AgentToolTargetV3::Local {
                target_id: target_id.into(),
                session_id: format!("session-{task_id}"),
                cwd: None,
            }],
            permission_mode: AgentPermissionModeV3::ScopedAutopilot,
            source_contract: AgentRequestSourceV3::V3,
        }
    }

    fn local_sessions(task_id: &str) -> SessionManager {
        let sessions = SessionManager::default();
        let (sender, _receiver) = unbounded::<SessionCommand>();
        sessions
            .insert(
                format!("session-{task_id}"),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: format!("session-{task_id}"),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Local,
                    identity: SessionIdentity {
                        title: "Local".into(),
                        host: "local".into(),
                        port: 0,
                        username: "tester".into(),
                    },
                },
            )
            .unwrap();
        sessions
    }

    fn remote_sessions(session_id: &str, host: &str, port: u16, username: &str) -> SessionManager {
        let sessions = SessionManager::default();
        let (sender, _receiver) = unbounded::<SessionCommand>();
        sessions
            .insert(
                session_id.to_string(),
                ManagedSession {
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: session_id.to_string(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                    terminal_kind: SessionTerminalKind::Remote,
                    identity: SessionIdentity {
                        title: "Isolated SSH".into(),
                        host: host.to_string(),
                        port,
                        username: username.to_string(),
                    },
                },
            )
            .unwrap();
        sessions
    }

    fn trust_isolated_host(host: &str, port: u16, known_hosts_path: &Path) {
        let tcp = TcpStream::connect((host, port)).expect("connect to isolated SSH service");
        let mut session = Session::new().expect("create SSH session");
        session.set_tcp_stream(tcp);
        session.handshake().expect("read isolated SSH host key");
        let (key, key_type) = session.host_key().expect("isolated host exposes a key");
        let key_format = match key_type {
            HostKeyType::Rsa => KnownHostKeyFormat::SshRsa,
            HostKeyType::Dss => KnownHostKeyFormat::SshDss,
            HostKeyType::Ecdsa256 => KnownHostKeyFormat::Ecdsa256,
            HostKeyType::Ecdsa384 => KnownHostKeyFormat::Ecdsa384,
            HostKeyType::Ecdsa521 => KnownHostKeyFormat::Ecdsa521,
            HostKeyType::Ed25519 => KnownHostKeyFormat::Ed25519,
            HostKeyType::Unknown => KnownHostKeyFormat::Unknown,
        };
        let host_with_port = if port == 22 {
            host.to_string()
        } else {
            format!("[{host}]:{port}")
        };
        let mut known_hosts = session.known_hosts().expect("initialize known hosts");
        known_hosts
            .add(&host_with_port, key, &host_with_port, key_format)
            .expect("trust isolated host key");
        known_hosts
            .write_file(known_hosts_path, KnownHostFileKind::OpenSSH)
            .expect("persist isolated known host");
    }

    fn execute_authorized_local_call(
        runtime: &AgentRuntimeV3,
        request: &AgentRequestV3,
        sessions: &SessionManager,
        database: &Database,
        credentials: &CredentialManager,
        known_hosts_path: &Path,
        call_id: &str,
        tool_name: &str,
        arguments: Value,
    ) -> AgentToolResultV3 {
        let authorization = AgentAuthorizeCallRequestV3 {
            task_id: request.task_id.clone(),
            request_id: request.request_id.clone(),
            call_id: call_id.into(),
            tool_name: tool_name.into(),
            arguments,
            target: request.targets[0].clone(),
            ttl_ms: Some(10_000),
        };
        let prepared = runtime
            .prepare_authorization(
                authorization.clone(),
                sessions,
                database,
                credentials,
                known_hosts_path,
            )
            .unwrap();
        let grant = runtime
            .issue_prepared_authorization(prepared, true)
            .unwrap();
        runtime
            .execute_tool(
                &request.task_id,
                AgentToolCallV3 {
                    request_id: authorization.request_id,
                    call_id: authorization.call_id,
                    tool_name: authorization.tool_name,
                    arguments: authorization.arguments,
                    target: authorization.target,
                    capability_id: grant.capability_id,
                },
                sessions,
                database,
                credentials,
                known_hosts_path,
            )
            .unwrap()
    }

    #[test]
    fn task_store_holds_multiple_active_tasks_and_native_process_targets() {
        let store = AgentTaskStoreV3::default();
        store.register(request("task-1", "local-1")).unwrap();
        store.register(request("task-2", "local-2")).unwrap();
        store
            .add_process_target(
                "task-1",
                AgentToolTargetV3::Process {
                    target_id: "process-1".into(),
                    owner_target_id: "local-1".into(),
                    process_handle: "proc-1".into(),
                },
            )
            .unwrap();
        let records = store.records().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(store.request("task-1").unwrap().targets.len(), 3);
        assert_eq!(store.request("task-2").unwrap().targets.len(), 2);
    }

    #[test]
    fn task_store_rejects_multi_host_and_v2_compatibility_runtime_registration() {
        let store = AgentTaskStoreV3::default();
        let mut fleet = request("fleet", "local-1");
        fleet.targets.push(AgentToolTargetV3::Local {
            target_id: "local-2".into(),
            session_id: "session-2".into(),
            cwd: None,
        });
        assert!(store.register(fleet).is_err());

        let mut compatibility = request("compat", "local-1");
        compatibility.source_contract = AgentRequestSourceV3::V2Compatibility;
        assert!(store.register(compatibility).is_err());
    }

    #[test]
    fn shutdown_persists_active_tasks_once_without_marking_them_cancelled() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = AgentRuntimeV3::default();
        runtime
            .configure_checkpoint_root(directory.path().to_path_buf())
            .unwrap();
        runtime
            .tasks
            .register(request("shutdown", "local-shutdown"))
            .unwrap();
        runtime.persist_task("shutdown").unwrap();
        let sessions = SessionManager::default();

        assert_eq!(runtime.prepare_for_shutdown(&sessions).unwrap(), 1);
        assert_eq!(runtime.prepare_for_shutdown(&sessions).unwrap(), 0);
        assert_eq!(
            runtime.tasks.record("shutdown").unwrap().state,
            TaskRuntimeStateV3::Active
        );
        assert_eq!(
            runtime
                .persistence
                .task_recovery("shutdown")
                .unwrap()
                .disposition,
            RecoveryDispositionV3::SafeToResume
        );
    }

    #[test]
    fn restarted_safe_task_is_native_blocked_until_session_rebind() {
        let directory = tempfile::tempdir().unwrap();
        let first = AgentRuntimeV3::default();
        first
            .configure_checkpoint_root(directory.path().to_path_buf())
            .unwrap();
        first
            .tasks
            .register(request("resume", "local-resume"))
            .unwrap();
        first.persist_task("resume").unwrap();

        let restarted = AgentRuntimeV3::default();
        restarted
            .configure_checkpoint_root(directory.path().to_path_buf())
            .unwrap();
        assert!(restarted.tasks.request("resume").is_err());
        assert!(restarted.operator.list().unwrap().is_empty());
        assert!(restarted.broker.list().unwrap().is_empty());
        let database = Database::open(&directory.path().join("resume.db")).unwrap();
        let credentials = CredentialManager::new();
        let rebound = restarted
            .rebind_recovery_session(
                "resume",
                "session-resume",
                &local_sessions("resume"),
                &database,
                &credentials,
                directory.path(),
            )
            .unwrap();
        assert!(matches!(
            &rebound.request.targets[0],
            AgentToolTargetV3::Local { session_id, .. } if session_id == "session-resume"
        ));
        assert!(rebound.context.fragments.iter().any(|fragment| {
            fragment.fragment_id == "context:session:native"
                && fragment.scope.session_id.as_deref() == Some("session-resume")
        }));
        assert!(restarted.tasks.request("resume").is_ok());
    }

    #[test]
    fn native_runtime_executes_one_exactly_bound_local_call_and_rejects_fabrication() {
        let runtime = AgentRuntimeV3::default();
        let sessions = local_sessions("runtime");
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("shellspan.db")).unwrap();
        let credentials = CredentialManager::new();
        let request = request("runtime", "local-runtime");
        runtime
            .configure_checkpoint_root(directory.path().join("state"))
            .unwrap();
        runtime
            .register_task(request.clone(), &sessions, &database)
            .unwrap();

        let command = if cfg!(target_os = "windows") {
            "Write-Output 'runtime-ok'"
        } else {
            "printf 'runtime-ok\\n'"
        };
        let authorization = AgentAuthorizeCallRequestV3 {
            task_id: request.task_id.clone(),
            request_id: request.request_id.clone(),
            call_id: "call-runtime".into(),
            tool_name: "exec_command".into(),
            arguments: json!({
                "command": command,
                "explanation": "Exercise the native Direct Exec path.",
                "channel": "direct"
            }),
            target: request.targets[0].clone(),
            ttl_ms: Some(10_000),
        };
        let prepared = runtime
            .prepare_authorization(
                authorization.clone(),
                &sessions,
                &database,
                &credentials,
                directory.path(),
            )
            .unwrap();
        let grant = runtime
            .issue_prepared_authorization(prepared, true)
            .unwrap();
        let call = AgentToolCallV3 {
            request_id: authorization.request_id,
            call_id: authorization.call_id,
            tool_name: authorization.tool_name,
            arguments: authorization.arguments,
            target: authorization.target,
            capability_id: grant.capability_id,
        };
        let result = runtime
            .execute_tool(
                &request.task_id,
                call,
                &sessions,
                &database,
                &credentials,
                directory.path(),
            )
            .unwrap();
        assert_eq!(
            result.status,
            AgentToolResultStatusV3::Completed,
            "native result: {result:?}"
        );
        assert!(result.data.as_ref().unwrap()["stdout"]
            .as_str()
            .unwrap()
            .contains("runtime-ok"));
        assert_eq!(result.data.as_ref().unwrap()["channel"], "direct");
        assert!(runtime.audit_entries().unwrap().iter().any(|event| {
            event.action == "toolDispatchPolicy"
                && event.decision.contains("revalidated at dispatch")
        }));
        assert_eq!(
            runtime
                .task_snapshot(&request.task_id)
                .unwrap()
                .request
                .targets
                .len(),
            3
        );

        let rejected = runtime
            .execute_tool(
                &request.task_id,
                AgentToolCallV3 {
                    request_id: request.request_id.clone(),
                    call_id: "call-forged".into(),
                    tool_name: "exec_command".into(),
                    arguments: json!({
                        "command": command,
                        "explanation": "This call has no native proof.",
                        "channel": "direct"
                    }),
                    target: request.targets[0].clone(),
                    capability_id: "fabricated-capability".into(),
                },
                &sessions,
                &database,
                &credentials,
                directory.path(),
            )
            .unwrap();
        assert_eq!(rejected.status, AgentToolResultStatusV3::Rejected);
    }

    #[test]
    fn native_patch_checkpoint_write_verify_and_restore_round_trip() {
        let runtime = AgentRuntimeV3::default();
        let sessions = local_sessions("patch");
        let directory = tempfile::tempdir().unwrap();
        // macOS exposes /var as a system symlink to /private/var. Keep the
        // absolute-path fixture inside the canonical frozen root so the test
        // exercises in-root symlink denial rather than that platform alias.
        let directory_path = directory.path().canonicalize().unwrap();
        runtime
            .configure_checkpoint_root(directory_path.join("state"))
            .unwrap();
        let database = Database::open(&directory_path.join("shellspan.db")).unwrap();
        let credentials = CredentialManager::new();
        let file_path = directory_path.join("config.txt");
        fs::write(&file_path, "mode=before\n").unwrap();
        let mut request = request("patch", "local-patch");
        request.targets[0] = AgentToolTargetV3::Local {
            target_id: "local-patch".into(),
            session_id: "session-patch".into(),
            cwd: Some(directory_path.to_string_lossy().to_string()),
        };
        runtime
            .register_task(request.clone(), &sessions, &database)
            .unwrap();

        let before = fs::read_to_string(&file_path).unwrap();
        let after = "mode=after\n";
        let authorization = AgentAuthorizeCallRequestV3 {
            task_id: request.task_id.clone(),
            request_id: request.request_id.clone(),
            call_id: "call-patch".into(),
            tool_name: "apply_patch".into(),
            arguments: json!({
                "patch": diffy::create_patch(&before, after).to_string(),
                "preconditions": [{
                    "path": file_path.to_string_lossy(),
                    "sha256": sha256_hex(before.as_bytes())
                }],
                "dryRun": false
            }),
            target: request.targets[0].clone(),
            ttl_ms: Some(10_000),
        };
        let prepared = runtime
            .prepare_authorization(
                authorization.clone(),
                &sessions,
                &database,
                &credentials,
                &directory_path,
            )
            .unwrap();
        assert!(prepared.native_prompt.contains("Exact diff"));
        let grant = runtime
            .issue_prepared_authorization(prepared, true)
            .unwrap();
        let result = runtime
            .execute_tool(
                &request.task_id,
                AgentToolCallV3 {
                    request_id: authorization.request_id,
                    call_id: authorization.call_id,
                    tool_name: authorization.tool_name,
                    arguments: authorization.arguments,
                    target: authorization.target,
                    capability_id: grant.capability_id,
                },
                &sessions,
                &database,
                &credentials,
                &directory_path,
            )
            .unwrap();
        assert_eq!(
            result.status,
            AgentToolResultStatusV3::Completed,
            "patch result: {result:?}"
        );
        assert_eq!(fs::read_to_string(&file_path).unwrap(), after);
        let checkpoint_id = result.data.as_ref().unwrap()["checkpointId"]
            .as_str()
            .unwrap()
            .to_string();
        let prepared_restore = runtime
            .prepare_checkpoint_restore(
                &request.task_id,
                &checkpoint_id,
                &sessions,
                &database,
                &credentials,
                &directory_path,
            )
            .unwrap();
        let restored = runtime
            .restore_prepared_checkpoint(prepared_restore, &database, &credentials, &directory_path)
            .unwrap();
        assert!(restored.restored_at_unix_ms.is_some());
        assert_eq!(fs::read_to_string(&file_path).unwrap(), before);
    }

    #[test]
    fn native_read_list_and_search_are_bounded_and_never_use_shell_fallback() {
        let runtime = AgentRuntimeV3::default();
        let sessions = local_sessions("files");
        let directory = tempfile::tempdir().unwrap();
        runtime
            .configure_checkpoint_root(directory.path().join("state"))
            .unwrap();
        let database = Database::open(&directory.path().join("shellspan.db")).unwrap();
        let credentials = CredentialManager::new();
        let file_path = directory.path().join("config.txt");
        fs::write(&file_path, "alpha\nbeta\n").unwrap();
        let mut request = request("files", "local-files");
        request.targets[0] = AgentToolTargetV3::Local {
            target_id: "local-files".into(),
            session_id: "session-files".into(),
            cwd: Some(directory.path().to_string_lossy().to_string()),
        };
        runtime
            .register_task(request.clone(), &sessions, &database)
            .unwrap();

        let read = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            directory.path(),
            "call-read",
            "read_file",
            json!({
                "path": "config.txt",
                "encoding": "utf8",
                "maxBytes": 6,
                "expectedSha256": sha256_hex(b"alpha\nbeta\n")
            }),
        );
        assert_eq!(read.status, AgentToolResultStatusV3::Completed);
        assert_eq!(read.data.as_ref().unwrap()["content"], "alpha\n");
        assert_eq!(read.data.as_ref().unwrap()["truncated"], true);

        let listing = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            directory.path(),
            "call-list",
            "list_directory",
            json!({ "path": ".", "pageSize": 1, "includeHidden": false }),
        );
        assert_eq!(listing.status, AgentToolResultStatusV3::Completed);
        assert_eq!(
            listing.data.as_ref().unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(listing.data.as_ref().unwrap()["nextCursor"].is_string());

        let search = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            directory.path(),
            "call-search",
            "search_text",
            json!({
                "path": ".",
                "query": "beta",
                "mode": "content",
                "maxResults": 10
            }),
        );
        assert_eq!(search.status, AgentToolResultStatusV3::Completed);
        assert!(search.data.as_ref().unwrap()["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|found| found["preview"] == "beta"));

        let escaped = runtime.prepare_authorization(
            AgentAuthorizeCallRequestV3 {
                task_id: request.task_id.clone(),
                request_id: request.request_id.clone(),
                call_id: "call-escape".into(),
                tool_name: "read_file".into(),
                arguments: json!({ "path": "../outside", "encoding": "utf8" }),
                target: request.targets[0].clone(),
                ttl_ms: None,
            },
            &sessions,
            &database,
            &credentials,
            directory.path(),
        );
        assert!(
            escaped.is_ok(),
            "read authorization does not access the file"
        );
        let prepared = escaped.unwrap();
        let grant = runtime
            .issue_prepared_authorization(prepared, true)
            .unwrap();
        let escaped_result = runtime
            .execute_tool(
                &request.task_id,
                AgentToolCallV3 {
                    request_id: request.request_id.clone(),
                    call_id: "call-escape".into(),
                    tool_name: "read_file".into(),
                    arguments: json!({ "path": "../outside", "encoding": "utf8" }),
                    target: request.targets[0].clone(),
                    capability_id: grant.capability_id,
                },
                &sessions,
                &database,
                &credentials,
                directory.path(),
            )
            .unwrap();
        assert_eq!(escaped_result.status, AgentToolResultStatusV3::Failed);
    }

    #[test]
    #[ignore = "requires the isolated tests/ssh-e2e Docker service"]
    fn isolated_ssh_sftp_end_to_end_agent_m2_native_files() {
        assert_eq!(
            std::env::var("SHELLSPAN_E2E_SSH_FIXTURE").as_deref(),
            Ok("1"),
            "the isolated fixture must be explicitly enabled"
        );
        let host = std::env::var("SHELLSPAN_E2E_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let port = std::env::var("SHELLSPAN_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22222);
        let username =
            std::env::var("SHELLSPAN_E2E_SSH_USERNAME").unwrap_or_else(|_| "shellspan".into());
        let password =
            std::env::var("SHELLSPAN_E2E_SSH_PASSWORD").unwrap_or_else(|_| "shellspan-e2e".into());
        let session_id = "session-remote-m2";
        let profile_id = "profile-remote-m2";
        let target_id = "remote-m2";
        let workspace = tempfile::tempdir().unwrap();
        let local_root = workspace.path().join("local");
        fs::create_dir(&local_root).unwrap();
        let known_hosts_path = workspace.path().join("known_hosts");
        trust_isolated_host(&host, port, &known_hosts_path);

        let database = Database::open(&workspace.path().join("shellspan.db")).unwrap();
        database
            .insert_profile(&ProfileRow {
                id: profile_id.into(),
                name: "M2 isolated fixture".into(),
                host: host.clone(),
                port,
                username: username.clone(),
                auth_method: ProfileAuthMethod::Password,
                keychain_key_id: None,
                jump_host_config: None,
                organization_json: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        let credentials = CredentialManager::in_memory_for_tests();
        credentials
            .store_profile_password(profile_id, &password)
            .unwrap();
        let sessions = remote_sessions(session_id, &host, port, &username);
        let runtime = AgentRuntimeV3::default();
        runtime
            .configure_checkpoint_root(workspace.path().join("checkpoints"))
            .unwrap();
        let mut request = request("remote-m2", target_id);
        request.targets[0] = AgentToolTargetV3::Remote {
            target_id: target_id.into(),
            session_id: session_id.into(),
            profile_id: Some(profile_id.into()),
            host,
            port,
            username,
            root_path: Some("/home/shellspan/upload".into()),
            local_root: Some(local_root.to_string_lossy().to_string()),
        };
        runtime
            .register_task(request.clone(), &sessions, &database)
            .unwrap();

        let remote_name = format!("agent-m2-{}.txt", uuid::Uuid::new_v4());
        let source_path = local_root.join("upload.txt");
        let first = b"m2-upload-v1\n";
        fs::write(&source_path, first).unwrap();
        let first_digest = sha256_hex(first);
        let upload = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-upload",
            "transfer_file",
            json!({
                "direction": "upload",
                "sourcePath": "upload.txt",
                "destinationPath": remote_name,
                "overwrite": false,
                "expectedSha256": first_digest
            }),
        );
        assert_eq!(upload.status, AgentToolResultStatusV3::Completed);
        assert_eq!(upload.data.as_ref().unwrap()["verified"], true);

        let remote_read = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-read",
            "read_file",
            json!({ "path": remote_name, "encoding": "utf8" }),
        );
        assert_eq!(remote_read.status, AgentToolResultStatusV3::Completed);
        assert_eq!(
            remote_read.data.as_ref().unwrap()["content"],
            "m2-upload-v1\n"
        );

        let conflict = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-conflict",
            "transfer_file",
            json!({
                "direction": "upload",
                "sourcePath": "upload.txt",
                "destinationPath": remote_name,
                "overwrite": false,
                "expectedSha256": first_digest
            }),
        );
        assert_eq!(conflict.status, AgentToolResultStatusV3::Failed);
        assert!(conflict.summary.contains("destination already exists"));

        let second = b"m2-upload-v2\n";
        fs::write(&source_path, second).unwrap();
        let second_digest = sha256_hex(second);
        let overwrite = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-overwrite",
            "transfer_file",
            json!({
                "direction": "upload",
                "sourcePath": "upload.txt",
                "destinationPath": remote_name,
                "overwrite": true,
                "expectedSha256": second_digest,
                "destinationSha256": first_digest
            }),
        );
        assert_eq!(overwrite.status, AgentToolResultStatusV3::Completed);

        let download = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-download",
            "transfer_file",
            json!({
                "direction": "download",
                "sourcePath": remote_name,
                "destinationPath": "downloaded.txt",
                "overwrite": false,
                "expectedSha256": second_digest
            }),
        );
        assert_eq!(download.status, AgentToolResultStatusV3::Completed);
        assert_eq!(fs::read(local_root.join("downloaded.txt")).unwrap(), second);

        let patched = "m2-patched\n";
        let patch = diffy::create_patch(std::str::from_utf8(second).unwrap(), patched).to_string();
        let patch_result = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-patch",
            "apply_patch",
            json!({
                "patch": patch,
                "preconditions": [{ "path": remote_name, "sha256": second_digest }],
                "dryRun": false
            }),
        );
        assert_eq!(
            patch_result.status,
            AgentToolResultStatusV3::Completed,
            "{}",
            patch_result.summary
        );
        let checkpoint_id = patch_result.data.as_ref().unwrap()["checkpointId"]
            .as_str()
            .unwrap();
        let prepared = runtime
            .prepare_checkpoint_restore(
                &request.task_id,
                checkpoint_id,
                &sessions,
                &database,
                &credentials,
                &known_hosts_path,
            )
            .unwrap();
        let restored = runtime
            .restore_prepared_checkpoint(prepared, &database, &credentials, &known_hosts_path)
            .unwrap();
        assert!(restored.restored_at_unix_ms.is_some());

        let restored_read = execute_authorized_local_call(
            &runtime,
            &request,
            &sessions,
            &database,
            &credentials,
            &known_hosts_path,
            "call-remote-restored-read",
            "read_file",
            json!({ "path": remote_name, "encoding": "utf8" }),
        );
        assert_eq!(restored_read.status, AgentToolResultStatusV3::Completed);
        assert_eq!(
            restored_read.data.as_ref().unwrap()["content"],
            "m2-upload-v2\n"
        );
    }

    #[test]
    fn plan_rejects_cycles_unauthorized_targets_and_completed_without_evidence() {
        let store = AgentTaskStoreV3::default();
        store.register(request("plan", "local-plan")).unwrap();
        let registry = ToolRegistryV3::from_builtin_manifest().unwrap();
        let base_step = PlanStepV3 {
            id: "step-1".into(),
            description: "Inspect the target".into(),
            dependencies: Vec::new(),
            target_ids: vec!["local-plan".into()],
            required_tools: vec!["read_file".into()],
            expected_effect: AgentEffectKindV3::SensitiveRead,
            status: PlanStepStatusV3::Completed,
            success_criteria: vec!["A native result verifies the read".into()],
            rollback_or_compensation: "No rollback is needed for a read".into(),
            evidence_refs: Vec::new(),
        };
        assert!(store
            .update_plan(
                "plan",
                UpdatePlanArgumentsV3 {
                    plan_version: 0,
                    explanation: None,
                    steps: vec![base_step.clone()],
                },
                &registry,
            )
            .is_err());

        let mut unauthorized = base_step.clone();
        unauthorized.status = PlanStepStatusV3::Pending;
        unauthorized.target_ids = vec!["outside".into()];
        assert!(store
            .update_plan(
                "plan",
                UpdatePlanArgumentsV3 {
                    plan_version: 0,
                    explanation: None,
                    steps: vec![unauthorized],
                },
                &registry,
            )
            .is_err());

        let mut cycle_a = base_step.clone();
        cycle_a.status = PlanStepStatusV3::Pending;
        cycle_a.dependencies = vec!["step-2".into()];
        let mut cycle_b = cycle_a.clone();
        cycle_b.id = "step-2".into();
        cycle_b.dependencies = vec!["step-1".into()];
        assert!(store
            .update_plan(
                "plan",
                UpdatePlanArgumentsV3 {
                    plan_version: 0,
                    explanation: None,
                    steps: vec![cycle_a, cycle_b],
                },
                &registry,
            )
            .is_err());
    }
}
