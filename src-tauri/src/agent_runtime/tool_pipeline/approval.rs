use std::sync::Arc;

use serde_json::Value;

use crate::agent_runtime::{
    driver::close_open_scope, model::tool_call_arguments_are_ephemeral,
    terminal_execution_needs_user_action,
};

use super::*;

impl AgentToolPipeline {
    pub(crate) async fn decide(
        &self,
        entry: &Arc<AgentEntry>,
        input: AgentToolDecisionInput,
        decision: AgentToolDecision,
    ) -> Result<AgentToolDecisionSettlement, String> {
        let key = approval_key(&input.session_id, &input.step_id, &input.call_id);
        let mut pending = entry
            .with_input_admission(|| {
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| "Native approval registry is unavailable".to_string())?;
                let record = pending.get_mut(&key).ok_or_else(|| {
                    "Approval is unknown, terminal, or was recovered as uncertain".to_string()
                })?;
                if record.status != PendingStatus::Requested
                    || record.approval_id != input.approval_id
                    || record.request.session_id != input.session_id
                    || record.request.turn_id != input.turn_id
                    || record.request.step_id != input.step_id
                    || record.request.request_id != input.request_id
                    || record.request.model_call.call_id != input.call_id
                {
                    return Err("Approval identity or state is stale".into());
                }
                record.status = PendingStatus::Executing;
                Ok(record.clone())
            })?
            .ok_or("Agent Session is stopping")?;
        let _owner = PendingExecutionGuard {
            pipeline: self,
            key: key.clone(),
            token: pending.preparation.token.clone(),
        };

        if current_unix_ms() >= pending.preparation.expires_at_unix_ms {
            self.append_terminal_approval(
                &pending,
                AgentToolApprovalStatus::Expired,
                AgentToolResultStatus::TimedOut,
                "Native approval expired before the decision was committed",
            )?;
            self.native.abandon(&pending.preparation.token);
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
            return Ok(AgentToolDecisionSettlement::Expired);
        }

        if decision == AgentToolDecision::Reject {
            self.append_terminal_approval(
                &pending,
                AgentToolApprovalStatus::Rejected,
                AgentToolResultStatus::Rejected,
                "Native approval was rejected",
            )?;
            self.native.abandon(&pending.preparation.token);
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
            return Ok(AgentToolDecisionSettlement::Resolved);
        }

        // Recheck live native policy without running before_tool again or charging again.
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
            Err(error) => {
                self.fail_pending_revalidation(entry, &pending, &error)
                    .await?;
                return Ok(AgentToolDecisionSettlement::Resolved);
            }
        };
        let refreshed_lease = PreparedLease::new(self.native.clone(), &refreshed.token);
        if let Err(error) = self.ensure_capability(
            entry,
            &pending.request.model_call.name,
            refreshed.call.effect.unwrap_or(AgentSessionEffect::Unknown),
            &pending.request.target.target_id,
        ) {
            self.fail_pending_revalidation(entry, &pending, &error)
                .await?;
            return Ok(AgentToolDecisionSettlement::Resolved);
        }
        if refreshed.call != pending.preparation.call
            || refreshed.idempotency != pending.preparation.idempotency
            || refreshed.parallel != pending.preparation.parallel
            || refreshed.exclusive != pending.preparation.exclusive
        {
            self.fail_pending_revalidation(
                entry,
                &pending,
                "Approval policy changed; no operation was dispatched. Inspect current state and request a fresh call.",
            )
            .await?;
            return Ok(AgentToolDecisionSettlement::Resolved);
        }
        pending.preparation = refreshed;

        let dispatched = entry.with_input_admission(|| {
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
            if !requires_runner_dispatch_journal(&pending.preparation) {
                self.append_execution_dispatch(&pending.request, &pending.preparation)?;
            }
            Ok(())
        })?;
        if dispatched.is_none() {
            self.cancel_pending_dispatch(&pending)?;
            return Err("Agent Session is stopping".into());
        }
        let result = self
            .execute_native(entry, &pending.request, &pending.preparation, true)
            .await;
        drop(refreshed_lease);
        let still_executing = self
            .pending
            .lock()
            .map_err(|_| "Native approval registry is unavailable".to_string())?
            .get(&key)
            .is_some_and(|record| record.status == PendingStatus::Executing);
        if still_executing {
            if let Err(error) = self.finish_native(&pending.request, &pending.preparation, result) {
                if is_terminal_call_blocked(&error) {
                    self.commit_pending_not_started(&pending, "terminalExecutionBlocked")?;
                    self.settle_blocked_terminal_call(entry, &error)?;
                }
                return Err(error);
            }
            self.changed.notify_waiters();
            self.continue_after_pending(entry, &pending).await?;
        }
        Ok(AgentToolDecisionSettlement::Resolved)
    }

    async fn fail_pending_revalidation(
        &self,
        entry: &Arc<AgentEntry>,
        pending: &PendingTool,
        error: &str,
    ) -> Result<(), String> {
        self.append_terminal_approval(
            pending,
            AgentToolApprovalStatus::Cancelled,
            AgentToolResultStatus::Cancelled,
            error,
        )?;
        self.continue_after_pending(entry, pending).await?;
        Ok(())
    }

    pub(crate) fn pending_approval_arguments(
        &self,
        input: &AgentToolDecisionInput,
    ) -> Result<Option<Value>, String> {
        let key = approval_key(&input.session_id, &input.step_id, &input.call_id);
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Native approval registry is unavailable".to_string())?;
        let Some(record) = pending.get(&key) else {
            return Ok(None);
        };
        if record.status != PendingStatus::Requested
            || record.approval_id != input.approval_id
            || record.request.session_id != input.session_id
            || record.request.turn_id != input.turn_id
            || record.request.step_id != input.step_id
            || record.request.request_id != input.request_id
            || record.request.model_call.call_id != input.call_id
        {
            return Err("Approval identity or state is stale".into());
        }
        Ok(tool_call_arguments_are_ephemeral(
            &record.request.model_call.name,
            &record.request.model_call.arguments,
        )
        .then(|| record.request.model_call.arguments.clone()))
    }

    pub(super) async fn continue_after_pending(
        &self,
        entry: &Arc<AgentEntry>,
        pending: &PendingTool,
    ) -> Result<ToolPipelineSettlement, String> {
        let calls = if pending.preparation.call.native_name.as_deref() == Some("exec_command")
            && pending.preparation.call.arguments["elevated"] == serde_json::json!(true)
        {
            self.commit_pending_not_started(
                pending,
                "Wait for the approved sudo command's result and decide the next step in a fresh model request",
            )?;
            Vec::new()
        } else {
            pending.remaining_calls.clone()
        };
        let outcome = self
            .process_model_calls(
                entry,
                &pending.request.turn_id,
                &pending.request.step_id,
                &pending.request.request_id,
                calls,
            )
            .await;
        if matches!(outcome, Ok(ToolPipelineSettlement::Completed)) {
            self.resume_after_tool(entry)?;
        }
        if let Err(error) = &outcome {
            if error.starts_with("subagentToolBudgetExceeded:") {
                close_open_scope(&self.sessions, entry, error)?;
                self.sessions.terminate(
                    &entry.session_id,
                    AgentSessionStatus::Failed,
                    error.clone(),
                )?;
                entry.set_phase(AgentLifecyclePhase::Stopping)?;
            } else if is_terminal_call_blocked(error) {
                self.settle_blocked_terminal_call(entry, error)?;
            } else {
                self.mark_scheduler_failure(entry, error)?;
            }
        }
        outcome
    }

    pub(super) fn append_terminal_approval(
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
                        approval_id: (!pending.approval_id.is_empty())
                            .then(|| pending.approval_id.clone()),
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

    pub(super) fn commit_pending_not_started(
        &self,
        pending: &PendingTool,
        reason: &str,
    ) -> Result<(), String> {
        for call in &pending.remaining_calls {
            let mut request = pending.request.clone();
            request.model_call = call.clone();
            self.commit_not_started(&request, reason)?;
        }
        Ok(())
    }

    pub(super) fn cancel_pending_dispatch(&self, pending: &PendingTool) -> Result<(), String> {
        self.append_terminal_approval(
            pending,
            AgentToolApprovalStatus::Cancelled,
            AgentToolResultStatus::Cancelled,
            "Agent stopped before native dispatch",
        )?;
        self.commit_pending_not_started(pending, "cancelled")
    }

    pub(super) fn settle_blocked_terminal_call(
        &self,
        entry: &Arc<AgentEntry>,
        reason: &str,
    ) -> Result<(), String> {
        if terminal_execution_needs_user_action(reason) {
            return self.mark_terminal_execution_blocked(entry, reason);
        }
        self.terminate_terminal_target(entry, reason)
    }

    fn terminate_terminal_target(
        &self,
        entry: &Arc<AgentEntry>,
        reason: &str,
    ) -> Result<(), String> {
        close_open_scope(&self.sessions, entry, reason)?;
        self.sessions.terminate(
            &entry.session_id,
            AgentSessionStatus::Failed,
            reason.to_string(),
        )?;
        entry.set_phase(AgentLifecyclePhase::Stopping)
    }

    pub(in crate::agent_runtime) fn resume_after_tool(
        &self,
        entry: &Arc<AgentEntry>,
    ) -> Result<(), String> {
        entry.with_input_admission(|| {
            if self.sessions.snapshot(&entry.session_id)?.status == AgentSessionStatus::Waiting {
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
            entry.set_phase(AgentLifecyclePhase::Running)
        })?;
        Ok(())
    }
}
