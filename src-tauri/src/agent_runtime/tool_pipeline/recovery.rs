use std::collections::HashMap;
use std::sync::Arc;

use crate::agent_runtime::{
    assistant_tool_calls, model::recorded_tool_call_omits_replay, recovery::open_turn_id,
    skills::SKILL_TOOL,
};

use super::*;

impl AgentToolPipeline {
    pub(crate) fn cancel_native_task(&self, session_id: &str) -> Result<(), String> {
        self.native
            .cancel_task(&self.sessions.snapshot(session_id)?.header.task_id)
    }

    #[cfg(test)]
    pub(crate) fn cancel_session(&self, entry: &Arc<AgentEntry>) -> Result<(), String> {
        let interactions = self.cancel_session_interactions(entry);
        let native = self.cancel_native_task(&entry.session_id);
        interactions.and(native)
    }

    pub(crate) fn cancel_session_interactions(
        &self,
        entry: &Arc<AgentEntry>,
    ) -> Result<(), String> {
        {
            let gate = self.question_gate(&entry.session_id)?;
            let _gate = gate.lock().map_err(|_| "question gate unavailable")?;
            entry.cancel();
            #[cfg(all(
                feature = "native-input-acceptance",
                debug_assertions,
                target_os = "macos",
                target_arch = "aarch64"
            ))]
            crate::terminal_command::acceptance_trace::control_request(
                &entry.session_id,
                None,
                "cancel-token",
            )?;
            self.cancel_questions(&entry.session_id)?;
            self.cancel_skill_proposals(&entry.session_id)?;
        }
        let session_id = &entry.session_id;
        let keys = self
            .pending
            .lock()
            .map_err(|_| "Native approval registry is unavailable".to_string())?
            .iter()
            .filter(|(_, record)| record.request.session_id == *session_id)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            let pending = {
                let mut records = self
                    .pending
                    .lock()
                    .map_err(|_| "Native approval registry is unavailable".to_string())?;
                let Some(record) = records.get_mut(&key) else {
                    continue;
                };
                if record.status == PendingStatus::Cancelled {
                    continue;
                }
                if record.status == PendingStatus::Executing {
                    // Its decision owner must join the worker and commit the actual outcome.
                    continue;
                }
                record.status = PendingStatus::Cancelled;
                record.clone()
            };
            let _owner = PendingExecutionGuard {
                pipeline: self,
                key: key.clone(),
                token: pending.preparation.token.clone(),
            };
            self.append_terminal_approval(
                &pending,
                AgentToolApprovalStatus::Cancelled,
                AgentToolResultStatus::Cancelled,
                "Native tool call was cancelled",
            )?;
            for call in &pending.remaining_calls {
                let mut request = pending.request.clone();
                request.model_call = call.clone();
                self.commit_not_started(&request, "cancelled")?;
            }
            self.native.abandon(&pending.preparation.token);
            self.pending
                .lock()
                .map_err(|_| "Native approval registry is unavailable".to_string())?
                .remove(&key);
            self.changed.notify_waiters();
        }
        Ok(())
    }

    pub(crate) async fn await_pending_executions(&self, entry: &AgentEntry) -> Result<(), String> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let executing = self
                .pending
                .lock()
                .map_err(|_| "Native approval registry is unavailable".to_string())?
                .values()
                .any(|record| {
                    record.request.session_id == entry.session_id
                        && record.status == PendingStatus::Executing
                });
            if !executing {
                return Ok(());
            }
            changed.await;
        }
    }

    pub(crate) async fn wait_for_expiry(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        let cancellation = entry.cancellation();
        loop {
            if cancellation.is_cancelled() {
                return Ok(false);
            }
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let candidate = self
                .pending
                .lock()
                .map_err(|_| "Native approval registry is unavailable".to_string())?
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
                _ = cancellation.cancelled() => return Ok(false),
                _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {
                    let expired = entry.with_input_admission(|| {
                        let mut records = self.pending.lock().map_err(|_| "Native approval registry is unavailable".to_string())?;
                        Ok(records.get_mut(&key).filter(|record| record.status == PendingStatus::Requested).map(|record| {
                            record.status = PendingStatus::Executing;
                            record.clone()
                        }))
                    })?;
                    let Some(expired) = expired else { return Ok(false) };
                    let Some(expired) = expired else { continue };
                    let _owner = PendingExecutionGuard {
                        pipeline: self, key: key.clone(), token: expired.preparation.token.clone(),
                    };
                    self.append_terminal_approval(
                        &expired,
                        AgentToolApprovalStatus::Expired,
                        AgentToolResultStatus::TimedOut,
                        "Native approval expired",
                    )?;
                    self.native.abandon(&expired.preparation.token);
                    match self.continue_after_pending(entry, &expired).await? {
                        ToolPipelineSettlement::Completed => return Ok(true),
                        ToolPipelineSettlement::Waiting => continue,
                        ToolPipelineSettlement::Cancelled => return Ok(false),
                    }
                }
                _ = changed => continue,
            }
        }
    }

    fn record_uncertain_reconciliation_required(
        &self,
        session_id: &str,
        effect: Option<AgentSessionEffect>,
    ) -> Result<(), String> {
        self.sessions.append(
            session_id,
            None,
            None,
            AgentSessionEventPayload::TaskState {
                status: "waiting".into(),
                phase: Some("reconciliation".into()),
                progress: None,
                recovery: Some(AgentRecoveryState {
                    status: AgentRecoveryStatus::Required,
                    summary: Some(match effect {
                        Some(AgentSessionEffect::ReadOnly) => "A read-only native call was dispatched without a durable result and has an uncertain outcome. It was not replayed; reconcile before continuing.".into(),
                        _ => "A side-effecting native call was dispatched without a durable result and has an uncertain outcome. Reconcile the frozen target before continuing.".into(),
                    }),
                }),
                fleet: None,
            },
        )?;
        Ok(())
    }

    fn cancel_unrestartable_pending_call(
        &self,
        request: &NativeToolRequest,
        call: &RecordedToolCall,
        status: AgentToolApprovalStatus,
        approval_id: &str,
        expires_at: u64,
        remaining_calls: &[ModelToolCall],
        restricted_sudo: bool,
        sandbox: bool,
    ) -> Result<(), String> {
        let reason_code = if restricted_sudo {
            "sudoApprovalCancelledAfterRestart"
        } else if sandbox {
            "sandboxApprovalCancelledAfterRestart"
        } else {
            "ephemeralArgumentsUnavailableAfterRestart"
        };
        let reason = if restricted_sudo {
            "The remote sudo approval was closed after restart. Request the current operation for fresh approval."
        } else if sandbox {
            "The remote sandbox approval was closed after restart. Request the operation again to verify the current connection and policy."
        } else if status == AgentToolApprovalStatus::Approved {
            "An ephemeral tool call was authorized but not dispatched before restart; it was cancelled because its private arguments were not persisted."
        } else {
            "An ephemeral tool call approval was cancelled after restart because its private arguments were not persisted."
        };
        self.sessions.append_batch(
            &request.session_id,
            vec![
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolApproval {
                        request_id: request.request_id.clone(),
                        call_id: request.model_call.call_id.clone(),
                        approval_id: (!approval_id.is_empty()).then(|| approval_id.to_string()),
                        status: AgentToolApprovalStatus::Cancelled,
                        risk: call.effect,
                        reason: Some(reason_code.into()),
                        expires_at_unix_ms: Some(expires_at),
                        prompt: None,
                    },
                },
                AgentScopedPayload {
                    turn_id: Some(request.turn_id.clone()),
                    step_id: Some(request.step_id.clone()),
                    payload: AgentSessionEventPayload::ToolResult {
                        call_id: request.model_call.call_id.clone(),
                        name: request.model_call.name.clone(),
                        status: AgentToolResultStatus::Cancelled,
                        summary: reason.into(),
                        data: Some(serde_json::json!({
                            "recovery": "notRestartable",
                            "reason": reason_code
                        })),
                        duration_ms: None,
                        evidence_refs: Vec::new(),
                    },
                },
            ],
        )?;
        for remaining in remaining_calls {
            let mut remaining_request = request.clone();
            remaining_request.model_call = remaining.clone();
            self.commit_not_started(&remaining_request, reason_code)?;
        }
        Ok(())
    }

    fn record_authorized_recovery_available(
        &self,
        entry: &Arc<AgentEntry>,
        status: AgentRecoveryStatus,
    ) -> Result<(), String> {
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
                            status,
                            summary: Some("Authorization was committed before dispatch. Explicit resume can execute it exactly once.".into()),
                        }),
                        fleet: None,
                    },
                },
            ],
        )?;
        Ok(())
    }

    pub(crate) fn recover_waiting(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        let events = self.sessions.all_events(&entry.session_id)?;
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let open_turn = open_turn_id(&events);
        if snapshot.header.subagent.is_none() && open_turn.is_none() {
            return Ok(false);
        }
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
                .ok_or_else(|| "Recovery found approval without durable tool call".to_string())?;
            let turn_id = events
                .iter()
                .find(|event| event.step_id.as_deref() == Some(&step_id))
                .and_then(|event| event.turn_id.clone())
                .ok_or_else(|| "Recovery found an unscoped tool call".to_string())?;
            if status == AgentToolApprovalStatus::Requested && open_turn != Some(turn_id.as_str()) {
                continue;
            }
            if call.name == SKILL_TOOL {
                continue;
            }
            if status == AgentToolApprovalStatus::Approved
                && executions.contains_key(&(step_id.clone(), call_id.clone()))
            {
                self.record_uncertain_reconciliation_required(&entry.session_id, call.effect)?;
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
                    "Recovery found a requested approval without approvalId".to_string()
                })?,
                AgentToolApprovalStatus::Approved => approval_id.unwrap_or_default(),
                _ => unreachable!(),
            };
            let target =
                snapshot.header.target.clone().ok_or_else(|| {
                    "Recovered tool call has no frozen Session target".to_string()
                })?;
            let restricted_sudo = call.native_name.as_deref() == Some("exec_command")
                && call.arguments["elevated"] == serde_json::json!(true);
            let sandbox = call.arguments["sandboxExecutor"] == "bubblewrapV1";
            let raw_calls = events
                .iter()
                .filter(|event| event.step_id.as_deref() == Some(&step_id))
                .find_map(|event| match &event.payload {
                    AgentSessionEventPayload::AssistantMessage { content, .. }
                        if assistant_tool_calls(content)
                            .iter()
                            .any(|candidate| candidate.call_id == call_id) =>
                    {
                        Some(assistant_tool_calls(content))
                    }
                    _ => None,
                })
                // Cancelling an unsent elevation needs only its durable
                // approval and native call. It must not recover stale inputs.
                .or_else(|| (restricted_sudo || sandbox).then(|| vec![call.clone()]))
                .ok_or_else(|| {
                    "Recovery found no model call for the durable native call".to_string()
                })?;
            let raw_index = raw_calls
                .iter()
                .position(|candidate| candidate.call_id == call_id)
                .ok_or_else(|| "Recovery lost the durable model call".to_string())?;
            let raw_call = &raw_calls[raw_index];
            let remaining_calls: Vec<ModelToolCall> = raw_calls
                .iter()
                .skip(raw_index + 1)
                .filter(|call| !results.contains_key(&(step_id.clone(), call.call_id.clone())))
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
                scratch_target: self
                    .sessions
                    .scratch_ownership_target(&entry.session_id, &target)?,
                target,
                permission_mode: snapshot
                    .header
                    .permission_mode
                    .ok_or_else(|| "Recovered tool call has no Rust permission mode".to_string())?,
                execution_surface: snapshot.header.execution_surface,
            };
            // A restricted runner has no resumable authorization before the
            // durable send boundary. Request a new approval after restart.
            if restricted_sudo || sandbox || recorded_tool_call_omits_replay(call) {
                self.cancel_unrestartable_pending_call(
                    &request,
                    call,
                    status,
                    &approval_id,
                    expires_at,
                    &remaining_calls,
                    restricted_sudo,
                    sandbox,
                )?;
                resumable = true;
                continue;
            }
            let mut preparation = self.native.prepare(request.clone())?;
            let lease = Arc::new(PreparedLease::new(self.native.clone(), &preparation.token));
            if preparation.call != *call {
                self.native.abandon(&preparation.token);
                return Err("Recovered native preparation drifted from the durable call".into());
            }
            if let Err(error) = self.validate_preparation(&request, &preparation) {
                self.native.abandon(&preparation.token);
                return Err(error);
            }
            if status == AgentToolApprovalStatus::Requested {
                preparation.expires_at_unix_ms = expires_at;
            }
            if status == AgentToolApprovalStatus::Requested && current_unix_ms() >= expires_at {
                let pending = PendingTool {
                    _lease: lease.clone(),
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
                    "Native approval expired while the app was not running",
                )?;
                for call in &pending.remaining_calls {
                    let mut request = pending.request.clone();
                    request.model_call = call.clone();
                    self.commit_not_started(&request, "approvalExpiredDuringRecovery")?;
                }
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
                    .map_err(|_| "Native approval registry is unavailable".to_string())?
                    .insert(
                        approval_key(&entry.session_id, &step_id, &call_id),
                        PendingTool {
                            _lease: lease.clone(),
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
                    self.record_authorized_recovery_available(entry, pending_status)?;
                }
            }
        }
        if resumable {
            self.resume_after_tool(entry)?;
        }
        Ok(resumable)
    }

    pub(crate) async fn resume_authorized(&self, entry: &Arc<AgentEntry>) -> Result<bool, String> {
        if self.sessions.snapshot(&entry.session_id)?.recovery.status
            == AgentRecoveryStatus::Required
        {
            return Err("Unresolved tool execution requires reconciliation before resuming".into());
        }
        let candidate = entry
            .with_input_admission(|| {
                let mut records = self
                    .pending
                    .lock()
                    .map_err(|_| "Native approval registry is unavailable".to_string())?;
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
                Ok(candidate)
            })?
            .flatten();
        let Some((key, mut pending)) = candidate else {
            return Ok(false);
        };
        let _owner = PendingExecutionGuard {
            pipeline: self,
            key: key.clone(),
            token: pending.preparation.token.clone(),
        };
        self.native.abandon(&pending.preparation.token);
        let refreshed = match self.prepare_native(&pending.request) {
            Ok(refreshed) => refreshed,
            Err(error) if is_terminal_call_blocked(&error) => {
                self.append_terminal_approval(
                    &pending,
                    AgentToolApprovalStatus::Cancelled,
                    AgentToolResultStatus::Cancelled,
                    &error,
                )?;
                self.commit_pending_not_started(&pending, "terminalExecutionBlocked")?;
                self.settle_blocked_terminal_call(entry, &error)?;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let _lease = PreparedLease::new(self.native.clone(), &refreshed.token);
        if refreshed.call != pending.preparation.call {
            return Err("Recovered authorization drifted before dispatch".into());
        }
        pending.preparation = refreshed;
        self.ensure_capability(
            entry,
            &pending.request.model_call.name,
            pending
                .preparation
                .call
                .effect
                .unwrap_or(AgentSessionEffect::Unknown),
            &pending.request.target.target_id,
        )?;
        self.validate_preparation(&pending.request, &pending.preparation)?;
        if entry
            .with_input_admission(|| {
                if !requires_runner_dispatch_journal(&pending.preparation) {
                    self.append_execution_dispatch(&pending.request, &pending.preparation)?;
                }
                Ok(())
            })?
            .is_none()
        {
            self.cancel_pending_dispatch(&pending)?;
            return Ok(false);
        }
        let result = self
            .execute_native(entry, &pending.request, &pending.preparation, true)
            .await;
        if let Err(error) = self.finish_native(&pending.request, &pending.preparation, result) {
            if is_terminal_call_blocked(&error) {
                self.commit_pending_not_started(&pending, "terminalExecutionBlocked")?;
                self.settle_blocked_terminal_call(entry, &error)?;
            }
            return Err(error);
        }
        self.pending
            .lock()
            .map_err(|_| "Native approval registry is unavailable".to_string())?
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
