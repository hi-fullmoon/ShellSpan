use std::sync::Arc;

use serde_json::Value;

use super::{AgentSessionEffect, AgentSessionTarget, AgentToolResultStatus, ModelSurfaceBudget};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentPreStepContext {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) step_index: usize,
    pub(crate) surface_generation: u64,
    pub(crate) budget: ModelSurfaceBudget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentPreStepDecision {
    Continue,
    #[cfg(test)]
    Reject {
        reason: String,
    },
    #[cfg(test)]
    AppendContext {
        message_id: String,
        label: String,
        content: String,
    },
    Compact {
        reason: String,
    },
}

pub(crate) trait AgentPreStepHook: Send + Sync {
    fn pre_step(&self, context: &AgentPreStepContext) -> Result<AgentPreStepDecision, String>;
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AgentBeforeToolContext {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) arguments: Value,
    pub(crate) target: AgentSessionTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentBeforeToolDecision {
    Continue,
    Reject { reason: String },
}

pub(crate) trait AgentBeforeToolHook: Send + Sync {
    fn before_tool(
        &self,
        context: &AgentBeforeToolContext,
    ) -> Result<AgentBeforeToolDecision, String>;
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AgentAfterToolContext {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) effect: AgentSessionEffect,
    pub(crate) target: AgentSessionTarget,
    pub(crate) status: AgentToolResultStatus,
    pub(crate) summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentAfterToolDecision {
    Continue,
    AppendContext {
        message_id: String,
        label: String,
        content: String,
    },
}

pub(crate) trait AgentAfterToolHook: Send + Sync {
    fn after_tool(&self, context: &AgentAfterToolContext)
        -> Result<AgentAfterToolDecision, String>;
}

pub(crate) trait AgentToolFailedHook: Send + Sync {
    fn tool_failed(
        &self,
        context: &AgentAfterToolContext,
    ) -> Result<AgentAfterToolDecision, String>;
}

struct NativeBoundaryHook;

struct BudgetCompactionHook;

impl AgentPreStepHook for BudgetCompactionHook {
    fn pre_step(&self, context: &AgentPreStepContext) -> Result<AgentPreStepDecision, String> {
        if context.budget.requires_compaction() {
            Ok(AgentPreStepDecision::Compact {
                reason: "budgetPressure".into(),
            })
        } else {
            Ok(AgentPreStepDecision::Continue)
        }
    }
}

impl AgentBeforeToolHook for NativeBoundaryHook {
    fn before_tool(
        &self,
        context: &AgentBeforeToolContext,
    ) -> Result<AgentBeforeToolDecision, String> {
        if context.session_id.trim().is_empty()
            || context.task_id.trim().is_empty()
            || context.turn_id.trim().is_empty()
            || context.step_id.trim().is_empty()
            || context.request_id.trim().is_empty()
            || context.call_id.trim().is_empty()
            || context.name.trim().is_empty()
            || !context.arguments.is_object()
            || context.target.target_id.trim().is_empty()
            || context.target.session_id.trim().is_empty()
        {
            return Ok(AgentBeforeToolDecision::Reject {
                reason: "native tool context is incomplete or unstructured".into(),
            });
        }
        Ok(AgentBeforeToolDecision::Continue)
    }
}

struct NativeLifecycleHook;

impl AgentAfterToolHook for NativeLifecycleHook {
    fn after_tool(
        &self,
        context: &AgentAfterToolContext,
    ) -> Result<AgentAfterToolDecision, String> {
        if context.status == AgentToolResultStatus::Completed
            && context.effect == AgentSessionEffect::ExternalSideEffect
        {
            return Ok(AgentAfterToolDecision::AppendContext {
                message_id: format!(
                    "runtime-verify-{}-{}",
                    context.step_id, context.call_id
                ),
                label: "afterTool".into(),
                content: format!(
                    "Native external side effect `{}` completed on frozen target `{}`. Verify its observed outcome before declaring the task complete.",
                    context.name, context.target.target_id
                ),
            });
        }
        Ok(AgentAfterToolDecision::Continue)
    }
}

impl AgentToolFailedHook for NativeLifecycleHook {
    fn tool_failed(
        &self,
        _context: &AgentAfterToolContext,
    ) -> Result<AgentAfterToolDecision, String> {
        Ok(AgentAfterToolDecision::Continue)
    }
}

#[derive(Clone)]
pub(crate) struct AgentHookBus {
    pre_step: Vec<Arc<dyn AgentPreStepHook>>,
    before_tool: Vec<Arc<dyn AgentBeforeToolHook>>,
    after_tool: Vec<Arc<dyn AgentAfterToolHook>>,
    tool_failed: Vec<Arc<dyn AgentToolFailedHook>>,
}

impl Default for AgentHookBus {
    fn default() -> Self {
        let lifecycle = Arc::new(NativeLifecycleHook);
        Self {
            pre_step: vec![Arc::new(BudgetCompactionHook)],
            before_tool: vec![Arc::new(NativeBoundaryHook)],
            after_tool: vec![lifecycle.clone()],
            tool_failed: vec![lifecycle],
        }
    }
}

impl AgentHookBus {
    #[cfg(test)]
    pub(crate) fn with_pre_step_hook(mut self, hook: Arc<dyn AgentPreStepHook>) -> Self {
        self.pre_step.push(hook);
        self
    }

    pub(crate) fn pre_step(
        &self,
        context: &AgentPreStepContext,
    ) -> Result<Vec<AgentPreStepDecision>, String> {
        self.pre_step
            .iter()
            .map(|hook| hook.pre_step(context))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn with_before_tool_hook(mut self, hook: Arc<dyn AgentBeforeToolHook>) -> Self {
        self.before_tool.push(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_after_tool_hook(mut self, hook: Arc<dyn AgentAfterToolHook>) -> Self {
        self.after_tool.push(hook);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_tool_failed_hook(mut self, hook: Arc<dyn AgentToolFailedHook>) -> Self {
        self.tool_failed.push(hook);
        self
    }

    pub(crate) fn before_tool(
        &self,
        context: &AgentBeforeToolContext,
    ) -> Result<Vec<AgentBeforeToolDecision>, String> {
        self.before_tool
            .iter()
            .map(|hook| hook.before_tool(context))
            .collect()
    }

    pub(crate) fn after_tool(
        &self,
        context: &AgentAfterToolContext,
    ) -> Result<Vec<AgentAfterToolDecision>, String> {
        self.after_tool
            .iter()
            .map(|hook| hook.after_tool(context))
            .collect()
    }

    pub(crate) fn tool_failed(
        &self,
        context: &AgentAfterToolContext,
    ) -> Result<Vec<AgentAfterToolDecision>, String> {
        self.tool_failed
            .iter()
            .map(|hook| hook.tool_failed(context))
            .collect()
    }
}
