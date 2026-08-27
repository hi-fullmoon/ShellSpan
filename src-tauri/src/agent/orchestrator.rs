use super::budgets::{AgentBudgetLedgerV1, AgentBudgetPolicyV1, AgentBudgetSnapshotV1};
use super::context::{
    AgentContextBuilderV1, AgentContextObservationStatusV1, AgentContextObservationV1,
    AgentDynamicContextV1, AgentStableContextV1,
};
use super::model::{
    AgentDecisionModelV1, AgentModelErrorKindV1, AgentModelErrorV1, AgentModelRequestV1,
};
use super::protocol::{
    AgentDecisionV1, AgentFinalReportV1, AgentPlanItemV1, AgentPublicErrorCategoryV1,
    AgentPublicErrorV1, AgentSchemaVersionV1, HostInspectArgsV1, ShellExecReadOnlyArgsV1,
};
use super::state::AgentRunStateV1;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentToolInputV1 {
    HostInspect(HostInspectArgsV1),
    ShellExecReadOnly(ShellExecReadOnlyArgsV1),
}

impl AgentToolInputV1 {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::HostInspect(_) => "host.inspect",
            Self::ShellExecReadOnly(_) => "shell.execReadOnly",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentToolRequestV1 {
    pub(crate) tool_call_id: String,
    pub(crate) input: AgentToolInputV1,
    pub(crate) rationale: String,
    pub(crate) purpose: String,
    pub(crate) success_criteria: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentToolDeniedV1 {
    pub(crate) reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentToolValidationV1 {
    Ready,
    Denied(AgentToolDeniedV1),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentToolOutputStatusV1 {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentToolOutputV1 {
    pub(crate) status: AgentToolOutputStatusV1,
    pub(crate) summary: String,
    pub(crate) stdout_excerpt: String,
    pub(crate) stderr_excerpt: String,
}

pub(crate) type AgentToolFutureV1<'a> =
    Pin<Box<dyn Future<Output = AgentToolOutputV1> + Send + 'a>>;

/// P1-B deliberately defines only a fakeable validation/execution seam. There
/// is no production registry, allowlist, renderer, evidence ledger, redactor,
/// SSH adapter, or Tauri dispatch behind this trait; those remain P1-C/P1-D.
pub(crate) trait AgentToolDriverV1: Send + Sync {
    fn validate(&self, request: &AgentToolRequestV1) -> AgentToolValidationV1;

    fn execute<'a>(
        &'a self,
        request: AgentToolRequestV1,
        cancellation: CancellationToken,
    ) -> AgentToolFutureV1<'a>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentToolCallRecordStatusV1 {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentToolCallRecordV1 {
    pub(crate) request: AgentToolRequestV1,
    pub(crate) status: AgentToolCallRecordStatusV1,
    pub(crate) observation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentOrchestratorConfigV1 {
    pub(crate) run_id: String,
    pub(crate) stable_context: AgentStableContextV1,
    pub(crate) budget_policy: AgentBudgetPolicyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentOrchestratorStepV1 {
    DecisionApplied,
    AwaitingUser,
    Paused,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentOrchestratorSnapshotV1 {
    pub(crate) state: AgentRunStateV1,
    pub(crate) budgets: AgentBudgetSnapshotV1,
    pub(crate) plan: Vec<AgentPlanItemV1>,
    pub(crate) tool_calls: Vec<AgentToolCallRecordV1>,
    pub(crate) observations: Vec<AgentContextObservationV1>,
    pub(crate) pending_question: Option<String>,
    pub(crate) report: Option<AgentFinalReportV1>,
    pub(crate) error: Option<AgentPublicErrorV1>,
    pub(crate) discarded_model_decisions: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentControlErrorV1 {
    QueueFull,
    MessageTooLarge,
    Stopped,
    LockUnavailable,
}

#[derive(Debug, Default)]
struct AgentControlStateV1 {
    revision: u64,
    next_request_id: u64,
    steering: VecDeque<String>,
    pause_requested: bool,
    stop_requested: bool,
    active_model: Option<(u64, CancellationToken)>,
    active_tool: Option<(u64, CancellationToken)>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRunControlV1 {
    state: Arc<Mutex<AgentControlStateV1>>,
    max_steering_items: u8,
    max_message_bytes: u32,
}

#[derive(Debug)]
struct AgentControlLeaseV1 {
    request_id: u64,
    revision: u64,
    cancellation: CancellationToken,
}

#[derive(Debug, Clone, Copy)]
struct AgentControlSnapshotV1 {
    revision: u64,
    pause_requested: bool,
    stop_requested: bool,
}

impl AgentRunControlV1 {
    fn new(policy: AgentBudgetPolicyV1) -> Self {
        Self {
            state: Arc::new(Mutex::new(AgentControlStateV1::default())),
            max_steering_items: policy.max_steering_queue_items,
            max_message_bytes: policy.max_user_message_bytes,
        }
    }

    pub(crate) fn steer(&self, message: impl Into<String>) -> Result<(), AgentControlErrorV1> {
        let message = message.into();
        if message.trim().is_empty() || message.len() > self.max_message_bytes as usize {
            return Err(AgentControlErrorV1::MessageTooLarge);
        }
        let mut state = self.lock()?;
        if state.stop_requested {
            return Err(AgentControlErrorV1::Stopped);
        }
        if state.steering.len() >= self.max_steering_items as usize {
            return Err(AgentControlErrorV1::QueueFull);
        }
        state.steering.push_back(message);
        state.revision = state.revision.saturating_add(1);
        if let Some((_, cancellation)) = &state.active_model {
            cancellation.cancel();
        }
        Ok(())
    }

    pub(crate) fn pause(&self) -> Result<(), AgentControlErrorV1> {
        let mut state = self.lock()?;
        if state.stop_requested {
            return Err(AgentControlErrorV1::Stopped);
        }
        state.pause_requested = true;
        if let Some((_, cancellation)) = &state.active_model {
            cancellation.cancel();
        }
        Ok(())
    }

    pub(crate) fn resume(&self) -> Result<(), AgentControlErrorV1> {
        let mut state = self.lock()?;
        if state.stop_requested {
            return Err(AgentControlErrorV1::Stopped);
        }
        state.pause_requested = false;
        Ok(())
    }

    pub(crate) fn stop(&self) -> Result<(), AgentControlErrorV1> {
        let mut state = self.lock()?;
        state.stop_requested = true;
        state.pause_requested = false;
        if let Some((_, cancellation)) = &state.active_model {
            cancellation.cancel();
        }
        if let Some((_, cancellation)) = &state.active_tool {
            cancellation.cancel();
        }
        Ok(())
    }

    fn begin_model(&self) -> Result<AgentControlLeaseV1, AgentControlErrorV1> {
        let mut state = self.lock()?;
        state.next_request_id = state.next_request_id.saturating_add(1);
        let request_id = state.next_request_id;
        let cancellation = CancellationToken::new();
        state.active_model = Some((request_id, cancellation.clone()));
        Ok(AgentControlLeaseV1 {
            request_id,
            revision: state.revision,
            cancellation,
        })
    }

    fn finish_model(&self, request_id: u64) -> Result<AgentControlSnapshotV1, AgentControlErrorV1> {
        let mut state = self.lock()?;
        if state.active_model.as_ref().map(|active| active.0) == Some(request_id) {
            state.active_model = None;
        }
        Ok(snapshot_control_v1(&state))
    }

    fn begin_tool(&self) -> Result<AgentControlLeaseV1, AgentControlErrorV1> {
        let mut state = self.lock()?;
        state.next_request_id = state.next_request_id.saturating_add(1);
        let request_id = state.next_request_id;
        let cancellation = CancellationToken::new();
        state.active_tool = Some((request_id, cancellation.clone()));
        Ok(AgentControlLeaseV1 {
            request_id,
            revision: state.revision,
            cancellation,
        })
    }

    fn finish_tool(&self, request_id: u64) -> Result<AgentControlSnapshotV1, AgentControlErrorV1> {
        let mut state = self.lock()?;
        if state.active_tool.as_ref().map(|active| active.0) == Some(request_id) {
            state.active_tool = None;
        }
        Ok(snapshot_control_v1(&state))
    }

    fn snapshot(&self) -> Result<AgentControlSnapshotV1, AgentControlErrorV1> {
        self.lock().map(|state| snapshot_control_v1(&state))
    }

    fn drain_steering(&self) -> Result<Vec<String>, AgentControlErrorV1> {
        let mut state = self.lock()?;
        Ok(state.steering.drain(..).collect())
    }

    fn lock(&self) -> Result<MutexGuard<'_, AgentControlStateV1>, AgentControlErrorV1> {
        self.state
            .lock()
            .map_err(|_| AgentControlErrorV1::LockUnavailable)
    }
}

fn snapshot_control_v1(state: &AgentControlStateV1) -> AgentControlSnapshotV1 {
    AgentControlSnapshotV1 {
        revision: state.revision,
        pause_requested: state.pause_requested,
        stop_requested: state.stop_requested,
    }
}

pub(crate) struct AgentOrchestratorV1<M, T>
where
    M: AgentDecisionModelV1,
    T: AgentToolDriverV1,
{
    config: AgentOrchestratorConfigV1,
    model: M,
    tools: T,
    context_builder: AgentContextBuilderV1,
    control: AgentRunControlV1,
    started_at: Instant,
    state: AgentRunStateV1,
    budgets: AgentBudgetLedgerV1,
    dynamic_context: AgentDynamicContextV1,
    tool_calls: Vec<AgentToolCallRecordV1>,
    report: Option<AgentFinalReportV1>,
    error: Option<AgentPublicErrorV1>,
    discarded_model_decisions: u16,
}

impl<M, T> AgentOrchestratorV1<M, T>
where
    M: AgentDecisionModelV1,
    T: AgentToolDriverV1,
{
    pub(crate) fn new(config: AgentOrchestratorConfigV1, model: M, tools: T) -> Self {
        let control = AgentRunControlV1::new(config.budget_policy);
        let budgets = AgentBudgetLedgerV1::new(config.budget_policy);
        Self {
            config,
            model,
            tools,
            context_builder: AgentContextBuilderV1,
            control,
            started_at: Instant::now(),
            state: AgentRunStateV1::Thinking,
            budgets,
            dynamic_context: AgentDynamicContextV1::default(),
            tool_calls: Vec::new(),
            report: None,
            error: None,
            discarded_model_decisions: 0,
        }
    }

    pub(crate) fn control(&self) -> AgentRunControlV1 {
        self.control.clone()
    }

    pub(crate) fn snapshot(&self) -> AgentOrchestratorSnapshotV1 {
        AgentOrchestratorSnapshotV1 {
            state: self.state,
            budgets: self.budgets.snapshot(),
            plan: self.dynamic_context.plan.clone(),
            tool_calls: self.tool_calls.clone(),
            observations: self.dynamic_context.observations.clone(),
            pending_question: self.dynamic_context.pending_question.clone(),
            report: self.report.clone(),
            error: self.error.clone(),
            discarded_model_decisions: self.discarded_model_decisions,
        }
    }

    pub(crate) fn resume(&mut self) -> Result<(), AgentControlErrorV1> {
        if self.state != AgentRunStateV1::Paused {
            return Err(AgentControlErrorV1::Stopped);
        }
        self.control.resume()?;
        self.transition_v1(AgentRunStateV1::Thinking);
        Ok(())
    }

    pub(crate) fn send_message(
        &mut self,
        message: impl Into<String>,
    ) -> Result<(), AgentControlErrorV1> {
        self.control.steer(message)?;
        if self.state == AgentRunStateV1::AwaitingUser {
            self.dynamic_context.pending_question = None;
            self.transition_v1(AgentRunStateV1::Thinking);
        }
        Ok(())
    }

    pub(crate) async fn run_to_boundary(&mut self) -> AgentOrchestratorSnapshotV1 {
        while !self.state.is_terminal()
            && !matches!(
                self.state,
                AgentRunStateV1::Paused | AgentRunStateV1::AwaitingUser
            )
        {
            self.run_single_decision().await;
        }
        self.snapshot()
    }

    pub(crate) async fn run_single_decision(&mut self) -> AgentOrchestratorStepV1 {
        if self.state.is_terminal() {
            return AgentOrchestratorStepV1::Terminal;
        }
        if self.state == AgentRunStateV1::Paused {
            return AgentOrchestratorStepV1::Paused;
        }
        if self.state == AgentRunStateV1::AwaitingUser {
            return AgentOrchestratorStepV1::AwaitingUser;
        }
        if self.state != AgentRunStateV1::Thinking {
            self.fail_v1(
                AgentPublicErrorCategoryV1::Internal,
                "The Agent orchestrator entered an invalid decision boundary.",
            );
            return AgentOrchestratorStepV1::Terminal;
        }

        let mut repair = false;
        loop {
            if self.apply_control_boundary_v1() {
                return self.current_boundary_v1();
            }
            self.consume_steering_v1();
            if self.state.is_terminal() {
                return AgentOrchestratorStepV1::Terminal;
            }
            if self
                .budgets
                .check_elapsed(self.started_at.elapsed().as_millis() as u64)
                .is_err()
                || self.budgets.consume_model_turn().is_err()
            {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::BudgetExceeded,
                    "The Agent model-turn or run-time budget is exhausted.",
                );
                return AgentOrchestratorStepV1::Terminal;
            }
            let context = self.context_builder.build(
                &self.config.stable_context,
                &self.dynamic_context,
                &self.budgets.snapshot(),
            );
            let lease = match self.control.begin_model() {
                Ok(lease) => lease,
                Err(_) => {
                    self.fail_v1(
                        AgentPublicErrorCategoryV1::Internal,
                        "The Agent control boundary is unavailable.",
                    );
                    return AgentOrchestratorStepV1::Terminal;
                }
            };
            let result = self
                .model
                .request_decision(AgentModelRequestV1 { context, repair }, lease.cancellation)
                .await;
            let controls = match self.control.finish_model(lease.request_id) {
                Ok(controls) => controls,
                Err(_) => {
                    self.fail_v1(
                        AgentPublicErrorCategoryV1::Internal,
                        "The Agent control boundary is unavailable.",
                    );
                    return AgentOrchestratorStepV1::Terminal;
                }
            };

            if controls.stop_requested {
                self.cancel_v1("The Agent run was stopped during model decision.");
                return AgentOrchestratorStepV1::Terminal;
            }
            if controls.pause_requested {
                self.pause_now_v1();
                return AgentOrchestratorStepV1::Paused;
            }
            if controls.revision != lease.revision {
                self.discarded_model_decisions = self.discarded_model_decisions.saturating_add(1);
                repair = false;
                continue;
            }

            match result {
                Ok(result) => {
                    self.budgets.record_valid_decision();
                    return self.apply_decision_v1(result.decision).await;
                }
                Err(error) if error.kind == AgentModelErrorKindV1::InvalidDecision => {
                    let invalid_limit = self.budgets.record_invalid_decision().is_err();
                    if repair || invalid_limit {
                        self.fail_v1(
                            AgentPublicErrorCategoryV1::ProviderProtocol,
                            "The Agent provider returned two consecutive invalid decisions.",
                        );
                        return AgentOrchestratorStepV1::Terminal;
                    }
                    repair = true;
                }
                Err(error) => {
                    self.fail_model_error_v1(error);
                    return AgentOrchestratorStepV1::Terminal;
                }
            }
        }
    }

    async fn apply_decision_v1(&mut self, decision: AgentDecisionV1) -> AgentOrchestratorStepV1 {
        let plan = match &decision {
            AgentDecisionV1::HostInspect(value) => &value.plan,
            AgentDecisionV1::ShellExecReadOnly(value) => &value.plan,
            AgentDecisionV1::AskUser(value) => &value.plan,
            AgentDecisionV1::Final(value) => &value.plan,
        };
        if self.budgets.check_plan_items(plan.items.len()).is_err() {
            self.fail_v1(
                AgentPublicErrorCategoryV1::BudgetExceeded,
                "The Agent plan exceeds the frozen run budget.",
            );
            return AgentOrchestratorStepV1::Terminal;
        }
        self.dynamic_context.plan = plan.items.clone();

        match decision {
            AgentDecisionV1::AskUser(value) => {
                self.dynamic_context.pending_question = Some(value.question);
                self.transition_v1(AgentRunStateV1::AwaitingUser);
                AgentOrchestratorStepV1::AwaitingUser
            }
            AgentDecisionV1::Final(value) => {
                self.report = Some(value.report);
                self.transition_v1(AgentRunStateV1::Completed);
                AgentOrchestratorStepV1::Terminal
            }
            AgentDecisionV1::HostInspect(value) => {
                let request = AgentToolRequestV1 {
                    tool_call_id: self.next_tool_call_id_v1(),
                    input: AgentToolInputV1::HostInspect(value.arguments),
                    rationale: value.rationale,
                    purpose: value.purpose,
                    success_criteria: value.success_criteria,
                };
                self.apply_tool_call_v1(request).await
            }
            AgentDecisionV1::ShellExecReadOnly(value) => {
                let request = AgentToolRequestV1 {
                    tool_call_id: self.next_tool_call_id_v1(),
                    input: AgentToolInputV1::ShellExecReadOnly(value.arguments),
                    rationale: value.rationale,
                    purpose: value.purpose,
                    success_criteria: value.success_criteria,
                };
                self.apply_tool_call_v1(request).await
            }
        }
    }

    async fn apply_tool_call_v1(&mut self, request: AgentToolRequestV1) -> AgentOrchestratorStepV1 {
        if self.budgets.consume_tool_call().is_err() {
            self.fail_v1(
                AgentPublicErrorCategoryV1::BudgetExceeded,
                "The Agent tool proposal budget is exhausted.",
            );
            return AgentOrchestratorStepV1::Terminal;
        }
        self.transition_v1(AgentRunStateV1::ValidatingTool);
        if self.state.is_terminal() {
            return AgentOrchestratorStepV1::Terminal;
        }

        match self.tools.validate(&request) {
            AgentToolValidationV1::Denied(denial) => {
                let observation_id = self.next_observation_id_v1();
                self.dynamic_context.recent_tool_error = Some(denial.reason.clone());
                self.dynamic_context
                    .observations
                    .push(AgentContextObservationV1 {
                        observation_id: observation_id.clone(),
                        tool_call_id: request.tool_call_id.clone(),
                        tool: request.input.name().to_string(),
                        status: AgentContextObservationStatusV1::Denied,
                        summary: denial.reason,
                        output_excerpt: String::new(),
                    });
                self.tool_calls.push(AgentToolCallRecordV1 {
                    request,
                    status: AgentToolCallRecordStatusV1::Denied,
                    observation_id: Some(observation_id),
                });
                self.transition_v1(AgentRunStateV1::Thinking);
                return AgentOrchestratorStepV1::DecisionApplied;
            }
            AgentToolValidationV1::Ready => {}
        }

        let controls = match self.control.snapshot() {
            Ok(controls) => controls,
            Err(_) => {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent control boundary is unavailable.",
                );
                return AgentOrchestratorStepV1::Terminal;
            }
        };
        if controls.stop_requested {
            self.tool_calls.push(AgentToolCallRecordV1 {
                request,
                status: AgentToolCallRecordStatusV1::Cancelled,
                observation_id: None,
            });
            self.cancel_v1("The Agent run was stopped before tool execution.");
            return AgentOrchestratorStepV1::Terminal;
        }
        if controls.pause_requested {
            self.tool_calls.push(AgentToolCallRecordV1 {
                request,
                status: AgentToolCallRecordStatusV1::Cancelled,
                observation_id: None,
            });
            self.pause_now_v1();
            return AgentOrchestratorStepV1::Paused;
        }

        self.transition_v1(AgentRunStateV1::ExecutingTool);
        let lease = match self.control.begin_tool() {
            Ok(lease) => lease,
            Err(_) => {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent tool control boundary is unavailable.",
                );
                return AgentOrchestratorStepV1::Terminal;
            }
        };
        let output = self
            .tools
            .execute(request.clone(), lease.cancellation)
            .await;
        let controls = match self.control.finish_tool(lease.request_id) {
            Ok(controls) => controls,
            Err(_) => {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent tool control boundary is unavailable.",
                );
                return AgentOrchestratorStepV1::Terminal;
            }
        };
        if controls.stop_requested {
            self.tool_calls.push(AgentToolCallRecordV1 {
                request,
                status: AgentToolCallRecordStatusV1::Cancelled,
                observation_id: None,
            });
            self.cancel_v1("The Agent run was stopped during tool execution.");
            return AgentOrchestratorStepV1::Terminal;
        }
        if output.status == AgentToolOutputStatusV1::Cancelled {
            self.tool_calls.push(AgentToolCallRecordV1 {
                request,
                status: AgentToolCallRecordStatusV1::Cancelled,
                observation_id: None,
            });
            self.fail_v1(
                AgentPublicErrorCategoryV1::ToolFailed,
                "The Agent fake tool ended as cancelled without a Stop request.",
            );
            return AgentOrchestratorStepV1::Terminal;
        }

        self.transition_v1(AgentRunStateV1::Observing);
        let observation_id = self.next_observation_id_v1();
        let (context_status, record_status, failed) = match output.status {
            AgentToolOutputStatusV1::Completed => (
                AgentContextObservationStatusV1::Completed,
                AgentToolCallRecordStatusV1::Completed,
                false,
            ),
            AgentToolOutputStatusV1::Failed => (
                AgentContextObservationStatusV1::Failed,
                AgentToolCallRecordStatusV1::Failed,
                true,
            ),
            AgentToolOutputStatusV1::TimedOut => (
                AgentContextObservationStatusV1::TimedOut,
                AgentToolCallRecordStatusV1::TimedOut,
                true,
            ),
            AgentToolOutputStatusV1::Cancelled => unreachable!(),
        };
        let output_excerpt = bounded_fake_output_v1(&output.stdout_excerpt, &output.stderr_excerpt);
        self.dynamic_context
            .observations
            .push(AgentContextObservationV1 {
                observation_id: observation_id.clone(),
                tool_call_id: request.tool_call_id.clone(),
                tool: request.input.name().to_string(),
                status: context_status,
                summary: output.summary.clone(),
                output_excerpt,
            });
        self.tool_calls.push(AgentToolCallRecordV1 {
            request,
            status: record_status,
            observation_id: Some(observation_id),
        });
        if failed {
            self.dynamic_context.recent_tool_error = Some(output.summary);
            if self.budgets.record_tool_failure().is_err() {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::ToolFailed,
                    "The Agent consecutive fake-tool failure limit was reached.",
                );
                return AgentOrchestratorStepV1::Terminal;
            }
        } else {
            self.dynamic_context.recent_tool_error = None;
            self.budgets.record_tool_success();
        }

        if controls.pause_requested {
            self.pause_now_v1();
            return AgentOrchestratorStepV1::Paused;
        }
        self.transition_v1(AgentRunStateV1::Thinking);
        AgentOrchestratorStepV1::DecisionApplied
    }

    fn apply_control_boundary_v1(&mut self) -> bool {
        match self.control.snapshot() {
            Ok(controls) if controls.stop_requested => {
                self.cancel_v1("The Agent run was stopped at a decision boundary.");
                true
            }
            Ok(controls) if controls.pause_requested => {
                self.pause_now_v1();
                true
            }
            Ok(_) => false,
            Err(_) => {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent control boundary is unavailable.",
                );
                true
            }
        }
    }

    fn consume_steering_v1(&mut self) {
        let steering = match self.control.drain_steering() {
            Ok(steering) => steering,
            Err(_) => {
                self.fail_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent steering queue is unavailable.",
                );
                return;
            }
        };
        self.dynamic_context.steering.extend(steering);
        let queued = self.control.snapshot().ok().map(|_| 0).unwrap_or(u8::MAX);
        if self.budgets.set_steering_queue_items(queued).is_err() {
            self.fail_v1(
                AgentPublicErrorCategoryV1::BudgetExceeded,
                "The Agent steering queue budget is exhausted.",
            );
        }
    }

    fn fail_model_error_v1(&mut self, error: AgentModelErrorV1) {
        let category = match error.kind {
            AgentModelErrorKindV1::Timeout | AgentModelErrorKindV1::Unavailable => {
                AgentPublicErrorCategoryV1::ProviderUnavailable
            }
            AgentModelErrorKindV1::Incompatible => AgentPublicErrorCategoryV1::ProviderIncompatible,
            AgentModelErrorKindV1::ProviderProtocol | AgentModelErrorKindV1::InvalidDecision => {
                AgentPublicErrorCategoryV1::ProviderProtocol
            }
            AgentModelErrorKindV1::Cancelled => AgentPublicErrorCategoryV1::Internal,
        };
        self.fail_v1(category, &error.message);
    }

    fn next_tool_call_id_v1(&self) -> String {
        format!("{}-tool-{}", self.config.run_id, self.tool_calls.len() + 1)
    }

    fn next_observation_id_v1(&self) -> String {
        format!(
            "{}-observation-{}",
            self.config.run_id,
            self.dynamic_context.observations.len() + 1
        )
    }

    fn transition_v1(&mut self, next: AgentRunStateV1) {
        match self.state.transition(next) {
            Ok(next) => self.state = next,
            Err(_) => {
                self.error = Some(public_error_v1(
                    AgentPublicErrorCategoryV1::Internal,
                    "The Agent state transition failed closed.",
                ));
                if self.state.can_transition_to(AgentRunStateV1::Failed) {
                    self.state = AgentRunStateV1::Failed;
                }
            }
        }
    }

    fn pause_now_v1(&mut self) {
        if self.state == AgentRunStateV1::Pausing {
            self.transition_v1(AgentRunStateV1::Paused);
            return;
        }
        self.transition_v1(AgentRunStateV1::Pausing);
        if self.state == AgentRunStateV1::Pausing {
            self.transition_v1(AgentRunStateV1::Paused);
        }
    }

    fn cancel_v1(&mut self, message: &str) {
        if self.state.is_terminal() {
            return;
        }
        if self.state != AgentRunStateV1::Cancelling {
            self.transition_v1(AgentRunStateV1::Cancelling);
        }
        if self.state == AgentRunStateV1::Cancelling {
            self.transition_v1(AgentRunStateV1::Cancelled);
        }
        self.error = Some(public_error_v1(
            AgentPublicErrorCategoryV1::Cancelled,
            message,
        ));
    }

    fn fail_v1(&mut self, category: AgentPublicErrorCategoryV1, message: &str) {
        if self.state.is_terminal() {
            return;
        }
        self.transition_v1(AgentRunStateV1::Failed);
        self.error = Some(public_error_v1(category, message));
    }

    fn current_boundary_v1(&self) -> AgentOrchestratorStepV1 {
        match self.state {
            AgentRunStateV1::Paused => AgentOrchestratorStepV1::Paused,
            AgentRunStateV1::AwaitingUser => AgentOrchestratorStepV1::AwaitingUser,
            state if state.is_terminal() => AgentOrchestratorStepV1::Terminal,
            _ => AgentOrchestratorStepV1::DecisionApplied,
        }
    }
}

fn public_error_v1(category: AgentPublicErrorCategoryV1, message: &str) -> AgentPublicErrorV1 {
    let retryable = matches!(
        category,
        AgentPublicErrorCategoryV1::ProviderUnavailable | AgentPublicErrorCategoryV1::ToolFailed
    );
    AgentPublicErrorV1 {
        schema_version: AgentSchemaVersionV1,
        category,
        message: message.to_string(),
        retryable,
        suggestion: None,
    }
}

fn bounded_fake_output_v1(stdout: &str, stderr: &str) -> String {
    const MAX_FAKE_OUTPUT_CHARACTERS: usize = 8 * 1024;
    let combined = match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("stdout:\n{stdout}\nstderr:\n{stderr}"),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (true, true) => String::new(),
    };
    combined.chars().take(MAX_FAKE_OUTPUT_CHARACTERS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::model::{
        AgentModelContextV1, AgentModelFutureV1, AgentModelTurnResultV1, AgentModelUsageV1,
    };
    use crate::agent::protocol::{
        decode_agent_decision_v1, AgentPolicyModeV1, AgentPolicySnapshotV1, AgentProviderBindingV1,
        AgentProviderCapabilitiesV1, AgentProviderKindV1, AgentTargetBindingV1, AgentToolNameV1,
    };
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use tokio::sync::oneshot;

    enum FakeModelActionV1 {
        Decision(String),
        DecisionByContext {
            needle: String,
            present: String,
            absent: String,
        },
        Error(AgentModelErrorKindV1),
        AwaitCancellation {
            started: oneshot::Sender<()>,
        },
        WaitThenDecision {
            started: oneshot::Sender<()>,
            release: oneshot::Receiver<()>,
            decision: String,
        },
    }

    struct FakeModelV1 {
        provider: AgentProviderBindingV1,
        actions: Mutex<VecDeque<FakeModelActionV1>>,
        requests: Arc<Mutex<Vec<AgentModelRequestV1>>>,
    }

    impl FakeModelV1 {
        fn new(actions: Vec<FakeModelActionV1>) -> Self {
            Self {
                provider: fake_provider_v1(),
                actions: Mutex::new(actions.into()),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn requests(&self) -> Arc<Mutex<Vec<AgentModelRequestV1>>> {
            self.requests.clone()
        }
    }

    impl AgentDecisionModelV1 for FakeModelV1 {
        fn provider(&self) -> &AgentProviderBindingV1 {
            &self.provider
        }

        fn request_decision<'a>(
            &'a self,
            request: AgentModelRequestV1,
            cancellation: CancellationToken,
        ) -> AgentModelFutureV1<'a> {
            self.requests.lock().unwrap().push(request.clone());
            let action = self
                .actions
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake model action");
            Box::pin(async move {
                match action {
                    FakeModelActionV1::Decision(raw) => fake_decision_result_v1(&raw),
                    FakeModelActionV1::DecisionByContext {
                        needle,
                        present,
                        absent,
                    } => {
                        let raw = if request.context.dynamic_input.contains(&needle) {
                            present
                        } else {
                            absent
                        };
                        fake_decision_result_v1(&raw)
                    }
                    FakeModelActionV1::Error(kind) => Err(fake_model_error_v1(kind)),
                    FakeModelActionV1::AwaitCancellation { started } => {
                        let _ = started.send(());
                        cancellation.cancelled().await;
                        Err(fake_model_error_v1(AgentModelErrorKindV1::Cancelled))
                    }
                    FakeModelActionV1::WaitThenDecision {
                        started,
                        release,
                        decision,
                    } => {
                        let _ = started.send(());
                        let _ = release.await;
                        fake_decision_result_v1(&decision)
                    }
                }
            })
        }
    }

    fn fake_decision_result_v1(raw: &str) -> Result<AgentModelTurnResultV1, AgentModelErrorV1> {
        let decision = decode_agent_decision_v1(raw)
            .map_err(|_| fake_model_error_v1(AgentModelErrorKindV1::InvalidDecision))?;
        Ok(AgentModelTurnResultV1 {
            decision,
            provider_request_id: Some("fake-request".to_string()),
            usage: Some(AgentModelUsageV1 {
                input_tokens: 1,
                output_tokens: 1,
            }),
        })
    }

    fn fake_model_error_v1(kind: AgentModelErrorKindV1) -> AgentModelErrorV1 {
        AgentModelErrorV1 {
            kind,
            message: match kind {
                AgentModelErrorKindV1::Timeout => "The fake provider timed out.",
                AgentModelErrorKindV1::InvalidDecision => {
                    "The fake provider returned an invalid decision."
                }
                AgentModelErrorKindV1::Cancelled => "The fake provider was cancelled.",
                _ => "The fake provider failed.",
            }
            .to_string(),
        }
    }

    enum FakeToolActionV1 {
        Immediate(AgentToolOutputV1),
        WaitThenOutput {
            started: oneshot::Sender<()>,
            release: oneshot::Receiver<()>,
            output: AgentToolOutputV1,
        },
        AwaitCancellation {
            started: oneshot::Sender<()>,
        },
    }

    struct FakeToolsV1 {
        denials: HashMap<String, String>,
        actions: Mutex<VecDeque<FakeToolActionV1>>,
        executed: Arc<Mutex<Vec<AgentToolRequestV1>>>,
    }

    impl FakeToolsV1 {
        fn new(actions: Vec<FakeToolActionV1>) -> Self {
            Self {
                denials: HashMap::new(),
                actions: Mutex::new(actions.into()),
                executed: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn denying(mut self, program: &str, reason: &str) -> Self {
            self.denials.insert(program.to_string(), reason.to_string());
            self
        }

        fn executed(&self) -> Arc<Mutex<Vec<AgentToolRequestV1>>> {
            self.executed.clone()
        }
    }

    impl AgentToolDriverV1 for FakeToolsV1 {
        fn validate(&self, request: &AgentToolRequestV1) -> AgentToolValidationV1 {
            let AgentToolInputV1::ShellExecReadOnly(arguments) = &request.input else {
                return AgentToolValidationV1::Ready;
            };
            self.denials
                .get(&arguments.program)
                .map(|reason| {
                    AgentToolValidationV1::Denied(AgentToolDeniedV1 {
                        reason: reason.clone(),
                    })
                })
                .unwrap_or(AgentToolValidationV1::Ready)
        }

        fn execute<'a>(
            &'a self,
            request: AgentToolRequestV1,
            cancellation: CancellationToken,
        ) -> AgentToolFutureV1<'a> {
            self.executed.lock().unwrap().push(request);
            let action = self
                .actions
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake tool action");
            Box::pin(async move {
                match action {
                    FakeToolActionV1::Immediate(output) => output,
                    FakeToolActionV1::WaitThenOutput {
                        started,
                        release,
                        output,
                    } => {
                        let _ = started.send(());
                        let _ = release.await;
                        output
                    }
                    FakeToolActionV1::AwaitCancellation { started } => {
                        let _ = started.send(());
                        cancellation.cancelled().await;
                        AgentToolOutputV1 {
                            status: AgentToolOutputStatusV1::Cancelled,
                            summary: "cancelled by fake control".to_string(),
                            stdout_excerpt: String::new(),
                            stderr_excerpt: String::new(),
                        }
                    }
                }
            })
        }
    }

    fn fake_provider_v1() -> AgentProviderBindingV1 {
        AgentProviderBindingV1 {
            provider_id: "fake-provider".to_string(),
            kind: AgentProviderKindV1::OpenAiCompatible,
            base_url: "https://fixture.invalid/v1".to_string(),
            model: "fake-model".to_string(),
            capabilities: AgentProviderCapabilitiesV1 {
                streaming: false,
                strict_json_schema: true,
                native_tool_calling: false,
                usage_reporting: true,
                response_continuation: false,
            },
        }
    }

    fn config_v1(mut policy: AgentBudgetPolicyV1) -> AgentOrchestratorConfigV1 {
        policy.max_run_seconds = 60;
        AgentOrchestratorConfigV1 {
            run_id: "fake-run".to_string(),
            stable_context: AgentStableContextV1 {
                goal: "Inspect fake CPU pressure without changes.".to_string(),
                target: AgentTargetBindingV1 {
                    profile_id: "profile-1".to_string(),
                    profile_label: "Fake host".to_string(),
                    host: "fixture.invalid".to_string(),
                    port: 22,
                    username: "fixture".to_string(),
                    auth_method: "fixture".to_string(),
                    jump_host: None,
                    target_digest: "fake-target-digest".to_string(),
                },
                policy: AgentPolicySnapshotV1 {
                    mode: AgentPolicyModeV1::ReadOnly,
                    policy_version: "p1-b-fake-only".to_string(),
                    tool_registry_version: "fake-only".to_string(),
                    allowed_tools: vec![
                        AgentToolNameV1::HostInspect,
                        AgentToolNameV1::ShellExecReadOnly,
                    ],
                },
            },
            budget_policy: policy,
        }
    }

    fn shell_decision_v1(program: &str, args: &[&str]) -> String {
        json!({
            "schemaVersion": 1,
            "kind": "toolCall",
            "rationale": format!("Inspect with {program}."),
            "plan": { "items": [{
                "id": "inspect",
                "title": "Inspect the fake host",
                "status": "active"
            }] },
            "tool": "shell.execReadOnly",
            "arguments": {
                "program": program,
                "args": args,
                "timeoutSeconds": 5
            },
            "purpose": "Collect one bounded fake observation.",
            "successCriteria": "The fake result reaches one stable status."
        })
        .to_string()
    }

    fn host_inspect_decision_v1() -> String {
        json!({
            "schemaVersion": 1,
            "kind": "toolCall",
            "rationale": "Inspect the fake host capabilities.",
            "plan": { "items": [{
                "id": "inspect",
                "title": "Inspect the fake host",
                "status": "active"
            }] },
            "tool": "host.inspect",
            "arguments": {
                "include": ["os", "capabilities"]
            },
            "purpose": "Establish the fake operating system and bounded diagnostics.",
            "successCriteria": "The fake OS and diagnostic capabilities are observed."
        })
        .to_string()
    }

    fn final_decision_v1(summary: &str) -> String {
        json!({
            "schemaVersion": 1,
            "kind": "final",
            "rationale": "The fake observations are sufficient.",
            "plan": { "items": [{
                "id": "inspect",
                "title": "Inspect the fake host",
                "status": "completed"
            }] },
            "report": {
                "outcome": "diagnosed",
                "summary": summary,
                "findings": [],
                "changes": [],
                "warnings": [],
                "nextActions": []
            }
        })
        .to_string()
    }

    fn ask_user_decision_v1(question: &str) -> String {
        json!({
            "schemaVersion": 1,
            "kind": "askUser",
            "rationale": "One bounded clarification is required.",
            "plan": { "items": [] },
            "question": question
        })
        .to_string()
    }

    fn completed_tool_v1(summary: &str, stdout: &str) -> AgentToolOutputV1 {
        AgentToolOutputV1 {
            status: AgentToolOutputStatusV1::Completed,
            summary: summary.to_string(),
            stdout_excerpt: stdout.to_string(),
            stderr_excerpt: String::new(),
        }
    }

    fn tool_program_v1(request: &AgentToolRequestV1) -> Option<&str> {
        match &request.input {
            AgentToolInputV1::ShellExecReadOnly(arguments) => Some(&arguments.program),
            AgentToolInputV1::HostInspect(_) => None,
        }
    }

    #[tokio::test]
    async fn second_fake_tool_call_is_selected_from_the_first_observation() {
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(shell_decision_v1("uptime", &[])),
            FakeModelActionV1::DecisionByContext {
                needle: "load=9.2".to_string(),
                present: shell_decision_v1("ps", &["bounded"]),
                absent: final_decision_v1("Load was low; no process snapshot needed."),
            },
            FakeModelActionV1::Decision(final_decision_v1(
                "High load led to a bounded process snapshot.",
            )),
        ]);
        let requests = model.requests();
        let tools = FakeToolsV1::new(vec![
            FakeToolActionV1::Immediate(completed_tool_v1("High load observed.", "load=9.2")),
            FakeToolActionV1::Immediate(completed_tool_v1(
                "A fake CPU consumer was observed.",
                "pid=42 cpu=97",
            )),
        ]);
        let executed = tools.executed();
        let mut orchestrator =
            AgentOrchestratorV1::new(config_v1(AgentBudgetPolicyV1::default()), model, tools);

        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Completed);
        {
            let executed = executed.lock().unwrap();
            assert_eq!(executed.len(), 2);
            assert_eq!(tool_program_v1(&executed[0]), Some("uptime"));
            assert_eq!(tool_program_v1(&executed[1]), Some("ps"));
        }
        assert!(requests.lock().unwrap()[1]
            .context
            .dynamic_input
            .contains("load=9.2"));

        let low_model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(shell_decision_v1("uptime", &[])),
            FakeModelActionV1::DecisionByContext {
                needle: "load=9.2".to_string(),
                present: shell_decision_v1("ps", &["bounded"]),
                absent: final_decision_v1("Load was low; no process snapshot needed."),
            },
        ]);
        let low_tools = FakeToolsV1::new(vec![FakeToolActionV1::Immediate(completed_tool_v1(
            "Low load observed.",
            "load=0.2",
        ))]);
        let low_executed = low_tools.executed();
        let mut low_orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            low_model,
            low_tools,
        );
        assert_eq!(
            low_orchestrator.run_to_boundary().await.state,
            AgentRunStateV1::Completed
        );
        assert_eq!(low_executed.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn fake_host_inspect_to_shell_to_final_path_exercises_both_tool_variants() {
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(host_inspect_decision_v1()),
            FakeModelActionV1::DecisionByContext {
                needle: "os=linux capabilities=ps".to_string(),
                present: shell_decision_v1("ps", &["bounded"]),
                absent: final_decision_v1("The fake host did not expose ps."),
            },
            FakeModelActionV1::Decision(final_decision_v1(
                "Host inspection selected one bounded process snapshot.",
            )),
        ]);
        let tools = FakeToolsV1::new(vec![
            FakeToolActionV1::Immediate(completed_tool_v1(
                "Linux and ps capability observed.",
                "os=linux capabilities=ps",
            )),
            FakeToolActionV1::Immediate(completed_tool_v1(
                "Bounded process snapshot observed.",
                "pid=42 cpu=50",
            )),
        ]);
        let executed = tools.executed();
        let mut orchestrator =
            AgentOrchestratorV1::new(config_v1(AgentBudgetPolicyV1::default()), model, tools);
        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Completed);
        let executed = executed.lock().unwrap();
        assert!(matches!(
            executed[0].input,
            AgentToolInputV1::HostInspect(_)
        ));
        assert_eq!(tool_program_v1(&executed[1]), Some("ps"));
    }

    #[tokio::test]
    async fn steering_invalidates_an_in_flight_decision_even_if_the_model_ignores_cancel() {
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::WaitThenDecision {
                started: started_tx,
                release: release_rx,
                decision: shell_decision_v1("systemctl", &["restart", "nginx"]),
            },
            FakeModelActionV1::DecisionByContext {
                needle: "Do not inspect services".to_string(),
                present: final_decision_v1("Steering replaced the stale service decision."),
                absent: shell_decision_v1("systemctl", &["restart", "nginx"]),
            },
        ]);
        let requests = model.requests();
        let tools = FakeToolsV1::new(Vec::new());
        let executed = tools.executed();
        let orchestrator =
            AgentOrchestratorV1::new(config_v1(AgentBudgetPolicyV1::default()), model, tools);
        let control = orchestrator.control();
        let task = tokio::spawn(async move {
            let mut orchestrator = orchestrator;
            orchestrator.run_to_boundary().await;
            orchestrator
        });

        started_rx.await.unwrap();
        control
            .steer("Do not inspect services; finish with current information.")
            .unwrap();
        release_tx.send(()).unwrap();
        let orchestrator = task.await.unwrap();
        let snapshot = orchestrator.snapshot();
        assert_eq!(snapshot.state, AgentRunStateV1::Completed);
        assert_eq!(snapshot.discarded_model_decisions, 1);
        assert!(executed.lock().unwrap().is_empty());
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn exactly_one_schema_repair_is_allowed_before_provider_protocol_failure() {
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision("not-json".to_string()),
            FakeModelActionV1::Decision("still-not-json".to_string()),
        ]);
        let requests = model.requests();
        let mut orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            model,
            FakeToolsV1::new(Vec::new()),
        );
        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Failed);
        assert_eq!(
            snapshot.error.unwrap().category,
            AgentPublicErrorCategoryV1::ProviderProtocol
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(!requests[0].repair);
        assert!(requests[1].repair);
        assert_eq!(snapshot.budgets.usage.model_turns_used, 2);
    }

    #[tokio::test]
    async fn provider_timeout_has_a_stable_failed_terminal() {
        let model = FakeModelV1::new(vec![FakeModelActionV1::Error(
            AgentModelErrorKindV1::Timeout,
        )]);
        let mut orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            model,
            FakeToolsV1::new(Vec::new()),
        );
        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Failed);
        assert_eq!(
            snapshot.error.as_ref().unwrap().category,
            AgentPublicErrorCategoryV1::ProviderUnavailable
        );
        assert!(snapshot.error.as_ref().unwrap().retryable);
        orchestrator.run_single_decision().await;
        assert_eq!(orchestrator.snapshot(), snapshot);
    }

    #[tokio::test]
    async fn denied_fake_tool_is_observed_and_the_model_selects_an_allowed_alternative() {
        let denial = "systemctl mutation denied by fake boundary";
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(shell_decision_v1("systemctl", &["restart", "nginx"])),
            FakeModelActionV1::DecisionByContext {
                needle: denial.to_string(),
                present: shell_decision_v1("uptime", &[]),
                absent: final_decision_v1("The denial was not observed."),
            },
            FakeModelActionV1::Decision(final_decision_v1(
                "The denied proposal was replaced by a read-only fake observation.",
            )),
        ]);
        let tools = FakeToolsV1::new(vec![FakeToolActionV1::Immediate(completed_tool_v1(
            "Load observed.",
            "load=0.5",
        ))])
        .denying("systemctl", denial);
        let executed = tools.executed();
        let mut orchestrator =
            AgentOrchestratorV1::new(config_v1(AgentBudgetPolicyV1::default()), model, tools);
        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Completed);
        assert_eq!(snapshot.tool_calls.len(), 2);
        assert_eq!(
            snapshot.tool_calls[0].status,
            AgentToolCallRecordStatusV1::Denied
        );
        assert_eq!(
            snapshot.tool_calls[1].status,
            AgentToolCallRecordStatusV1::Completed
        );
        assert_eq!(
            tool_program_v1(&executed.lock().unwrap()[0]),
            Some("uptime")
        );
    }

    #[tokio::test]
    async fn pause_cancels_thinking_and_resume_uses_a_fresh_model_turn() {
        let (started_tx, started_rx) = oneshot::channel();
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::AwaitCancellation {
                started: started_tx,
            },
            FakeModelActionV1::Decision(final_decision_v1("Resumed safely.")),
        ]);
        let orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            model,
            FakeToolsV1::new(Vec::new()),
        );
        let control = orchestrator.control();
        let task = tokio::spawn(async move {
            let mut orchestrator = orchestrator;
            orchestrator.run_to_boundary().await;
            orchestrator
        });
        started_rx.await.unwrap();
        control.pause().unwrap();
        let mut orchestrator = task.await.unwrap();
        assert_eq!(orchestrator.snapshot().state, AgentRunStateV1::Paused);
        orchestrator.resume().unwrap();
        assert_eq!(
            orchestrator.run_to_boundary().await.state,
            AgentRunStateV1::Completed
        );
        assert_eq!(orchestrator.snapshot().budgets.usage.model_turns_used, 2);
    }

    #[tokio::test]
    async fn ask_user_is_a_stable_boundary_and_the_answer_reaches_the_next_turn() {
        let model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(ask_user_decision_v1(
                "Which service should remain in scope?",
            )),
            FakeModelActionV1::DecisionByContext {
                needle: "Only nginx is in scope".to_string(),
                present: final_decision_v1("The user answer constrained the fake conclusion."),
                absent: final_decision_v1("The user answer was missing."),
            },
        ]);
        let mut orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            model,
            FakeToolsV1::new(Vec::new()),
        );
        let awaiting = orchestrator.run_to_boundary().await;
        assert_eq!(awaiting.state, AgentRunStateV1::AwaitingUser);
        assert_eq!(
            awaiting.pending_question.as_deref(),
            Some("Which service should remain in scope?")
        );
        orchestrator
            .send_message("Only nginx is in scope.")
            .unwrap();
        let completed = orchestrator.run_to_boundary().await;
        assert_eq!(completed.state, AgentRunStateV1::Completed);
        assert!(completed.pending_question.is_none());
        assert!(completed
            .report
            .unwrap()
            .summary
            .contains("user answer constrained"));
    }

    #[tokio::test]
    async fn pause_during_tool_waits_for_observation_while_stop_cancels_without_next_turn() {
        let (pause_started_tx, pause_started_rx) = oneshot::channel();
        let (pause_release_tx, pause_release_rx) = oneshot::channel();
        let pause_model = FakeModelV1::new(vec![
            FakeModelActionV1::Decision(shell_decision_v1("uptime", &[])),
            FakeModelActionV1::Decision(final_decision_v1("Resumed after observation.")),
        ]);
        let pause_tools = FakeToolsV1::new(vec![FakeToolActionV1::WaitThenOutput {
            started: pause_started_tx,
            release: pause_release_rx,
            output: completed_tool_v1("Bounded observation completed.", "load=1.0"),
        }]);
        let pause_orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            pause_model,
            pause_tools,
        );
        let pause_control = pause_orchestrator.control();
        let pause_task = tokio::spawn(async move {
            let mut orchestrator = pause_orchestrator;
            orchestrator.run_to_boundary().await;
            orchestrator
        });
        pause_started_rx.await.unwrap();
        pause_control.pause().unwrap();
        pause_release_tx.send(()).unwrap();
        let mut pause_orchestrator = pause_task.await.unwrap();
        let paused = pause_orchestrator.snapshot();
        assert_eq!(paused.state, AgentRunStateV1::Paused);
        assert_eq!(paused.observations.len(), 1);
        pause_orchestrator.resume().unwrap();
        assert_eq!(
            pause_orchestrator.run_to_boundary().await.state,
            AgentRunStateV1::Completed
        );

        let (stop_started_tx, stop_started_rx) = oneshot::channel();
        let stop_model = FakeModelV1::new(vec![FakeModelActionV1::Decision(shell_decision_v1(
            "uptime",
            &[],
        ))]);
        let stop_requests = stop_model.requests();
        let stop_tools = FakeToolsV1::new(vec![FakeToolActionV1::AwaitCancellation {
            started: stop_started_tx,
        }]);
        let stop_orchestrator = AgentOrchestratorV1::new(
            config_v1(AgentBudgetPolicyV1::default()),
            stop_model,
            stop_tools,
        );
        let stop_control = stop_orchestrator.control();
        let stop_task = tokio::spawn(async move {
            let mut orchestrator = stop_orchestrator;
            orchestrator.run_to_boundary().await;
            orchestrator
        });
        stop_started_rx.await.unwrap();
        stop_control.stop().unwrap();
        let mut stop_orchestrator = stop_task.await.unwrap();
        let cancelled = stop_orchestrator.snapshot();
        assert_eq!(cancelled.state, AgentRunStateV1::Cancelled);
        assert!(cancelled.observations.is_empty());
        assert_eq!(stop_requests.lock().unwrap().len(), 1);
        stop_orchestrator.run_single_decision().await;
        assert_eq!(stop_orchestrator.snapshot(), cancelled);
    }

    #[tokio::test]
    async fn budget_exhaustion_prevents_an_additional_model_request_and_is_terminal() {
        let policy = AgentBudgetPolicyV1 {
            max_model_turns: 1,
            ..AgentBudgetPolicyV1::default()
        };
        let model = FakeModelV1::new(vec![FakeModelActionV1::Decision(shell_decision_v1(
            "uptime",
            &[],
        ))]);
        let requests = model.requests();
        let tools = FakeToolsV1::new(vec![FakeToolActionV1::Immediate(completed_tool_v1(
            "One observation consumed the remaining turn.",
            "load=0.5",
        ))]);
        let mut orchestrator = AgentOrchestratorV1::new(config_v1(policy), model, tools);
        let snapshot = orchestrator.run_to_boundary().await;
        assert_eq!(snapshot.state, AgentRunStateV1::Failed);
        assert_eq!(
            snapshot.error.as_ref().unwrap().category,
            AgentPublicErrorCategoryV1::BudgetExceeded
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(snapshot.tool_calls.len(), 1);
        orchestrator.run_single_decision().await;
        assert_eq!(orchestrator.snapshot(), snapshot);
    }

    #[test]
    fn model_context_type_does_not_mix_stable_and_dynamic_fields() {
        let context = AgentModelContextV1 {
            stable_instructions: "stable".to_string(),
            dynamic_input: "dynamic".to_string(),
        };
        assert_ne!(context.stable_instructions, context.dynamic_input);
    }
}
