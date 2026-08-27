use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRunStateV1 {
    Created,
    CollectingContext,
    Thinking,
    ValidatingTool,
    ExecutingTool,
    Observing,
    AwaitingUser,
    Pausing,
    Paused,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Blocked,
}

impl AgentRunStateV1 {
    pub(crate) const ALL: [Self; 14] = [
        Self::Created,
        Self::CollectingContext,
        Self::Thinking,
        Self::ValidatingTool,
        Self::ExecutingTool,
        Self::Observing,
        Self::AwaitingUser,
        Self::Pausing,
        Self::Paused,
        Self::Cancelling,
        Self::Completed,
        Self::Failed,
        Self::Cancelled,
        Self::Blocked,
    ];

    pub(crate) const TERMINAL: [Self; 4] = [
        Self::Completed,
        Self::Failed,
        Self::Cancelled,
        Self::Blocked,
    ];

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Blocked
        )
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use AgentRunStateV1 as State;

        matches!(
            (self, next),
            (
                State::Created,
                State::CollectingContext
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
                    | State::Blocked
            ) | (
                State::CollectingContext,
                State::Thinking
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
                    | State::Blocked
            ) | (
                State::Thinking,
                State::ValidatingTool
                    | State::AwaitingUser
                    | State::Pausing
                    | State::Cancelling
                    | State::Completed
                    | State::Failed
            ) | (
                State::ValidatingTool,
                State::Thinking
                    | State::ExecutingTool
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
                    | State::Blocked
            ) | (
                State::ExecutingTool,
                State::Observing | State::Pausing | State::Cancelling | State::Failed
            ) | (
                State::Observing,
                State::Thinking | State::Pausing | State::Cancelling | State::Failed
            ) | (
                State::AwaitingUser,
                State::Thinking | State::Pausing | State::Cancelling | State::Failed
            ) | (
                State::Pausing,
                State::Paused | State::Cancelling | State::Failed
            ) | (
                State::Paused,
                State::Thinking | State::Cancelling | State::Failed
            ) | (State::Cancelling, State::Cancelled | State::Failed)
        )
    }

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionError::run(self, next))
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolCallStateV1 {
    Proposed,
    Validating,
    Executing,
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Denied,
}

impl AgentToolCallStateV1 {
    pub(crate) const ALL: [Self; 8] = [
        Self::Proposed,
        Self::Validating,
        Self::Executing,
        Self::Completed,
        Self::Failed,
        Self::TimedOut,
        Self::Cancelled,
        Self::Denied,
    ];

    pub(crate) const TERMINAL: [Self; 5] = [
        Self::Completed,
        Self::Failed,
        Self::TimedOut,
        Self::Cancelled,
        Self::Denied,
    ];

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::TimedOut | Self::Cancelled | Self::Denied
        )
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use AgentToolCallStateV1 as State;

        matches!(
            (self, next),
            (State::Proposed, State::Validating | State::Cancelled)
                | (
                    State::Validating,
                    State::Executing | State::Denied | State::Cancelled
                )
                | (
                    State::Executing,
                    State::Completed | State::Failed | State::TimedOut | State::Cancelled
                )
        )
    }

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionError::tool(self, next))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentStateMachineKind {
    Run,
    ToolCall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentStateTransitionError {
    pub(crate) machine: AgentStateMachineKind,
    pub(crate) from: &'static str,
    pub(crate) to: &'static str,
}

impl AgentStateTransitionError {
    fn run(from: AgentRunStateV1, to: AgentRunStateV1) -> Self {
        Self {
            machine: AgentStateMachineKind::Run,
            from: run_state_name(from),
            to: run_state_name(to),
        }
    }

    fn tool(from: AgentToolCallStateV1, to: AgentToolCallStateV1) -> Self {
        Self {
            machine: AgentStateMachineKind::ToolCall,
            from: tool_state_name(from),
            to: tool_state_name(to),
        }
    }
}

impl fmt::Display for AgentStateTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let machine = match self.machine {
            AgentStateMachineKind::Run => "run",
            AgentStateMachineKind::ToolCall => "tool call",
        };
        write!(
            formatter,
            "illegal Agent {machine} state transition from {} to {}",
            self.from, self.to
        )
    }
}

fn run_state_name(state: AgentRunStateV1) -> &'static str {
    match state {
        AgentRunStateV1::Created => "created",
        AgentRunStateV1::CollectingContext => "collectingContext",
        AgentRunStateV1::Thinking => "thinking",
        AgentRunStateV1::ValidatingTool => "validatingTool",
        AgentRunStateV1::ExecutingTool => "executingTool",
        AgentRunStateV1::Observing => "observing",
        AgentRunStateV1::AwaitingUser => "awaitingUser",
        AgentRunStateV1::Pausing => "pausing",
        AgentRunStateV1::Paused => "paused",
        AgentRunStateV1::Cancelling => "cancelling",
        AgentRunStateV1::Completed => "completed",
        AgentRunStateV1::Failed => "failed",
        AgentRunStateV1::Cancelled => "cancelled",
        AgentRunStateV1::Blocked => "blocked",
    }
}

fn tool_state_name(state: AgentToolCallStateV1) -> &'static str {
    match state {
        AgentToolCallStateV1::Proposed => "proposed",
        AgentToolCallStateV1::Validating => "validating",
        AgentToolCallStateV1::Executing => "executing",
        AgentToolCallStateV1::Completed => "completed",
        AgentToolCallStateV1::Failed => "failed",
        AgentToolCallStateV1::TimedOut => "timedOut",
        AgentToolCallStateV1::Cancelled => "cancelled",
        AgentToolCallStateV1::Denied => "denied",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StateFixtureV1 {
        schema_version: u8,
        run_states: Vec<AgentRunStateV1>,
        run_terminal_states: Vec<AgentRunStateV1>,
        run_transitions: Vec<[AgentRunStateV1; 2]>,
        tool_states: Vec<AgentToolCallStateV1>,
        tool_terminal_states: Vec<AgentToolCallStateV1>,
        tool_transitions: Vec<[AgentToolCallStateV1; 2]>,
    }

    fn fixture() -> StateFixtureV1 {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v1/state-transitions.json"
        ))
        .expect("shared state transition fixture must decode")
    }

    #[test]
    fn shared_fixture_is_the_complete_transition_table() {
        let fixture = fixture();
        assert_eq!(fixture.schema_version, 1);
        assert_eq!(fixture.run_states, AgentRunStateV1::ALL);
        assert_eq!(fixture.run_terminal_states, AgentRunStateV1::TERMINAL);
        assert_eq!(fixture.tool_states, AgentToolCallStateV1::ALL);
        assert_eq!(fixture.tool_terminal_states, AgentToolCallStateV1::TERMINAL);

        let run_transitions = fixture.run_transitions.into_iter().collect::<HashSet<_>>();
        for from in AgentRunStateV1::ALL {
            for to in AgentRunStateV1::ALL {
                assert_eq!(
                    from.can_transition_to(to),
                    run_transitions.contains(&[from, to]),
                    "run transition {from:?} -> {to:?} differs from the shared fixture"
                );
            }
        }

        let tool_transitions = fixture.tool_transitions.into_iter().collect::<HashSet<_>>();
        for from in AgentToolCallStateV1::ALL {
            for to in AgentToolCallStateV1::ALL {
                assert_eq!(
                    from.can_transition_to(to),
                    tool_transitions.contains(&[from, to]),
                    "tool transition {from:?} -> {to:?} differs from the shared fixture"
                );
            }
        }
    }

    #[test]
    fn every_terminal_state_rejects_every_late_override() {
        for terminal in AgentRunStateV1::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentRunStateV1::ALL {
                assert!(!terminal.can_transition_to(late));
                assert_eq!(
                    terminal
                        .transition(late)
                        .expect_err("terminal is immutable")
                        .from,
                    run_state_name(terminal)
                );
            }
        }

        for terminal in AgentToolCallStateV1::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentToolCallStateV1::ALL {
                assert!(!terminal.can_transition_to(late));
                assert_eq!(
                    terminal
                        .transition(late)
                        .expect_err("terminal is immutable")
                        .from,
                    tool_state_name(terminal)
                );
            }
        }
    }

    #[test]
    fn unknown_state_enums_fail_closed() {
        assert!(serde_json::from_str::<AgentRunStateV1>("\"finished\"").is_err());
        assert!(serde_json::from_str::<AgentToolCallStateV1>("\"running\"").is_err());
    }
}
