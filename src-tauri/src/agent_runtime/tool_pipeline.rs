use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    AgentActiveScope, AgentAfterToolContext, AgentAfterToolDecision, AgentArtifactStore,
    AgentBeforeToolContext, AgentBeforeToolDecision, AgentEntry, AgentHookBus, AgentInboxLane,
    AgentInboxMessage, AgentLifecyclePhase, AgentMessageSource, AgentPlanStep, AgentRecoveryState,
    AgentRecoveryStatus, AgentScopedPayload, AgentSessionEffect, AgentSessionEventPayload,
    AgentSessionStatus, AgentSessionStore, AgentSessionTarget, AgentToolApprovalStatus,
    AgentToolExecutionStatus, AgentToolResultStatus, ModelToolCall, RecordedToolCall,
};

pub(crate) const DEFAULT_NATIVE_APPROVAL_TTL_MS: u64 = 60_000;
const MAX_INLINE_TOOL_DATA_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeToolIdempotency {
    Yes,
    No,
    Conditional,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeToolRequest {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) goal: String,
    pub(crate) success_criteria: Vec<String>,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) model_call: ModelToolCall,
    pub(crate) target: AgentSessionTarget,
    pub(crate) permission_mode: super::AgentSessionPermissionMode,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeToolPreparation {
    pub(crate) token: String,
    pub(crate) call: RecordedToolCall,
    pub(crate) requires_approval: bool,
    pub(crate) prompt: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) idempotency: NativeToolIdempotency,
    pub(crate) parallel: bool,
    pub(crate) exclusive: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativeToolArtifact {
    pub(crate) artifact_id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) media_type: Option<String>,
    pub(crate) sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativeToolResult {
    pub(crate) call_id: String,
    pub(crate) native_name: String,
    pub(crate) target_id: String,
    pub(crate) effect: AgentSessionEffect,
    pub(crate) status: AgentToolResultStatus,
    pub(crate) summary: String,
    pub(crate) data: Option<Value>,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) evidence_refs: Vec<String>,
    pub(crate) artifacts: Vec<NativeToolArtifact>,
}

pub(crate) trait NativeToolRuntime: Send + Sync {
    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String>;

    fn execute(
        &self,
        token: &str,
        approved: bool,
        cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String>;

    fn abandon(&self, token: &str);

    fn cancel_task(&self, _task_id: &str) -> Result<(), String> {
        Ok(())
    }
}

pub(crate) const ORCHESTRATION_TOOL_NAMES: &[&str] = &[
    "spawn_one_shot_agent",
    "spawn_continuable_agent",
    "send_child_input",
    "inspect_child_agent",
    "cancel_child_agent",
    "fleet_plan",
    "fleet_start",
    "fleet_pause",
    "fleet_resume",
    "fleet_abort",
    "fleet_reconcile",
];

pub(crate) fn is_orchestration_tool(name: &str) -> bool {
    ORCHESTRATION_TOOL_NAMES.contains(&name)
}

fn is_session_tool(name: &str) -> bool {
    name == "update_plan"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePlanArguments {
    plan_version: u64,
    #[serde(default)]
    explanation: Option<String>,
    steps: Vec<AgentPlanStep>,
}

#[derive(Debug, Clone)]
pub(crate) struct OrchestrationToolRequest {
    pub(crate) parent_session_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) call: ModelToolCall,
}

#[derive(Debug, Clone)]
pub(crate) struct OrchestrationToolResult {
    pub(crate) status: AgentToolResultStatus,
    pub(crate) summary: String,
    pub(crate) data: Option<Value>,
    pub(crate) evidence_refs: Vec<String>,
    /// Spawn/continue settlement may atomically commit the parent tool result
    /// with the subagent settlement event inside the Session Store.
    pub(crate) result_committed: bool,
}

#[async_trait]
pub(crate) trait OrchestrationToolRuntime: Send + Sync {
    async fn execute(
        &self,
        request: OrchestrationToolRequest,
        cancellation: CancellationToken,
    ) -> Result<OrchestrationToolResult, String>;
}

#[derive(Clone, Default)]
pub(crate) struct OrchestrationToolRuntimeSlot {
    inner: Arc<Mutex<Option<Weak<dyn OrchestrationToolRuntime>>>>,
}

impl OrchestrationToolRuntimeSlot {
    pub(crate) fn install(
        &self,
        runtime: &Arc<dyn OrchestrationToolRuntime>,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "orchestration tool runtime slot is unavailable".to_string())?;
        *inner = Some(Arc::downgrade(runtime));
        Ok(())
    }

    fn runtime(&self) -> Result<Arc<dyn OrchestrationToolRuntime>, String> {
        self.inner
            .lock()
            .map_err(|_| "orchestration tool runtime slot is unavailable".to_string())?
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| "subagent orchestration runtime is not configured".to_string())
    }
}

#[derive(Clone, Default)]
pub(crate) struct NativeToolRuntimeSlot {
    inner: Arc<Mutex<Option<Arc<dyn NativeToolRuntime>>>>,
}

impl NativeToolRuntimeSlot {
    pub(crate) fn install(&self, native: Arc<dyn NativeToolRuntime>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "native tool runtime slot is unavailable".to_string())?;
        if inner.is_none() {
            *inner = Some(native);
        }
        Ok(())
    }

    fn runtime(&self) -> Result<Arc<dyn NativeToolRuntime>, String> {
        self.inner
            .lock()
            .map_err(|_| "native tool runtime slot is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Agent Runtime native tool adapter is not configured".to_string())
    }
}

impl NativeToolRuntime for NativeToolRuntimeSlot {
    fn prepare(&self, request: NativeToolRequest) -> Result<NativeToolPreparation, String> {
        self.runtime()?.prepare(request)
    }

    fn execute(
        &self,
        token: &str,
        approved: bool,
        cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String> {
        self.runtime()?.execute(token, approved, cancellation)
    }

    fn abandon(&self, token: &str) {
        if let Ok(runtime) = self.runtime() {
            runtime.abandon(token);
        }
    }

    fn cancel_task(&self, task_id: &str) -> Result<(), String> {
        self.runtime()?.cancel_task(task_id)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentToolDecisionInput {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) approval_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolDecision {
    Approve,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolPipelineSettlement {
    Completed,
    Waiting,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingStatus {
    Requested,
    Authorized,
    Executing,
    Cancelled,
}

#[derive(Clone)]
struct PendingTool {
    request: NativeToolRequest,
    preparation: NativeToolPreparation,
    approval_id: String,
    remaining_calls: Vec<ModelToolCall>,
    status: PendingStatus,
}

#[derive(Clone)]
pub(crate) struct AgentToolPipeline {
    sessions: AgentSessionStore,
    hooks: AgentHookBus,
    native: Arc<dyn NativeToolRuntime>,
    artifacts: AgentArtifactStore,
    orchestration: OrchestrationToolRuntimeSlot,
    pending: Arc<Mutex<HashMap<String, PendingTool>>>,
    changed: Arc<Notify>,
}

impl AgentToolPipeline {
    pub(crate) fn new(
        sessions: AgentSessionStore,
        hooks: AgentHookBus,
        native: Arc<dyn NativeToolRuntime>,
        artifacts: AgentArtifactStore,
        orchestration: OrchestrationToolRuntimeSlot,
    ) -> Self {
        Self {
            sessions,
            hooks,
            native,
            artifacts,
            orchestration,
            pending: Arc::new(Mutex::new(HashMap::new())),
            changed: Arc::new(Notify::new()),
        }
    }

    pub(crate) async fn process_model_calls(
        &self,
        entry: &Arc<AgentEntry>,
        turn_id: &str,
        step_id: &str,
        request_id: &str,
        calls: Vec<ModelToolCall>,
    ) -> Result<ToolPipelineSettlement, String> {
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let target = snapshot.header.target.clone().ok_or_else(|| {
            "nativeToolTargetMissing: Session has no frozen tool target".to_string()
        })?;
        let permission_mode = snapshot.header.permission_mode.ok_or_else(|| {
            "nativePermissionMissing: Session has no Rust permission mode".to_string()
        })?;
        let mut calls = std::collections::VecDeque::from(calls);
        let mut lookahead: Option<(NativeToolRequest, Result<NativeToolPreparation, String>)> =
            None;
        while !calls.is_empty() || lookahead.is_some() {
            if entry.cancellation().is_cancelled() {
                return Ok(ToolPipelineSettlement::Cancelled);
            }
            if let Some(subagent) = &entry.subagent {
                let committed_calls = self
                    .sessions
                    .all_events(&entry.session_id)?
                    .iter()
                    .filter(|event| {
                        matches!(event.payload, AgentSessionEventPayload::ToolCall { .. })
                    })
                    .count() as u32;
                if committed_calls >= subagent.budget.max_tool_calls {
                    return Err(format!(
                        "subagentToolBudgetExceeded: maximum {} calls",
                        subagent.budget.max_tool_calls
                    ));
                }
            }
            if lookahead.is_none()
                && calls
                    .front()
                    .is_some_and(|call| is_session_tool(&call.name))
            {
                let call = calls.pop_front().expect("Session call remains queued");
                self.process_session_call(
                    entry,
                    turn_id,
                    step_id,
                    request_id,
                    target.clone(),
                    call,
                )?;
                continue;
            }
            if lookahead.is_none()
                && calls
                    .front()
                    .is_some_and(|call| is_orchestration_tool(&call.name))
            {
                let call = calls
                    .pop_front()
                    .expect("orchestration call remains queued");
                self.process_orchestration_call(
                    entry,
                    turn_id,
                    step_id,
                    request_id,
                    target.clone(),
                    call,
                )
                .await?;
                continue;
            }
            let (request, prepared) = match lookahead.take() {
                Some(value) => value,
                None => {
                    let model_call = calls.pop_front().expect("non-empty tool queue has a call");
                    let request = NativeToolRequest {
                        session_id: entry.session_id.clone(),
                        task_id: snapshot.header.task_id.clone(),
                        goal: snapshot.header.goal.clone(),
                        success_criteria: snapshot.header.success_criteria.clone(),
                        turn_id: turn_id.to_string(),
                        step_id: step_id.to_string(),
                        request_id: request_id.to_string(),
                        model_call,
                        target: target.clone(),
                        permission_mode,
                    };
                    let prepared = self.prepare_request(&request);
                    (request, prepared)
                }
            };
            let preparation = match prepared {
                Ok(preparation) => preparation,
                Err(error) => {
                    self.commit_prepare_failure(&request, &error)?;
                    continue;
                }
            };
            self.ensure_capability(
                entry,
                &request.model_call.name,
                preparation
                    .call
                    .effect
                    .unwrap_or(AgentSessionEffect::Unknown),
                &request.target.target_id,
            )?;

            if preparation.parallel && !preparation.requires_approval {
                let mut group = vec![(request, preparation)];
                while calls.front().is_some_and(|call| {
                    !is_orchestration_tool(&call.name) && !is_session_tool(&call.name)
                }) {
                    let model_call = calls
                        .pop_front()
                        .expect("non-orchestration call remains queued");
                    let request = NativeToolRequest {
                        session_id: entry.session_id.clone(),
                        task_id: snapshot.header.task_id.clone(),
                        goal: snapshot.header.goal.clone(),
                        success_criteria: snapshot.header.success_criteria.clone(),
                        turn_id: turn_id.to_string(),
                        step_id: step_id.to_string(),
                        request_id: request_id.to_string(),
                        model_call,
                        target: target.clone(),
                        permission_mode,
                    };
                    let prepared = self.prepare_request(&request);
                    match prepared {
                        Ok(preparation) => {
                            self.ensure_capability(
                                entry,
                                &request.model_call.name,
                                preparation
                                    .call
                                    .effect
                                    .unwrap_or(AgentSessionEffect::Unknown),
                                &request.target.target_id,
                            )?;
                            if preparation.parallel && !preparation.requires_approval {
                                group.push((request, preparation));
                            } else {
                                lookahead = Some((request, Ok(preparation)));
                                break;
                            }
                        }
                        other => {
                            lookahead = Some((request, other));
                            break;
                        }
                    }
                }
                for (request, preparation) in &group {
                    self.append_auto_approved_call(request, preparation)?;
                    self.append_execution_dispatch(request, preparation)?;
                }
                let results =
                    futures_util::future::join_all(group.iter().map(|(_, preparation)| {
                        self.execute_native(preparation, true, entry.cancellation())
                    }))
                    .await;
                for ((request, preparation), result) in group.into_iter().zip(results) {
                    self.finish_native(&request, &preparation, result)?;
                }
                continue;
            }

            let remaining_calls = if preparation.requires_approval {
                calls.drain(..).collect()
            } else {
                Vec::new()
            };
            match self
                .process_prepared(entry, request, preparation, remaining_calls)
                .await?
            {
                ToolPipelineSettlement::Completed => {}
                settlement => return Ok(settlement),
            }
        }
        self.sessions.append(
            &entry.session_id,
            Some(turn_id.to_string()),
            Some(step_id.to_string()),
            AgentSessionEventPayload::StepEnd {
                reason: "toolsCompleted".into(),
            },
        )?;
        entry.set_scope(Some(AgentActiveScope {
            turn_id: turn_id.to_string(),
            step_id: None,
        }))?;
        Ok(ToolPipelineSettlement::Completed)
    }

    fn process_session_call(
        &self,
        entry: &Arc<AgentEntry>,
        turn_id: &str,
        step_id: &str,
        request_id: &str,
        target: AgentSessionTarget,
        call: ModelToolCall,
    ) -> Result<(), String> {
        debug_assert_eq!(call.name, "update_plan");
        self.ensure_capability(
            entry,
            &call.name,
            AgentSessionEffect::None,
            &target.target_id,
        )?;
        let recorded = RecordedToolCall {
            call_id: call.call_id.clone(),
            provider_call_id: call.provider_call_id.clone(),
            name: call.name.clone(),
            native_name: None,
            arguments: call.arguments.clone(),
            title: Some("Update task plan".into()),
            effect: Some(AgentSessionEffect::None),
            target: Some(target),
        };
        let parsed = serde_json::from_value::<UpdatePlanArguments>(call.arguments.clone())
            .map_err(|error| format!("invalid update_plan arguments: {error}"))
            .and_then(|arguments| {
                let previous_version = self
                    .sessions
                    .all_events(&entry.session_id)?
                    .into_iter()
                    .rev()
                    .find_map(|event| match event.payload {
                        AgentSessionEventPayload::TaskPlan { version, .. } => Some(version),
                        _ => None,
                    })
                    .unwrap_or(0);
                if arguments.plan_version != previous_version.saturating_add(1) {
                    return Err(format!(
                        "update_plan version must be {}",
                        previous_version.saturating_add(1)
                    ));
                }
                if arguments
                    .explanation
                    .as_deref()
                    .is_some_and(|value| value.trim().is_empty() || value.len() > 4_096)
                {
                    return Err("update_plan explanation is outside bounds".into());
                }
                Ok(arguments)
            });
        let mut payloads = vec![
            AgentScopedPayload {
                turn_id: Some(turn_id.into()),
                step_id: Some(step_id.into()),
                payload: AgentSessionEventPayload::ToolCall { call: recorded },
            },
            AgentScopedPayload {
                turn_id: Some(turn_id.into()),
                step_id: Some(step_id.into()),
                payload: AgentSessionEventPayload::ToolApproval {
                    request_id: request_id.into(),
                    call_id: call.call_id.clone(),
                    approval_id: None,
                    status: AgentToolApprovalStatus::Approved,
                    risk: Some(AgentSessionEffect::None),
                    reason: Some("sessionRuntimeAuthorized".into()),
                    expires_at_unix_ms: None,
                    prompt: None,
                },
            },
            AgentScopedPayload {
                turn_id: Some(turn_id.into()),
                step_id: Some(step_id.into()),
                payload: AgentSessionEventPayload::ToolExecution {
                    call_id: call.call_id.clone(),
                    status: AgentToolExecutionStatus::Dispatched,
                    idempotency: "conditional".into(),
                },
            },
        ];
        match parsed {
            Ok(arguments) => {
                let summary = arguments.explanation.unwrap_or_else(|| {
                    format!("Task plan advanced to version {}", arguments.plan_version)
                });
                payloads.push(AgentScopedPayload {
                    turn_id: Some(turn_id.into()),
                    step_id: Some(step_id.into()),
                    payload: AgentSessionEventPayload::TaskPlan {
                        version: arguments.plan_version,
                        steps: arguments.steps,
                    },
                });
                payloads.push(AgentScopedPayload {
                    turn_id: Some(turn_id.into()),
                    step_id: Some(step_id.into()),
                    payload: AgentSessionEventPayload::ToolResult {
                        call_id: call.call_id,
                        name: call.name,
                        status: AgentToolResultStatus::Completed,
                        summary,
                        data: Some(serde_json::json!({ "planVersion": arguments.plan_version })),
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                });
            }
            Err(error) => payloads.push(AgentScopedPayload {
                turn_id: Some(turn_id.into()),
                step_id: Some(step_id.into()),
                payload: AgentSessionEventPayload::ToolResult {
                    call_id: call.call_id,
                    name: call.name,
                    status: AgentToolResultStatus::Failed,
                    summary: error,
                    data: None,
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                },
            }),
        }
        self.sessions.append_batch(&entry.session_id, payloads)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn process_orchestration_call(
        &self,
        entry: &Arc<AgentEntry>,
        turn_id: &str,
        step_id: &str,
        request_id: &str,
        target: AgentSessionTarget,
        call: ModelToolCall,
    ) -> Result<(), String> {
        let effect = orchestration_effect(&call.name);
        self.ensure_capability(entry, &call.name, effect, &target.target_id)?;
        let recorded = RecordedToolCall {
            call_id: call.call_id.clone(),
            provider_call_id: call.provider_call_id.clone(),
            name: call.name.clone(),
            native_name: Some(call.name.clone()),
            arguments: call.arguments.clone(),
            title: Some("Agent orchestration".into()),
            effect: Some(effect),
            target: Some(target.clone()),
        };
        let expires_at_unix_ms = current_unix_ms().saturating_add(DEFAULT_NATIVE_APPROVAL_TTL_MS);
        self.sessions.append_batch(
            &entry.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(turn_id.into()),
                    step_id: Some(step_id.into()),
                    payload: AgentSessionEventPayload::ToolCall { call: recorded },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.into()),
                    step_id: Some(step_id.into()),
                    payload: AgentSessionEventPayload::ToolApproval {
                        request_id: request_id.into(),
                        call_id: call.call_id.clone(),
                        approval_id: None,
                        status: AgentToolApprovalStatus::Approved,
                        risk: Some(effect),
                        reason: Some("orchestrationCapabilityAuthorized".into()),
                        expires_at_unix_ms: Some(expires_at_unix_ms),
                        prompt: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(turn_id.into()),
                    step_id: Some(step_id.into()),
                    payload: AgentSessionEventPayload::ToolExecution {
                        call_id: call.call_id.clone(),
                        status: AgentToolExecutionStatus::Dispatched,
                        idempotency: "conditional".into(),
                    },
                },
            ],
        )?;
        let request = OrchestrationToolRequest {
            parent_session_id: entry.session_id.clone(),
            turn_id: turn_id.into(),
            step_id: step_id.into(),
            call: call.clone(),
        };
        let result = self
            .orchestration
            .runtime()?
            .execute(request, entry.cancellation())
            .await
            .unwrap_or_else(|error| OrchestrationToolResult {
                status: AgentToolResultStatus::Failed,
                summary: error,
                data: None,
                evidence_refs: Vec::new(),
                result_committed: false,
            });
        if !result.result_committed {
            self.sessions.append(
                &entry.session_id,
                Some(turn_id.into()),
                Some(step_id.into()),
                AgentSessionEventPayload::ToolResult {
                    call_id: call.call_id,
                    name: call.name,
                    status: result.status,
                    summary: result.summary,
                    data: result.data,
                    duration_ms: None,
                    evidence_refs: result.evidence_refs,
                },
            )?;
        }
        Ok(())
    }

    fn ensure_capability(
        &self,
        entry: &AgentEntry,
        tool_name: &str,
        effect: AgentSessionEffect,
        target_id: &str,
    ) -> Result<(), String> {
        let Some(scope) = &entry.capability_scope else {
            return Ok(());
        };
        if !scope.tool_names.iter().any(|name| name == tool_name)
            || !scope.effects.contains(&effect)
            || !scope
                .target_ids
                .iter()
                .any(|candidate| candidate == target_id)
        {
            return Err(format!(
                "capabilityDenied: {tool_name} exceeds the Agent's delegated scope"
            ));
        }
        Ok(())
    }

    fn prepare_request(
        &self,
        request: &NativeToolRequest,
    ) -> Result<NativeToolPreparation, String> {
        let before = AgentBeforeToolContext {
            session_id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            turn_id: request.turn_id.clone(),
            step_id: request.step_id.clone(),
            request_id: request.request_id.clone(),
            call_id: request.model_call.call_id.clone(),
            name: request.model_call.name.clone(),
            arguments: request.model_call.arguments.clone(),
            target: request.target.clone(),
        };
        for decision in self
            .hooks
            .before_tool(&before)
            .map_err(|error| format!("beforeToolHookFailed: {error}"))?
        {
            if let AgentBeforeToolDecision::Reject { reason } = decision {
                return Err(format!("beforeToolRejected: {reason}"));
            }
        }
        let preparation = self.native.prepare(request.clone())?;
        self.validate_preparation(request, &preparation)?;
        Ok(preparation)
    }

    async fn process_prepared(
        &self,
        entry: &Arc<AgentEntry>,
        request: NativeToolRequest,
        preparation: NativeToolPreparation,
        remaining_calls: Vec<ModelToolCall>,
    ) -> Result<ToolPipelineSettlement, String> {
        if preparation.requires_approval {
            let waiting_turn_id = request.turn_id.clone();
            self.sessions.append(
                &request.session_id,
                Some(request.turn_id.clone()),
                Some(request.step_id.clone()),
                AgentSessionEventPayload::ToolCall {
                    call: preparation.call.clone(),
                },
            )?;
            let approval_id = format!("approval-{}", Uuid::new_v4().simple());
            self.sessions.append_batch(
                &request.session_id,
                vec![
                    AgentScopedPayload {
                        turn_id: Some(request.turn_id.clone()),
                        step_id: Some(request.step_id.clone()),
                        payload: AgentSessionEventPayload::ToolApproval {
                            request_id: request.request_id.clone(),
                            call_id: request.model_call.call_id.clone(),
                            approval_id: Some(approval_id.clone()),
                            status: AgentToolApprovalStatus::Requested,
                            risk: preparation.call.effect,
                            reason: Some("nativePolicyRequiresApproval".into()),
                            expires_at_unix_ms: Some(preparation.expires_at_unix_ms),
                            prompt: Some(preparation.prompt.clone()),
                        },
                    },
                    AgentScopedPayload {
                        turn_id: Some(request.turn_id.clone()),
                        step_id: Some(request.step_id.clone()),
                        payload: AgentSessionEventPayload::StepEnd {
                            reason: "waitingForTool".into(),
                        },
                    },
                    AgentScopedPayload {
                        turn_id: None,
                        step_id: None,
                        payload: AgentSessionEventPayload::AgentStatus {
                            status: AgentSessionStatus::Waiting,
                            reason: Some("toolApprovalPending".into()),
                        },
                    },
                ],
            )?;
            self.pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .insert(
                    approval_key(
                        &request.session_id,
                        &request.step_id,
                        &request.model_call.call_id,
                    ),
                    PendingTool {
                        request,
                        preparation,
                        approval_id,
                        remaining_calls,
                        status: PendingStatus::Requested,
                    },
                );
            self.changed.notify_waiters();
            entry.set_scope(Some(AgentActiveScope {
                turn_id: waiting_turn_id,
                step_id: None,
            }))?;
            entry.set_phase(AgentLifecyclePhase::Waiting)?;
            return Ok(ToolPipelineSettlement::Waiting);
        }

        self.append_auto_approved_call(&request, &preparation)?;
        self.append_execution_dispatch(&request, &preparation)?;
        let result = self
            .execute_native(&preparation, true, entry.cancellation())
            .await;
        self.finish_native(&request, &preparation, result)?;
        Ok(ToolPipelineSettlement::Completed)
    }

    fn append_auto_approved_call(
        &self,
        request: &NativeToolRequest,
        preparation: &NativeToolPreparation,
    ) -> Result<(), String> {
        self.sessions.append_batch(
            &request.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolCall {
                        call: preparation.call.clone(),
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolApproval {
                        request_id: request.request_id.clone(),
                        call_id: request.model_call.call_id.clone(),
                        approval_id: None,
                        status: AgentToolApprovalStatus::Approved,
                        risk: preparation.call.effect,
                        reason: Some("nativePolicyAutoApproved".into()),
                        expires_at_unix_ms: Some(preparation.expires_at_unix_ms),
                        prompt: None,
                    },
                },
            ],
        )?;
        Ok(())
    }

    fn append_execution_dispatch(
        &self,
        request: &NativeToolRequest,
        preparation: &NativeToolPreparation,
    ) -> Result<(), String> {
        self.sessions.append(
            &request.session_id,
            Some(request.turn_id.clone()),
            Some(request.step_id.clone()),
            AgentSessionEventPayload::ToolExecution {
                call_id: request.model_call.call_id.clone(),
                status: AgentToolExecutionStatus::Dispatched,
                idempotency: match preparation.idempotency {
                    NativeToolIdempotency::Yes => "yes",
                    NativeToolIdempotency::No => "no",
                    NativeToolIdempotency::Conditional => "conditional",
                }
                .into(),
            },
        )?;
        Ok(())
    }

    fn commit_prepare_failure(
        &self,
        request: &NativeToolRequest,
        reason: &str,
    ) -> Result<ToolPipelineSettlement, String> {
        let call = RecordedToolCall {
            call_id: request.model_call.call_id.clone(),
            provider_call_id: request.model_call.provider_call_id.clone(),
            name: request.model_call.name.clone(),
            native_name: None,
            arguments: request.model_call.arguments.clone(),
            title: None,
            effect: Some(AgentSessionEffect::Unknown),
            target: Some(request.target.clone()),
        };
        self.sessions.append_batch(
            &request.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolCall { call },
                },
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolResult {
                        call_id: request.model_call.call_id.clone(),
                        name: request.model_call.name.clone(),
                        status: AgentToolResultStatus::Rejected,
                        summary: reason.to_string(),
                        data: None,
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                },
            ],
        )?;
        Ok(ToolPipelineSettlement::Completed)
    }

    fn validate_preparation(
        &self,
        request: &NativeToolRequest,
        preparation: &NativeToolPreparation,
    ) -> Result<(), String> {
        let call = &preparation.call;
        if call.call_id != request.model_call.call_id
            || call.provider_call_id != request.model_call.provider_call_id
            || call.name != request.model_call.name
            || call.native_name.as_deref().is_none_or(str::is_empty)
            || call.target.as_ref() != Some(&request.target)
            || call.effect.is_none()
            || preparation.expires_at_unix_ms <= current_unix_ms()
            || preparation.parallel
                && (call.effect != Some(AgentSessionEffect::ReadOnly)
                    || preparation.idempotency != NativeToolIdempotency::Yes
                    || preparation.exclusive)
        {
            return Err("native tool preparation violated its frozen contract".into());
        }
        Ok(())
    }

    async fn execute_native(
        &self,
        preparation: &NativeToolPreparation,
        approved: bool,
        cancellation: CancellationToken,
    ) -> Result<NativeToolResult, String> {
        let native = Arc::clone(&self.native);
        let token = preparation.token.clone();
        tokio::task::spawn_blocking(move || native.execute(&token, approved, cancellation))
            .await
            .map_err(|error| format!("native tool worker failed: {error}"))?
    }

    fn finish_native(
        &self,
        request: &NativeToolRequest,
        preparation: &NativeToolPreparation,
        result: Result<NativeToolResult, String>,
    ) -> Result<(), String> {
        let mut result = result.unwrap_or_else(|error| NativeToolResult {
            call_id: request.model_call.call_id.clone(),
            native_name: preparation.call.native_name.clone().unwrap_or_default(),
            target_id: request.target.target_id.clone(),
            effect: preparation
                .call
                .effect
                .unwrap_or(AgentSessionEffect::Unknown),
            status: AgentToolResultStatus::Failed,
            summary: error,
            data: None,
            duration_ms: None,
            evidence_refs: Vec::new(),
            artifacts: Vec::new(),
        });
        if result.call_id != request.model_call.call_id
            || Some(result.native_name.as_str()) != preparation.call.native_name.as_deref()
            || result.target_id != request.target.target_id
            || Some(result.effect) != preparation.call.effect
            || result.summary.trim().is_empty()
        {
            result = NativeToolResult {
                call_id: request.model_call.call_id.clone(),
                native_name: preparation.call.native_name.clone().unwrap_or_default(),
                target_id: request.target.target_id.clone(),
                effect: preparation
                    .call
                    .effect
                    .unwrap_or(AgentSessionEffect::Unknown),
                status: AgentToolResultStatus::Failed,
                summary: "native result evidence did not match the frozen call".into(),
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
                artifacts: Vec::new(),
            };
        }
        let mut stored_data_artifact = None;
        if let Some(data) = result.data.as_ref() {
            let data_size = serde_json::to_vec(data)
                .map_err(|error| format!("failed to measure native tool result: {error}"))?
                .len();
            if data_size > MAX_INLINE_TOOL_DATA_BYTES {
                let artifact = self.artifacts.store_json(
                    &request.session_id,
                    "tool-result",
                    &format!("Output for {}", request.model_call.name),
                    data,
                )?;
                result.data = Some(serde_json::json!({
                    "artifactRef": artifact.artifact_id,
                    "sha256": artifact.sha256,
                    "sizeBytes": artifact.size_bytes,
                    "sensitivity": artifact.sensitivity,
                    "truncated": true,
                }));
                stored_data_artifact = Some(artifact);
            }
        }
        let hook_context = AgentAfterToolContext {
            session_id: request.session_id.clone(),
            task_id: request.task_id.clone(),
            turn_id: request.turn_id.clone(),
            step_id: request.step_id.clone(),
            request_id: request.request_id.clone(),
            call_id: request.model_call.call_id.clone(),
            name: request.model_call.name.clone(),
            effect: result.effect,
            target: request.target.clone(),
            status: result.status,
            summary: result.summary.clone(),
        };
        let decisions = if result.status == AgentToolResultStatus::Completed {
            self.hooks.after_tool(&hook_context)
        } else {
            self.hooks.tool_failed(&hook_context)
        };
        let decisions = decisions.map_err(|error| format!("toolLifecycleHookFailed: {error}"))?;
        let mut payloads = stored_data_artifact
            .iter()
            .map(|artifact| AgentScopedPayload {
                turn_id: Some(request.turn_id.clone()),
                step_id: Some(request.step_id.clone()),
                payload: AgentSessionEventPayload::ContextArtifact {
                    artifact_id: artifact.artifact_id.clone(),
                    kind: artifact.kind.clone(),
                    title: artifact.title.clone(),
                    size_bytes: Some(artifact.size_bytes),
                    media_type: Some(artifact.media_type.clone()),
                    sha256: Some(artifact.sha256.clone()),
                    sensitivity: Some(artifact.sensitivity),
                },
            })
            .chain(result.artifacts.iter().map(|artifact| AgentScopedPayload {
                turn_id: Some(request.turn_id.clone()),
                step_id: Some(request.step_id.clone()),
                payload: AgentSessionEventPayload::ContextArtifact {
                    artifact_id: artifact.artifact_id.clone(),
                    kind: artifact.kind.clone(),
                    title: artifact.title.clone(),
                    size_bytes: artifact.size_bytes,
                    media_type: artifact.media_type.clone(),
                    sha256: artifact.sha256.clone(),
                    sensitivity: None,
                },
            }))
            .collect::<Vec<_>>();
        payloads.push(AgentScopedPayload {
            turn_id: Some(request.turn_id.clone()),
            step_id: Some(request.step_id.clone()),
            payload: AgentSessionEventPayload::ToolResult {
                call_id: request.model_call.call_id.clone(),
                name: request.model_call.name.clone(),
                status: result.status,
                summary: result.summary.clone(),
                data: result.data,
                duration_ms: result.duration_ms,
                evidence_refs: result.evidence_refs,
            },
        });
        payloads.push(AgentScopedPayload {
            turn_id: None,
            step_id: None,
            payload: AgentSessionEventPayload::TaskEvidence {
                evidence_id: format!("tool-result-{}", Uuid::new_v4().simple()),
                kind: "native-tool-result".into(),
                summary: format!("{}: {}", request.model_call.name, result.summary),
            },
        });
        for decision in decisions {
            if let AgentAfterToolDecision::AppendContext {
                message_id,
                label,
                content,
            } = decision
            {
                payloads.push(AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::InboxSpliced {
                        operation: super::AgentInboxOperation::Enqueued,
                        lane: AgentInboxLane::NextStep,
                        messages: vec![AgentInboxMessage {
                            message_id,
                            client_submission_id: None,
                            content,
                            source: AgentMessageSource::runtime(label),
                        }],
                    },
                });
            }
        }
        self.sessions.append_batch(&request.session_id, payloads)?;
        Ok(())
    }

    pub(crate) async fn decide(
        &self,
        entry: &Arc<AgentEntry>,
        input: AgentToolDecisionInput,
        decision: AgentToolDecision,
    ) -> Result<(), String> {
        let key = approval_key(&input.session_id, &input.step_id, &input.call_id);
        let pending = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?;
            let record = pending.get_mut(&key).ok_or_else(|| {
                "approval is unknown, terminal, or was recovered as uncertain".to_string()
            })?;
            if record.status != PendingStatus::Requested
                || record.approval_id != input.approval_id
                || record.request.session_id != input.session_id
                || record.request.turn_id != input.turn_id
                || record.request.step_id != input.step_id
                || record.request.request_id != input.request_id
                || record.request.model_call.call_id != input.call_id
            {
                return Err("approval identity or state is stale".into());
            }
            record.status = if decision == AgentToolDecision::Approve {
                PendingStatus::Executing
            } else {
                PendingStatus::Cancelled
            };
            record.clone()
        };

        if current_unix_ms() >= pending.preparation.expires_at_unix_ms {
            self.append_terminal_approval(
                &pending,
                AgentToolApprovalStatus::Expired,
                AgentToolResultStatus::TimedOut,
                "native approval expired before the decision was committed",
            )?;
            self.native.abandon(&pending.preparation.token);
            self.pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .remove(&key);
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
            return Err("approval expired".into());
        }

        if decision == AgentToolDecision::Reject {
            self.append_terminal_approval(
                &pending,
                AgentToolApprovalStatus::Rejected,
                AgentToolResultStatus::Rejected,
                "native approval was rejected",
            )?;
            self.native.abandon(&pending.preparation.token);
            self.pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .remove(&key);
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
            return Ok(());
        }

        self.sessions.append(
            &pending.request.session_id,
            Some(pending.request.turn_id.clone()),
            Some(pending.request.step_id.clone()),
            AgentSessionEventPayload::ToolApproval {
                request_id: pending.request.request_id.clone(),
                call_id: pending.request.model_call.call_id.clone(),
                approval_id: Some(pending.approval_id.clone()),
                status: AgentToolApprovalStatus::Approved,
                risk: pending.preparation.call.effect,
                reason: Some("nativeApprovalCommitted".into()),
                expires_at_unix_ms: Some(pending.preparation.expires_at_unix_ms),
                prompt: None,
            },
        )?;
        self.append_execution_dispatch(&pending.request, &pending.preparation)?;
        let result = self
            .execute_native(&pending.preparation, true, entry.cancellation())
            .await;
        let still_executing = self
            .pending
            .lock()
            .map_err(|_| "native approval registry is unavailable".to_string())?
            .get(&key)
            .is_some_and(|record| record.status == PendingStatus::Executing);
        if still_executing {
            self.finish_native(&pending.request, &pending.preparation, result)?;
            self.pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .remove(&key);
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
        }
        Ok(())
    }

    async fn continue_after_pending(
        &self,
        entry: &Arc<AgentEntry>,
        pending: &PendingTool,
    ) -> Result<ToolPipelineSettlement, String> {
        self.resume_after_tool(entry)?;
        self.process_model_calls(
            entry,
            &pending.request.turn_id,
            &pending.request.step_id,
            &pending.request.request_id,
            pending.remaining_calls.clone(),
        )
        .await
    }

    fn append_terminal_approval(
        &self,
        pending: &PendingTool,
        approval_status: AgentToolApprovalStatus,
        result_status: AgentToolResultStatus,
        reason: &str,
    ) -> Result<(), String> {
        self.sessions.append_batch(
            &pending.request.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(pending.request.turn_id.clone()),
                    step_id: Some(pending.request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolApproval {
                        request_id: pending.request.request_id.clone(),
                        call_id: pending.request.model_call.call_id.clone(),
                        approval_id: Some(pending.approval_id.clone()),
                        status: approval_status,
                        risk: pending.preparation.call.effect,
                        reason: Some(reason.into()),
                        expires_at_unix_ms: Some(pending.preparation.expires_at_unix_ms),
                        prompt: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(pending.request.turn_id.clone()),
                    step_id: Some(pending.request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolResult {
                        call_id: pending.request.model_call.call_id.clone(),
                        name: pending.request.model_call.name.clone(),
                        status: result_status,
                        summary: reason.into(),
                        data: None,
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                },
            ],
        )?;
        Ok(())
    }

    fn resume_after_tool(&self, entry: &Arc<AgentEntry>) -> Result<(), String> {
        entry.set_phase(AgentLifecyclePhase::Running)?;
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        if snapshot.status == AgentSessionStatus::Waiting {
            self.sessions.append(
                &entry.session_id,
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status: AgentSessionStatus::Running,
                    reason: Some("toolBoundaryResolved".into()),
                },
            )?;
        }
        Ok(())
    }

    pub(crate) fn cancel_session(&self, entry: &Arc<AgentEntry>) -> Result<(), String> {
        entry.cancel();
        let session_id = &entry.session_id;
        let keys = self
            .pending
            .lock()
            .map_err(|_| "native approval registry is unavailable".to_string())?
            .iter()
            .filter(|(_, record)| record.request.session_id == *session_id)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            let (pending, was_executing) = {
                let mut records = self
                    .pending
                    .lock()
                    .map_err(|_| "native approval registry is unavailable".to_string())?;
                let Some(record) = records.get_mut(&key) else {
                    continue;
                };
                if record.status == PendingStatus::Cancelled {
                    continue;
                }
                let was_executing = record.status == PendingStatus::Executing;
                record.status = PendingStatus::Cancelled;
                (record.clone(), was_executing)
            };
            if was_executing {
                self.sessions.append(
                    &pending.request.session_id,
                    Some(pending.request.turn_id.clone()),
                    Some(pending.request.step_id.clone()),
                    AgentSessionEventPayload::ToolResult {
                        call_id: pending.request.model_call.call_id.clone(),
                        name: pending.request.model_call.name.clone(),
                        status: AgentToolResultStatus::Cancelled,
                        summary: "native tool execution was cancelled".into(),
                        data: None,
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                )?;
            } else {
                self.append_terminal_approval(
                    &pending,
                    AgentToolApprovalStatus::Cancelled,
                    AgentToolResultStatus::Cancelled,
                    "native tool call was cancelled",
                )?;
            }
            self.native.abandon(&pending.preparation.token);
            self.pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .remove(&key);
            self.changed.notify_waiters();
        }
        self.native
            .cancel_task(&self.sessions.snapshot(session_id)?.header.task_id)
    }

    pub(crate) async fn wait_for_expiry(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        loop {
            let candidate = self
                .pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?
                .iter()
                .filter(|(_, record)| {
                    record.request.session_id == entry.session_id
                        && record.status == PendingStatus::Requested
                })
                .min_by_key(|(_, record)| record.preparation.expires_at_unix_ms)
                .map(|(key, record)| (key.clone(), record.clone()));
            let Some((key, candidate)) = candidate else {
                return Ok(false);
            };
            let now = current_unix_ms();
            let delay = candidate.preparation.expires_at_unix_ms.saturating_sub(now);
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {
                    let expired = {
                        let mut records = self.pending.lock().map_err(|_| "native approval registry is unavailable".to_string())?;
                        let Some(record) = records.get_mut(&key) else { continue };
                        if record.status != PendingStatus::Requested {
                            continue;
                        }
                        record.status = PendingStatus::Cancelled;
                        record.clone()
                    };
                    self.append_terminal_approval(
                        &expired,
                        AgentToolApprovalStatus::Expired,
                        AgentToolResultStatus::TimedOut,
                        "native approval expired",
                    )?;
                    self.native.abandon(&expired.preparation.token);
                    self.pending.lock().map_err(|_| "native approval registry is unavailable".to_string())?.remove(&key);
                    match self.continue_after_pending(entry, &expired).await? {
                        ToolPipelineSettlement::Completed => return Ok(true),
                        ToolPipelineSettlement::Waiting => continue,
                        ToolPipelineSettlement::Cancelled => return Ok(false),
                    }
                }
                _ = self.changed.notified() => continue,
            }
        }
    }

    pub(crate) fn recover_waiting(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        let events = self.sessions.all_events(&entry.session_id)?;
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let mut calls = HashMap::<(String, String), RecordedToolCall>::new();
        let mut approvals = HashMap::<
            (String, String),
            (String, Option<String>, AgentToolApprovalStatus, u64),
        >::new();
        let mut results = HashMap::<(String, String), ()>::new();
        let mut executions = HashMap::<(String, String), ()>::new();
        for event in &events {
            let Some(step_id) = event.step_id.clone() else {
                continue;
            };
            match &event.payload {
                AgentSessionEventPayload::ToolCall { call } => {
                    calls.insert((step_id, call.call_id.clone()), call.clone());
                }
                AgentSessionEventPayload::ToolApproval {
                    request_id,
                    call_id,
                    approval_id,
                    status,
                    expires_at_unix_ms,
                    ..
                } => {
                    approvals.insert(
                        (step_id, call_id.clone()),
                        (
                            request_id.clone(),
                            approval_id.clone(),
                            *status,
                            expires_at_unix_ms.unwrap_or(event.time_unix_ms),
                        ),
                    );
                }
                AgentSessionEventPayload::ToolResult { call_id, .. } => {
                    results.insert((step_id, call_id.clone()), ());
                }
                AgentSessionEventPayload::ToolExecution { call_id, .. } => {
                    executions.insert((step_id, call_id.clone()), ());
                }
                _ => {}
            }
        }
        let mut resumable = false;
        for ((step_id, call_id), (request_id, approval_id, status, expires_at)) in approvals {
            if results.contains_key(&(step_id.clone(), call_id.clone())) {
                continue;
            }
            let call = calls
                .get(&(step_id.clone(), call_id.clone()))
                .ok_or_else(|| "recovery found approval without durable tool call".to_string())?;
            let turn_id = events
                .iter()
                .find(|event| event.step_id.as_deref() == Some(&step_id))
                .and_then(|event| event.turn_id.clone())
                .ok_or_else(|| "recovery found an unscoped tool call".to_string())?;
            if status == AgentToolApprovalStatus::Approved
                && executions.contains_key(&(step_id.clone(), call_id.clone()))
            {
                self.sessions.append(
                    &entry.session_id,
                    None,
                    None,
                    AgentSessionEventPayload::TaskState {
                        status: "waiting".into(),
                        phase: Some("reconciliation".into()),
                        progress: None,
                        recovery: Some(AgentRecoveryState {
                            status: AgentRecoveryStatus::Required,
                            summary: Some(match call.effect {
                                Some(AgentSessionEffect::ReadOnly) => "A read-only native call was dispatched without a durable result and has an uncertain outcome. It was not replayed; reconcile before continuing.".into(),
                                _ => "A side-effecting native call was dispatched without a durable result and has an uncertain outcome. Reconcile the frozen target before continuing.".into(),
                            }),
                        }),
                        fleet: None,
                    },
                )?;
                continue;
            }
            if !matches!(
                status,
                AgentToolApprovalStatus::Requested | AgentToolApprovalStatus::Approved
            ) {
                continue;
            }
            let approval_id = match status {
                AgentToolApprovalStatus::Requested => approval_id.ok_or_else(|| {
                    "recovery found a requested approval without approvalId".to_string()
                })?,
                AgentToolApprovalStatus::Approved => approval_id.unwrap_or_default(),
                _ => unreachable!(),
            };
            let target =
                snapshot.header.target.clone().ok_or_else(|| {
                    "recovered tool call has no frozen Session target".to_string()
                })?;
            let raw_calls = events
                .iter()
                .filter(|event| event.step_id.as_deref() == Some(&step_id))
                .find_map(|event| match &event.payload {
                    AgentSessionEventPayload::AssistantMessage { content, .. }
                        if super::assistant_tool_calls(content)
                            .iter()
                            .any(|candidate| candidate.call_id == call_id) =>
                    {
                        Some(super::assistant_tool_calls(content))
                    }
                    _ => None,
                })
                .ok_or_else(|| {
                    "recovery found no model call for the durable native call".to_string()
                })?;
            let raw_index = raw_calls
                .iter()
                .position(|candidate| candidate.call_id == call_id)
                .ok_or_else(|| "recovery lost the durable model call".to_string())?;
            let raw_call = &raw_calls[raw_index];
            let remaining_calls = raw_calls
                .iter()
                .skip(raw_index + 1)
                .map(|call| ModelToolCall {
                    call_id: call.call_id.clone(),
                    provider_call_id: call.provider_call_id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                })
                .collect();
            let request = NativeToolRequest {
                session_id: entry.session_id.clone(),
                task_id: snapshot.header.task_id.clone(),
                goal: snapshot.header.goal.clone(),
                success_criteria: snapshot.header.success_criteria.clone(),
                turn_id,
                step_id: step_id.clone(),
                request_id,
                model_call: ModelToolCall {
                    call_id: raw_call.call_id.clone(),
                    provider_call_id: raw_call.provider_call_id.clone(),
                    name: raw_call.name.clone(),
                    arguments: raw_call.arguments.clone(),
                },
                target,
                permission_mode: snapshot
                    .header
                    .permission_mode
                    .ok_or_else(|| "recovered tool call has no Rust permission mode".to_string())?,
            };
            let mut preparation = self.native.prepare(request.clone())?;
            if preparation.call != *call {
                self.native.abandon(&preparation.token);
                return Err("recovered native preparation drifted from the durable call".into());
            }
            if status == AgentToolApprovalStatus::Requested {
                preparation.expires_at_unix_ms = expires_at;
            }
            self.validate_preparation(&request, &preparation)?;
            if status == AgentToolApprovalStatus::Requested && current_unix_ms() >= expires_at {
                let pending = PendingTool {
                    request,
                    preparation,
                    approval_id,
                    remaining_calls,
                    status: PendingStatus::Cancelled,
                };
                self.append_terminal_approval(
                    &pending,
                    AgentToolApprovalStatus::Expired,
                    AgentToolResultStatus::TimedOut,
                    "native approval expired while the app was not running",
                )?;
                self.native.abandon(&pending.preparation.token);
                resumable = true;
            } else {
                let pending_status = if status == AgentToolApprovalStatus::Approved {
                    AgentRecoveryStatus::Available
                } else {
                    AgentRecoveryStatus::None
                };
                self.pending
                    .lock()
                    .map_err(|_| "native approval registry is unavailable".to_string())?
                    .insert(
                        approval_key(&entry.session_id, &step_id, &call_id),
                        PendingTool {
                            request,
                            preparation,
                            approval_id,
                            remaining_calls,
                            status: if status == AgentToolApprovalStatus::Approved {
                                PendingStatus::Authorized
                            } else {
                                PendingStatus::Requested
                            },
                        },
                    );
                if pending_status == AgentRecoveryStatus::Available {
                    entry.set_phase(AgentLifecyclePhase::Waiting)?;
                    self.sessions.append_batch(
                        &entry.session_id,
                        vec![
                            AgentScopedPayload {
                                turn_id: None,
                                step_id: None,
                                payload: AgentSessionEventPayload::AgentStatus {
                                    status: AgentSessionStatus::Waiting,
                                    reason: Some("authorizedCallRecoveryAvailable".into()),
                                },
                            },
                            AgentScopedPayload {
                                turn_id: None,
                                step_id: None,
                                payload: AgentSessionEventPayload::TaskState {
                                    status: "waiting".into(),
                                    phase: Some("recovery".into()),
                                    progress: None,
                                    recovery: Some(AgentRecoveryState {
                                        status: pending_status,
                                        summary: Some("Authorization was committed before dispatch. Explicit resume can execute it exactly once.".into()),
                                    }),
                                    fleet: None,
                                },
                            },
                        ],
                    )?;
                }
            }
        }
        if resumable {
            self.resume_after_tool(entry)?;
        }
        Ok(resumable)
    }

    pub(crate) async fn resume_authorized(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        let candidate = {
            let mut records = self
                .pending
                .lock()
                .map_err(|_| "native approval registry is unavailable".to_string())?;
            let candidate = records
                .iter_mut()
                .find(|(_, record)| {
                    record.request.session_id == entry.session_id
                        && record.status == PendingStatus::Authorized
                })
                .map(|(key, record)| {
                    record.status = PendingStatus::Executing;
                    (key.clone(), record.clone())
                });
            candidate
        };
        let Some((key, pending)) = candidate else {
            return Ok(false);
        };
        self.append_execution_dispatch(&pending.request, &pending.preparation)?;
        let result = self
            .execute_native(&pending.preparation, true, entry.cancellation())
            .await;
        self.finish_native(&pending.request, &pending.preparation, result)?;
        self.pending
            .lock()
            .map_err(|_| "native approval registry is unavailable".to_string())?
            .remove(&key);
        self.sessions.append(
            &entry.session_id,
            None,
            None,
            AgentSessionEventPayload::TaskState {
                status: "running".into(),
                phase: Some("recovered".into()),
                progress: None,
                recovery: Some(AgentRecoveryState {
                    status: AgentRecoveryStatus::Completed,
                    summary: Some(
                        "Authorized native call resumed from the durable pre-dispatch boundary."
                            .into(),
                    ),
                }),
                fleet: None,
            },
        )?;
        self.continue_after_pending(entry, &pending).await?;
        Ok(true)
    }
}

fn orchestration_effect(name: &str) -> AgentSessionEffect {
    match name {
        "inspect_child_agent" => AgentSessionEffect::ReadOnly,
        "cancel_child_agent" | "fleet_abort" => AgentSessionEffect::Destructive,
        _ => AgentSessionEffect::StateChange,
    }
}

fn approval_key(session_id: &str, step_id: &str, call_id: &str) -> String {
    format!("{session_id}\0{step_id}\0{call_id}")
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
