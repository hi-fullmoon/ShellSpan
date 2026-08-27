use super::budgets::{resolve_agent_budget_policy_v1, AgentBudgetLedgerV1};
use super::events::AgentEventJournalV1;
use super::protocol::{
    validate_agent_action_request_v1, validate_agent_get_snapshot_request_v1,
    validate_agent_send_message_request_v1, validate_agent_start_request_contract_v1,
    AgentActionKindV1, AgentActionRequestV1, AgentActionResultV1, AgentActiveRunSummaryV1,
    AgentCommandErrorCategoryV1, AgentCommandErrorV1, AgentEventTypeV1, AgentEventV1,
    AgentGetSnapshotRequestV1, AgentPlanItemV1, AgentPolicySnapshotV1, AgentProviderBindingV1,
    AgentPublicErrorCategoryV1, AgentPublicErrorV1, AgentRunSnapshotV1, AgentSchemaVersionV1,
    AgentSendMessageRequestV1, AgentStartRequestV1, AgentStartResultV1, AgentTargetBindingV1,
};
use super::state::AgentRunStateV1;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct AgentRunSeedV1 {
    pub(crate) target: AgentTargetBindingV1,
    pub(crate) provider: AgentProviderBindingV1,
    pub(crate) policy: AgentPolicySnapshotV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentBoundaryCompletion {
    CompleteNow,
    AwaitBoundary,
}

/// P1-A only needs synchronous, non-blocking control signals around a fake or
/// no-op orchestrator. Provider calls, tool dispatch, and SSH execution are
/// intentionally absent from this boundary.
pub(crate) trait AgentControlBoundary: Send + Sync {
    fn prepare_run(
        &self,
        request: &AgentStartRequestV1,
        run_id: &str,
    ) -> Result<AgentRunSeedV1, AgentCommandErrorV1>;

    fn request_pause(&self, _run_id: &str) -> AgentBoundaryCompletion {
        AgentBoundaryCompletion::CompleteNow
    }

    fn request_resume(&self, _run_id: &str) {}

    fn request_stop(&self, _run_id: &str) -> AgentBoundaryCompletion {
        AgentBoundaryCompletion::CompleteNow
    }

    fn accept_message(&self, _run_id: &str, _message: &str) {}
}

#[derive(Default)]
struct BlockedNoopAgentBoundary;

impl AgentControlBoundary for BlockedNoopAgentBoundary {
    fn prepare_run(
        &self,
        _request: &AgentStartRequestV1,
        _run_id: &str,
    ) -> Result<AgentRunSeedV1, AgentCommandErrorV1> {
        Err(AgentCommandErrorV1::new(
            AgentCommandErrorCategoryV1::P1Blocked,
            "Dynamic read-only Agent remains blocked until the later P1 work packages and the P0 verification gate are complete.",
        ))
    }
}

#[derive(Debug)]
pub(crate) struct AgentManagerOutcome<T> {
    pub(crate) value: T,
    pub(crate) events: Vec<AgentEventV1>,
}

impl<T> AgentManagerOutcome<T> {
    fn without_events(value: T) -> Self {
        Self {
            value,
            events: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentCachedActionRequestV1 {
    Pause(AgentActionRequestV1),
    Resume(AgentActionRequestV1),
    Stop(AgentActionRequestV1),
    SendMessage(AgentSendMessageRequestV1),
}

impl AgentCachedActionRequestV1 {
    fn client_action_id(&self) -> &str {
        match self {
            Self::Pause(request) | Self::Resume(request) | Self::Stop(request) => {
                &request.client_action_id
            }
            Self::SendMessage(request) => &request.client_action_id,
        }
    }
}

#[derive(Debug, Clone)]
struct AgentCachedActionV1 {
    request: AgentCachedActionRequestV1,
    result: AgentActionResultV1,
}

#[derive(Debug, Clone)]
struct AgentSteeringMessageV1 {
    _message_id: String,
    _message: String,
}

#[derive(Debug, Clone)]
struct AgentRunRecordV1 {
    run_id: String,
    started_at: u64,
    state: AgentRunStateV1,
    target: AgentTargetBindingV1,
    provider: AgentProviderBindingV1,
    policy: AgentPolicySnapshotV1,
    budgets: AgentBudgetLedgerV1,
    goal: String,
    plan: Vec<AgentPlanItemV1>,
    steering: VecDeque<AgentSteeringMessageV1>,
    error: Option<AgentPublicErrorV1>,
    journal: AgentEventJournalV1,
}

impl AgentRunRecordV1 {
    fn snapshot(&self) -> AgentRunSnapshotV1 {
        AgentRunSnapshotV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: self.run_id.clone(),
            last_sequence: self.journal.last_sequence(),
            state: self.state,
            target: self.target.clone(),
            provider: self.provider.clone(),
            policy: self.policy.clone(),
            budgets: self.budgets.snapshot(),
            goal: self.goal.clone(),
            plan: self.plan.clone(),
            tool_calls: Vec::new(),
            evidence: Vec::new(),
            pending_question: None,
            queued_steering_count: self.steering.len().try_into().unwrap_or(u8::MAX),
            report: None,
            error: self.error.clone(),
        }
    }

    fn active_summary(&self) -> AgentActiveRunSummaryV1 {
        AgentActiveRunSummaryV1 {
            run_id: self.run_id.clone(),
            state: self.state,
            goal: self.goal.clone(),
            profile_id: self.target.profile_id.clone(),
            started_at: self.started_at,
        }
    }

    fn append<T: Serialize>(
        &mut self,
        occurred_at: u64,
        event_type: AgentEventTypeV1,
        payload: &T,
        events: &mut Vec<AgentEventV1>,
    ) -> Result<(), AgentCommandErrorV1> {
        let event = self
            .journal
            .append(occurred_at, event_type, payload)
            .map_err(|_| {
                AgentCommandErrorV1::internal("Failed to append the Agent event journal.")
            })?;
        events.push(event);
        Ok(())
    }

    fn transition(
        &mut self,
        next: AgentRunStateV1,
        reason: AgentStateChangeReasonV1,
        occurred_at: u64,
        events: &mut Vec<AgentEventV1>,
    ) -> Result<(), AgentCommandErrorV1> {
        self.state
            .transition(next)
            .map_err(|_| AgentCommandErrorV1::invalid_state(&self.run_id, self.state))?;
        let payload = AgentStateChangedPayloadV1 {
            previous_state: self.state,
            state: next,
            reason,
        };
        self.append(
            occurred_at,
            AgentEventTypeV1::RunStateChanged,
            &payload,
            events,
        )?;
        self.state = next;
        Ok(())
    }

    fn complete_cancel(
        &mut self,
        reason: AgentStateChangeReasonV1,
        message: &str,
        occurred_at: u64,
        events: &mut Vec<AgentEventV1>,
    ) -> Result<(), AgentCommandErrorV1> {
        self.transition(AgentRunStateV1::Cancelled, reason, occurred_at, events)?;
        let error = AgentPublicErrorV1 {
            schema_version: AgentSchemaVersionV1,
            category: AgentPublicErrorCategoryV1::Cancelled,
            message: message.to_string(),
            retryable: false,
            suggestion: None,
        };
        self.error = Some(error.clone());
        self.append(
            occurred_at,
            AgentEventTypeV1::RunTerminal,
            &AgentTerminalPayloadV1 {
                state: AgentRunStateV1::Cancelled,
                error: Some(error),
            },
            events,
        )
    }
}

#[derive(Debug, Default)]
struct AgentRunRegistryV1 {
    active_run_id: Option<String>,
    runs: HashMap<String, AgentRunRecordV1>,
    start_requests: HashMap<String, (AgentStartRequestV1, AgentStartResultV1)>,
    actions: HashMap<String, AgentCachedActionV1>,
}

pub(crate) struct AgentManager {
    registry: Mutex<AgentRunRegistryV1>,
    boundary: Arc<dyn AgentControlBoundary>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self::new(Arc::new(BlockedNoopAgentBoundary))
    }
}

impl AgentManager {
    pub(crate) fn new(boundary: Arc<dyn AgentControlBoundary>) -> Self {
        Self {
            registry: Mutex::new(AgentRunRegistryV1::default()),
            boundary,
        }
    }

    pub(crate) fn start(
        &self,
        request: AgentStartRequestV1,
    ) -> Result<AgentManagerOutcome<AgentStartResultV1>, AgentCommandErrorV1> {
        validate_agent_start_request_contract_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let mut registry = self.lock_registry()?;

        if let Some((cached_request, cached_result)) =
            registry.start_requests.get(&request.client_request_id)
        {
            if cached_request == &request {
                return Ok(AgentManagerOutcome::without_events(cached_result.clone()));
            }
            return Err(AgentCommandErrorV1::idempotency_conflict(
                "clientRequestId was already used for a different Agent start request.",
            ));
        }

        if let Some(active_run_id) = registry.active_run_id.as_deref() {
            let active = registry
                .runs
                .get(active_run_id)
                .map(AgentRunRecordV1::active_summary);
            return Err(AgentCommandErrorV1::busy(active));
        }

        let run_id = Uuid::new_v4().to_string();
        // The P1-A boundary is required to be synchronous and non-blocking. It
        // cannot perform provider I/O, tool dispatch, or SSH execution.
        let seed = self.boundary.prepare_run(&request, &run_id)?;
        let budget_policy = resolve_agent_budget_policy_v1(request.requested_budgets.as_ref())
            .map_err(|_| {
                AgentCommandErrorV1::invalid_request("Agent requested budget is invalid.")
            })?;
        let now = now_millis();
        let result = AgentStartResultV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: run_id.clone(),
            accepted_at: now,
        };
        let mut run = AgentRunRecordV1 {
            run_id: run_id.clone(),
            started_at: now,
            state: AgentRunStateV1::Created,
            target: seed.target,
            provider: seed.provider,
            policy: seed.policy,
            budgets: AgentBudgetLedgerV1::new(budget_policy),
            goal: request.goal.clone(),
            plan: Vec::new(),
            steering: VecDeque::new(),
            error: None,
            journal: AgentEventJournalV1::new(run_id.clone()),
        };
        let mut events = Vec::new();
        run.append(
            now,
            AgentEventTypeV1::RunCreated,
            &AgentRunCreatedPayloadV1 {
                state: AgentRunStateV1::Created,
            },
            &mut events,
        )?;
        run.transition(
            AgentRunStateV1::CollectingContext,
            AgentStateChangeReasonV1::StartAccepted,
            now,
            &mut events,
        )?;
        run.transition(
            AgentRunStateV1::Thinking,
            AgentStateChangeReasonV1::ControlBoundaryReady,
            now,
            &mut events,
        )?;

        registry.active_run_id = Some(run_id.clone());
        registry.runs.insert(run_id, run);
        registry
            .start_requests
            .insert(request.client_request_id.clone(), (request, result.clone()));
        Ok(AgentManagerOutcome {
            value: result,
            events,
        })
    }

    pub(crate) fn get_snapshot(
        &self,
        request: AgentGetSnapshotRequestV1,
    ) -> Result<AgentRunSnapshotV1, AgentCommandErrorV1> {
        validate_agent_get_snapshot_request_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let registry = self.lock_registry()?;
        let run_id = request
            .run_id
            .as_deref()
            .or(registry.active_run_id.as_deref())
            .ok_or_else(|| AgentCommandErrorV1::not_found("There is no active Agent run."))?;
        registry
            .runs
            .get(run_id)
            .map(AgentRunRecordV1::snapshot)
            .ok_or_else(|| AgentCommandErrorV1::not_found("The requested Agent run was not found."))
    }

    pub(crate) fn pause(
        &self,
        request: AgentActionRequestV1,
    ) -> Result<AgentManagerOutcome<AgentActionResultV1>, AgentCommandErrorV1> {
        validate_agent_action_request_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let cached_request = AgentCachedActionRequestV1::Pause(request.clone());
        let mut registry = self.lock_registry()?;
        if let Some(cached) = cached_action(&registry, &cached_request)? {
            return Ok(AgentManagerOutcome::without_events(cached));
        }
        let now = now_millis();
        let run = active_run_mut(&mut registry, &request.run_id)?;
        if run.state.is_terminal()
            || matches!(
                run.state,
                AgentRunStateV1::Pausing | AgentRunStateV1::Cancelling | AgentRunStateV1::Paused
            )
        {
            return Err(AgentCommandErrorV1::invalid_state(&run.run_id, run.state));
        }
        let mut events = Vec::new();
        run.transition(
            AgentRunStateV1::Pausing,
            AgentStateChangeReasonV1::PauseRequested,
            now,
            &mut events,
        )?;
        if self.boundary.request_pause(&request.run_id) == AgentBoundaryCompletion::CompleteNow {
            run.transition(
                AgentRunStateV1::Paused,
                AgentStateChangeReasonV1::PauseBoundaryReached,
                now,
                &mut events,
            )?;
        }
        let result = action_result(
            &request,
            AgentActionKindV1::Pause,
            now,
            run.journal.last_sequence(),
        );
        cache_action(&mut registry, cached_request, result.clone());
        Ok(AgentManagerOutcome {
            value: result,
            events,
        })
    }

    pub(crate) fn resume(
        &self,
        request: AgentActionRequestV1,
    ) -> Result<AgentManagerOutcome<AgentActionResultV1>, AgentCommandErrorV1> {
        validate_agent_action_request_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let cached_request = AgentCachedActionRequestV1::Resume(request.clone());
        let mut registry = self.lock_registry()?;
        if let Some(cached) = cached_action(&registry, &cached_request)? {
            return Ok(AgentManagerOutcome::without_events(cached));
        }
        let now = now_millis();
        let run = active_run_mut(&mut registry, &request.run_id)?;
        if run.state != AgentRunStateV1::Paused {
            return Err(AgentCommandErrorV1::invalid_state(&run.run_id, run.state));
        }
        let mut events = Vec::new();
        run.transition(
            AgentRunStateV1::Thinking,
            AgentStateChangeReasonV1::ResumeRequested,
            now,
            &mut events,
        )?;
        self.boundary.request_resume(&request.run_id);
        let result = action_result(
            &request,
            AgentActionKindV1::Resume,
            now,
            run.journal.last_sequence(),
        );
        cache_action(&mut registry, cached_request, result.clone());
        Ok(AgentManagerOutcome {
            value: result,
            events,
        })
    }

    pub(crate) fn stop(
        &self,
        request: AgentActionRequestV1,
    ) -> Result<AgentManagerOutcome<AgentActionResultV1>, AgentCommandErrorV1> {
        validate_agent_action_request_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let cached_request = AgentCachedActionRequestV1::Stop(request.clone());
        let mut registry = self.lock_registry()?;
        if let Some(cached) = cached_action(&registry, &cached_request)? {
            return Ok(AgentManagerOutcome::without_events(cached));
        }
        let now = now_millis();
        let run = active_run_mut(&mut registry, &request.run_id)?;
        if run.state.is_terminal() || run.state == AgentRunStateV1::Cancelling {
            return Err(AgentCommandErrorV1::invalid_state(&run.run_id, run.state));
        }
        let mut events = Vec::new();
        run.transition(
            AgentRunStateV1::Cancelling,
            AgentStateChangeReasonV1::StopRequested,
            now,
            &mut events,
        )?;
        if self.boundary.request_stop(&request.run_id) == AgentBoundaryCompletion::CompleteNow {
            run.complete_cancel(
                AgentStateChangeReasonV1::StopCompleted,
                "The Agent run was cancelled by the user.",
                now,
                &mut events,
            )?;
        }
        let resulting_sequence = run.journal.last_sequence();
        let terminal = run.state.is_terminal();
        let result = action_result(&request, AgentActionKindV1::Stop, now, resulting_sequence);
        if terminal {
            registry.active_run_id = None;
        }
        cache_action(&mut registry, cached_request, result.clone());
        Ok(AgentManagerOutcome {
            value: result,
            events,
        })
    }

    pub(crate) fn send_message(
        &self,
        request: AgentSendMessageRequestV1,
    ) -> Result<AgentManagerOutcome<AgentActionResultV1>, AgentCommandErrorV1> {
        validate_agent_send_message_request_v1(&request)
            .map_err(|error| AgentCommandErrorV1::invalid_request(error.to_string()))?;
        let cached_request = AgentCachedActionRequestV1::SendMessage(request.clone());
        let mut registry = self.lock_registry()?;
        if let Some(cached) = cached_action(&registry, &cached_request)? {
            return Ok(AgentManagerOutcome::without_events(cached));
        }
        let now = now_millis();
        let run = active_run_mut(&mut registry, &request.run_id)?;
        if !matches!(
            run.state,
            AgentRunStateV1::Thinking
                | AgentRunStateV1::ValidatingTool
                | AgentRunStateV1::ExecutingTool
                | AgentRunStateV1::Observing
                | AgentRunStateV1::AwaitingUser
                | AgentRunStateV1::Pausing
                | AgentRunStateV1::Paused
        ) {
            return Err(AgentCommandErrorV1::invalid_state(&run.run_id, run.state));
        }
        run.budgets
            .check_user_message(&request.message)
            .map_err(|_| {
                AgentCommandErrorV1::invalid_request("Agent message exceeds the run budget.")
            })?;
        let next_count = run.steering.len().saturating_add(1);
        run.budgets
            .set_steering_queue_items(next_count.try_into().unwrap_or(u8::MAX))
            .map_err(|_| AgentCommandErrorV1::invalid_state(&run.run_id, run.state))?;
        let message_id = Uuid::new_v4().to_string();
        run.steering.push_back(AgentSteeringMessageV1 {
            _message_id: message_id.clone(),
            _message: request.message.clone(),
        });
        let mut events = Vec::new();
        run.append(
            now,
            AgentEventTypeV1::UserMessageAccepted,
            &AgentMessageAcceptedPayloadV1 {
                message_id,
                kind: if run.state == AgentRunStateV1::AwaitingUser {
                    AgentMessageKindV1::Answer
                } else {
                    AgentMessageKindV1::Steering
                },
            },
            &mut events,
        )?;
        run.append(
            now,
            AgentEventTypeV1::BudgetUpdated,
            &run.budgets.snapshot(),
            &mut events,
        )?;
        if run.state == AgentRunStateV1::AwaitingUser {
            run.transition(
                AgentRunStateV1::Thinking,
                AgentStateChangeReasonV1::UserAnswerAccepted,
                now,
                &mut events,
            )?;
        }
        self.boundary
            .accept_message(&request.run_id, &request.message);
        let result = AgentActionResultV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: request.run_id.clone(),
            client_action_id: request.client_action_id.clone(),
            action: AgentActionKindV1::SendMessage,
            accepted_at: now,
            resulting_sequence: run.journal.last_sequence(),
        };
        cache_action(&mut registry, cached_request, result.clone());
        Ok(AgentManagerOutcome {
            value: result,
            events,
        })
    }

    pub(crate) fn settle_pause(
        &self,
        run_id: &str,
    ) -> Result<AgentManagerOutcome<bool>, AgentCommandErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run) = registry.runs.get_mut(run_id) else {
            return Ok(AgentManagerOutcome::without_events(false));
        };
        if run.state != AgentRunStateV1::Pausing {
            return Ok(AgentManagerOutcome::without_events(false));
        }
        let mut events = Vec::new();
        run.transition(
            AgentRunStateV1::Paused,
            AgentStateChangeReasonV1::PauseBoundaryReached,
            now_millis(),
            &mut events,
        )?;
        Ok(AgentManagerOutcome {
            value: true,
            events,
        })
    }

    pub(crate) fn settle_stop(
        &self,
        run_id: &str,
    ) -> Result<AgentManagerOutcome<bool>, AgentCommandErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run) = registry.runs.get_mut(run_id) else {
            return Ok(AgentManagerOutcome::without_events(false));
        };
        if run.state != AgentRunStateV1::Cancelling {
            return Ok(AgentManagerOutcome::without_events(false));
        }
        let mut events = Vec::new();
        run.complete_cancel(
            AgentStateChangeReasonV1::StopCompleted,
            "The Agent run was cancelled by the user.",
            now_millis(),
            &mut events,
        )?;
        registry.active_run_id = None;
        Ok(AgentManagerOutcome {
            value: true,
            events,
        })
    }

    pub(crate) fn cancel_active_for_app_exit(
        &self,
    ) -> Result<AgentManagerOutcome<Option<AgentRunSnapshotV1>>, AgentCommandErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run_id) = registry.active_run_id.clone() else {
            return Ok(AgentManagerOutcome::without_events(None));
        };
        let run = registry.runs.get_mut(&run_id).ok_or_else(|| {
            AgentCommandErrorV1::internal("The active Agent registry entry is missing.")
        })?;
        let now = now_millis();
        let mut events = Vec::new();
        if run.state != AgentRunStateV1::Cancelling {
            run.transition(
                AgentRunStateV1::Cancelling,
                AgentStateChangeReasonV1::ApplicationExit,
                now,
                &mut events,
            )?;
        }
        let _ = self.boundary.request_stop(&run_id);
        // P1-A has no provider or tool operation to await. The control plane
        // records the authoritative terminal before the process exits.
        run.complete_cancel(
            AgentStateChangeReasonV1::ApplicationExit,
            "The Agent run was cancelled because the application exited.",
            now,
            &mut events,
        )?;
        let snapshot = run.snapshot();
        registry.active_run_id = None;
        Ok(AgentManagerOutcome {
            value: Some(snapshot),
            events,
        })
    }

    #[cfg(test)]
    fn journal_events(
        &self,
        run_id: &str,
        after_sequence: u64,
    ) -> Result<Vec<AgentEventV1>, AgentCommandErrorV1> {
        let registry = self.lock_registry()?;
        let run = registry.runs.get(run_id).ok_or_else(|| {
            AgentCommandErrorV1::not_found("The requested Agent run was not found.")
        })?;
        Ok(run.journal.events_after(after_sequence))
    }

    fn lock_registry(&self) -> Result<MutexGuard<'_, AgentRunRegistryV1>, AgentCommandErrorV1> {
        self.registry
            .lock()
            .map_err(|_| AgentCommandErrorV1::internal("The Agent registry lock is unavailable."))
    }
}

fn cached_action(
    registry: &AgentRunRegistryV1,
    request: &AgentCachedActionRequestV1,
) -> Result<Option<AgentActionResultV1>, AgentCommandErrorV1> {
    let Some(cached) = registry.actions.get(request.client_action_id()) else {
        return Ok(None);
    };
    if cached.request == *request {
        Ok(Some(cached.result.clone()))
    } else {
        Err(AgentCommandErrorV1::idempotency_conflict(
            "clientActionId was already used for a different Agent action.",
        ))
    }
}

fn cache_action(
    registry: &mut AgentRunRegistryV1,
    request: AgentCachedActionRequestV1,
    result: AgentActionResultV1,
) {
    registry.actions.insert(
        request.client_action_id().to_string(),
        AgentCachedActionV1 { request, result },
    );
}

fn active_run_mut<'a>(
    registry: &'a mut AgentRunRegistryV1,
    run_id: &str,
) -> Result<&'a mut AgentRunRecordV1, AgentCommandErrorV1> {
    if registry.active_run_id.as_deref() != Some(run_id) {
        if let Some(run) = registry.runs.get(run_id) {
            return Err(AgentCommandErrorV1::invalid_state(run_id, run.state));
        }
        return Err(AgentCommandErrorV1::not_found(
            "The requested Agent run was not found.",
        ));
    }
    registry
        .runs
        .get_mut(run_id)
        .ok_or_else(|| AgentCommandErrorV1::internal("The active Agent registry entry is missing."))
}

fn action_result(
    request: &AgentActionRequestV1,
    action: AgentActionKindV1,
    accepted_at: u64,
    resulting_sequence: u64,
) -> AgentActionResultV1 {
    AgentActionResultV1 {
        schema_version: AgentSchemaVersionV1,
        run_id: request.run_id.clone(),
        client_action_id: request.client_action_id.clone(),
        action,
        accepted_at,
        resulting_sequence,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

impl AgentCommandErrorV1 {
    fn new(category: AgentCommandErrorCategoryV1, message: impl Into<String>) -> Self {
        Self {
            schema_version: AgentSchemaVersionV1,
            category,
            message: message.into(),
            active_run: None,
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(AgentCommandErrorCategoryV1::InvalidRequest, message)
    }

    fn busy(active_run: Option<AgentActiveRunSummaryV1>) -> Self {
        Self {
            schema_version: AgentSchemaVersionV1,
            category: AgentCommandErrorCategoryV1::AgentBusy,
            message: "Another Agent run is still active.".to_string(),
            active_run,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(AgentCommandErrorCategoryV1::RunNotFound, message)
    }

    fn idempotency_conflict(message: impl Into<String>) -> Self {
        Self::new(AgentCommandErrorCategoryV1::IdempotencyConflict, message)
    }

    fn invalid_state(run_id: &str, state: AgentRunStateV1) -> Self {
        Self::new(
            AgentCommandErrorCategoryV1::InvalidState,
            format!("Agent run {run_id} cannot accept this action while it is {state:?}."),
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(AgentCommandErrorCategoryV1::Internal, message)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum AgentStateChangeReasonV1 {
    StartAccepted,
    ControlBoundaryReady,
    PauseRequested,
    PauseBoundaryReached,
    ResumeRequested,
    StopRequested,
    StopCompleted,
    UserAnswerAccepted,
    ApplicationExit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRunCreatedPayloadV1 {
    state: AgentRunStateV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentStateChangedPayloadV1 {
    previous_state: AgentRunStateV1,
    state: AgentRunStateV1,
    reason: AgentStateChangeReasonV1,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum AgentMessageKindV1 {
    Answer,
    Steering,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentMessageAcceptedPayloadV1 {
    message_id: String,
    kind: AgentMessageKindV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentTerminalPayloadV1 {
    state: AgentRunStateV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AgentPublicErrorV1>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::protocol::{
        AgentPolicyModeV1, AgentProviderCapabilitiesV1, AgentProviderKindV1,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeBoundary {
        pause_completion: AgentBoundaryCompletion,
        stop_completion: AgentBoundaryCompletion,
        stop_requests: AtomicUsize,
    }

    impl FakeBoundary {
        fn immediate() -> Arc<Self> {
            Arc::new(Self {
                pause_completion: AgentBoundaryCompletion::CompleteNow,
                stop_completion: AgentBoundaryCompletion::CompleteNow,
                stop_requests: AtomicUsize::new(0),
            })
        }

        fn delayed() -> Arc<Self> {
            Arc::new(Self {
                pause_completion: AgentBoundaryCompletion::AwaitBoundary,
                stop_completion: AgentBoundaryCompletion::AwaitBoundary,
                stop_requests: AtomicUsize::new(0),
            })
        }
    }

    impl AgentControlBoundary for FakeBoundary {
        fn prepare_run(
            &self,
            request: &AgentStartRequestV1,
            run_id: &str,
        ) -> Result<AgentRunSeedV1, AgentCommandErrorV1> {
            Ok(AgentRunSeedV1 {
                target: AgentTargetBindingV1 {
                    profile_id: request.profile_id.clone(),
                    profile_label: "Fixture host".to_string(),
                    host: "fixture.invalid".to_string(),
                    port: 22,
                    username: "fixture".to_string(),
                    auth_method: "fixture".to_string(),
                    jump_host: None,
                    target_digest: format!("fixture-{run_id}"),
                },
                provider: AgentProviderBindingV1 {
                    provider_id: request.provider_id.clone(),
                    kind: AgentProviderKindV1::OpenAiCompatible,
                    base_url: "https://fixture.invalid".to_string(),
                    model: "fake".to_string(),
                    capabilities: AgentProviderCapabilitiesV1 {
                        streaming: false,
                        strict_json_schema: true,
                        native_tool_calling: false,
                        usage_reporting: false,
                        response_continuation: false,
                    },
                },
                policy: AgentPolicySnapshotV1 {
                    mode: AgentPolicyModeV1::ReadOnly,
                    policy_version: "p1-a-fixture".to_string(),
                    tool_registry_version: "none".to_string(),
                    allowed_tools: Vec::new(),
                },
            })
        }

        fn request_pause(&self, _run_id: &str) -> AgentBoundaryCompletion {
            self.pause_completion
        }

        fn request_stop(&self, _run_id: &str) -> AgentBoundaryCompletion {
            self.stop_requests.fetch_add(1, Ordering::SeqCst);
            self.stop_completion
        }
    }

    fn start_request(client_request_id: &str) -> AgentStartRequestV1 {
        AgentStartRequestV1 {
            schema_version: AgentSchemaVersionV1,
            client_request_id: client_request_id.to_string(),
            goal: "Inspect the fixture without making changes.".to_string(),
            profile_id: "profile-1".to_string(),
            provider_id: "provider-1".to_string(),
            terminal_context: None,
            requested_budgets: None,
        }
    }

    fn action(run_id: &str, client_action_id: &str) -> AgentActionRequestV1 {
        AgentActionRequestV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: run_id.to_string(),
            client_action_id: client_action_id.to_string(),
        }
    }

    fn active_snapshot(manager: &AgentManager) -> AgentRunSnapshotV1 {
        manager
            .get_snapshot(AgentGetSnapshotRequestV1 {
                schema_version: AgentSchemaVersionV1,
                run_id: None,
            })
            .expect("active snapshot")
    }

    #[test]
    fn global_registry_and_start_request_are_authoritative_and_idempotent() {
        let manager = AgentManager::new(FakeBoundary::immediate());
        let request = start_request("request-1");
        let first = manager.start(request.clone()).expect("start run");
        assert_eq!(first.events.len(), 3);
        assert_eq!(active_snapshot(&manager).state, AgentRunStateV1::Thinking);

        let duplicate = manager.start(request.clone()).expect("deduplicate start");
        assert_eq!(duplicate.value, first.value);
        assert!(duplicate.events.is_empty());

        let mut conflicting = request;
        conflicting.goal = "A different goal".to_string();
        assert_eq!(
            manager
                .start(conflicting)
                .expect_err("conflicting request ID")
                .category,
            AgentCommandErrorCategoryV1::IdempotencyConflict
        );

        let busy = manager
            .start(start_request("request-2"))
            .expect_err("only one non-terminal run is allowed");
        assert_eq!(busy.category, AgentCommandErrorCategoryV1::AgentBusy);
        assert_eq!(
            busy.active_run.expect("active summary").run_id,
            first.value.run_id
        );
    }

    #[test]
    fn panel_remount_recovers_from_snapshot_and_actions_are_idempotent() {
        let manager = AgentManager::new(FakeBoundary::immediate());
        let started = manager
            .start(start_request("request-remount"))
            .expect("start");
        let run_id = started.value.run_id;
        let mounted = active_snapshot(&manager);

        let pause_request = action(&run_id, "action-pause");
        let paused = manager.pause(pause_request.clone()).expect("pause");
        assert_eq!(active_snapshot(&manager).state, AgentRunStateV1::Paused);
        let duplicate = manager.pause(pause_request).expect("deduplicate pause");
        assert_eq!(duplicate.value, paused.value);
        assert!(duplicate.events.is_empty());

        let remounted = manager
            .get_snapshot(AgentGetSnapshotRequestV1 {
                schema_version: AgentSchemaVersionV1,
                run_id: Some(run_id.clone()),
            })
            .expect("remounted panel snapshot");
        assert_eq!(remounted.run_id, mounted.run_id);
        assert!(remounted.last_sequence > mounted.last_sequence);
        assert_eq!(remounted.state, AgentRunStateV1::Paused);

        manager
            .resume(action(&run_id, "action-resume"))
            .expect("resume");
        let message = AgentSendMessageRequestV1 {
            schema_version: AgentSchemaVersionV1,
            run_id: run_id.clone(),
            client_action_id: "action-message".to_string(),
            message: "Only inspect bounded service status.".to_string(),
        };
        let accepted = manager.send_message(message.clone()).expect("message");
        let message_duplicate = manager.send_message(message).expect("deduplicate message");
        assert_eq!(message_duplicate.value, accepted.value);
        assert!(message_duplicate.events.is_empty());
        assert_eq!(active_snapshot(&manager).queued_steering_count, 1);
    }

    #[test]
    fn gap_duplicate_and_late_sources_do_not_corrupt_the_journal() {
        let boundary = FakeBoundary::delayed();
        let manager = AgentManager::new(boundary);
        let started = manager.start(start_request("request-late")).expect("start");
        let run_id = started.value.run_id;

        let pause = manager
            .pause(action(&run_id, "action-pause-late"))
            .expect("request pause");
        assert_eq!(active_snapshot(&manager).state, AgentRunStateV1::Pausing);
        assert!(manager.settle_pause(&run_id).expect("settle pause").value);
        assert!(
            !manager
                .settle_pause(&run_id)
                .expect("duplicate settle")
                .value
        );
        manager
            .resume(action(&run_id, "action-resume-late"))
            .expect("resume");
        manager
            .stop(action(&run_id, "action-stop-late"))
            .expect("request stop");
        assert!(manager.settle_stop(&run_id).expect("settle stop").value);
        let terminal = manager
            .get_snapshot(AgentGetSnapshotRequestV1 {
                schema_version: AgentSchemaVersionV1,
                run_id: Some(run_id.clone()),
            })
            .expect("terminal snapshot");
        assert_eq!(terminal.state, AgentRunStateV1::Cancelled);
        assert!(
            !manager
                .settle_pause(&run_id)
                .expect("late pause settle")
                .value
        );
        assert!(
            !manager
                .settle_stop(&run_id)
                .expect("late stop settle")
                .value
        );
        assert_eq!(
            manager
                .journal_events(&run_id, 0)
                .expect("journal")
                .last()
                .map(|event| event.sequence),
            Some(terminal.last_sequence)
        );
        assert!(pause.value.resulting_sequence < terminal.last_sequence);

        manager
            .start(start_request("request-after-terminal"))
            .expect("new run after terminal");
    }

    #[test]
    fn application_exit_cancels_the_active_run_before_shutdown() {
        let boundary = FakeBoundary::delayed();
        let manager = AgentManager::new(boundary.clone());
        let run_id = manager
            .start(start_request("request-exit"))
            .expect("start")
            .value
            .run_id;
        let cancelled = manager
            .cancel_active_for_app_exit()
            .expect("cancel on exit");
        let snapshot = cancelled.value.expect("cancelled snapshot");
        assert_eq!(snapshot.run_id, run_id);
        assert_eq!(snapshot.state, AgentRunStateV1::Cancelled);
        assert_eq!(
            snapshot.error.expect("exit error").message,
            "The Agent run was cancelled because the application exited."
        );
        assert_eq!(boundary.stop_requests.load(Ordering::SeqCst), 1);
        assert!(manager
            .cancel_active_for_app_exit()
            .expect("idempotent exit")
            .value
            .is_none());
    }

    #[test]
    fn production_noop_boundary_keeps_p1_blocked_without_creating_a_run() {
        let manager = AgentManager::default();
        let error = manager
            .start(start_request("request-blocked"))
            .expect_err("P1 must remain blocked");
        assert_eq!(error.category, AgentCommandErrorCategoryV1::P1Blocked);
        assert_eq!(
            manager
                .get_snapshot(AgentGetSnapshotRequestV1 {
                    schema_version: AgentSchemaVersionV1,
                    run_id: None,
                })
                .expect_err("no run was created")
                .category,
            AgentCommandErrorCategoryV1::RunNotFound
        );
    }

    #[test]
    fn action_id_reuse_with_different_intent_fails_closed() {
        let manager = AgentManager::new(FakeBoundary::immediate());
        let run_id = manager
            .start(start_request("request-actions"))
            .expect("start")
            .value
            .run_id;
        manager
            .pause(action(&run_id, "shared-action-id"))
            .expect("pause");
        assert_eq!(
            manager
                .resume(action(&run_id, "shared-action-id"))
                .expect_err("action ID conflict")
                .category,
            AgentCommandErrorCategoryV1::IdempotencyConflict
        );
    }
}
