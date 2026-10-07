//! Debug-only access to the actual Runtime objects for recovery protocol acceptance.
//! No replacement factory, transport, model response, journal or gate is installed.
use super::*;

pub(crate) struct ActualPipelineParts {
    pub(crate) sessions: AgentSessionStore,
    pub(crate) agents: AgentRegistry,
    pub(crate) tools: AgentToolPipeline,
    pub(crate) models: ModelRegistry,
}

pub(crate) fn actual_parts(runtime: &AgentRuntime) -> ActualPipelineParts {
    ActualPipelineParts {
        sessions: runtime.sessions.clone(),
        agents: runtime.agents.clone(),
        tools: runtime.tools.clone(),
        models: runtime.models.clone(),
    }
}
