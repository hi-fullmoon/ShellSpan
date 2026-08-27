use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentRunStateV2 {
    Created,
    CollectingContext,
    Thinking,
    ValidatingTool,
    EvaluatingRisk,
    AwaitingApproval,
    ExecutingTool,
    ExecutingChange,
    VerifyingChange,
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

impl AgentRunStateV2 {
    pub(crate) const ALL: [Self; 18] = [
        Self::Created,
        Self::CollectingContext,
        Self::Thinking,
        Self::ValidatingTool,
        Self::EvaluatingRisk,
        Self::AwaitingApproval,
        Self::ExecutingTool,
        Self::ExecutingChange,
        Self::VerifyingChange,
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
        use AgentRunStateV2 as State;

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
                    | State::EvaluatingRisk
                    | State::ExecutingTool
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
                    | State::Blocked
            ) | (
                State::EvaluatingRisk,
                State::Thinking
                    | State::AwaitingApproval
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
                    | State::Blocked
            ) | (
                State::AwaitingApproval,
                State::Thinking
                    | State::ExecutingChange
                    | State::Pausing
                    | State::Cancelling
                    | State::Failed
            ) | (
                State::ExecutingTool,
                State::Observing | State::Pausing | State::Cancelling | State::Failed
            ) | (
                State::ExecutingChange,
                State::VerifyingChange | State::Pausing | State::Cancelling | State::Failed
            ) | (
                State::VerifyingChange,
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

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionErrorV2> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionErrorV2::new(
                AgentStateMachineKindV2::Run,
                run_state_name(self),
                run_state_name(next),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentToolCallStateV2 {
    Proposed,
    Validating,
    PolicyEvaluated,
    AwaitingApproval,
    Approved,
    Rejected,
    Expired,
    Revoked,
    Executing,
    AwaitingVerification,
    Verifying,
    Completed,
    Partial,
    Failed,
    TimedOut,
    Cancelled,
    UnknownEffect,
    Denied,
}

impl AgentToolCallStateV2 {
    pub(crate) const ALL: [Self; 18] = [
        Self::Proposed,
        Self::Validating,
        Self::PolicyEvaluated,
        Self::AwaitingApproval,
        Self::Approved,
        Self::Rejected,
        Self::Expired,
        Self::Revoked,
        Self::Executing,
        Self::AwaitingVerification,
        Self::Verifying,
        Self::Completed,
        Self::Partial,
        Self::Failed,
        Self::TimedOut,
        Self::Cancelled,
        Self::UnknownEffect,
        Self::Denied,
    ];

    pub(crate) const TERMINAL: [Self; 10] = [
        Self::Rejected,
        Self::Expired,
        Self::Revoked,
        Self::Completed,
        Self::Partial,
        Self::Failed,
        Self::TimedOut,
        Self::Cancelled,
        Self::UnknownEffect,
        Self::Denied,
    ];

    pub(crate) fn is_terminal(self) -> bool {
        Self::TERMINAL.contains(&self)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use AgentToolCallStateV2 as State;

        matches!(
            (self, next),
            (State::Proposed, State::Validating | State::Cancelled)
                | (
                    State::Validating,
                    State::PolicyEvaluated | State::Denied | State::Cancelled
                )
                | (
                    State::PolicyEvaluated,
                    State::AwaitingApproval | State::Executing | State::Denied | State::Cancelled
                )
                | (
                    State::AwaitingApproval,
                    State::Approved
                        | State::Rejected
                        | State::Expired
                        | State::Revoked
                        | State::Cancelled
                )
                | (
                    State::Approved,
                    State::Executing | State::Expired | State::Revoked | State::Cancelled
                )
                | (
                    State::Executing,
                    State::AwaitingVerification
                        | State::Completed
                        | State::Failed
                        | State::TimedOut
                        | State::Cancelled
                        | State::UnknownEffect
                )
                | (
                    State::AwaitingVerification,
                    State::Verifying | State::Cancelled
                )
                | (
                    State::Verifying,
                    State::Completed
                        | State::Partial
                        | State::Failed
                        | State::TimedOut
                        | State::Cancelled
                        | State::UnknownEffect
                )
        )
    }

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionErrorV2> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionErrorV2::new(
                AgentStateMachineKindV2::ToolCall,
                tool_state_name(self),
                tool_state_name(next),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentApprovalStateV2 {
    Pending,
    ConfirmationPending,
    Approved,
    Rejected,
    Expired,
    Revoked,
    Consuming,
    Consumed,
}

impl AgentApprovalStateV2 {
    pub(crate) const ALL: [Self; 8] = [
        Self::Pending,
        Self::ConfirmationPending,
        Self::Approved,
        Self::Rejected,
        Self::Expired,
        Self::Revoked,
        Self::Consuming,
        Self::Consumed,
    ];

    pub(crate) const TERMINAL: [Self; 4] =
        [Self::Rejected, Self::Expired, Self::Revoked, Self::Consumed];

    pub(crate) fn is_terminal(self) -> bool {
        Self::TERMINAL.contains(&self)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use AgentApprovalStateV2 as State;

        matches!(
            (self, next),
            (
                State::Pending,
                State::ConfirmationPending
                    | State::Approved
                    | State::Rejected
                    | State::Expired
                    | State::Revoked
                    | State::Consuming
            ) | (
                State::ConfirmationPending,
                State::Approved | State::Rejected | State::Expired | State::Revoked
            ) | (
                State::Approved,
                State::Consuming | State::Expired | State::Revoked
            ) | (State::Consuming, State::Consumed)
        )
    }

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionErrorV2> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionErrorV2::new(
                AgentStateMachineKindV2::Approval,
                approval_state_name(self),
                approval_state_name(next),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentVerificationStateV2 {
    Pending,
    Running,
    Satisfied,
    Failed,
    Inconclusive,
    TimedOut,
    Cancelled,
}

impl AgentVerificationStateV2 {
    pub(crate) const ALL: [Self; 7] = [
        Self::Pending,
        Self::Running,
        Self::Satisfied,
        Self::Failed,
        Self::Inconclusive,
        Self::TimedOut,
        Self::Cancelled,
    ];

    pub(crate) const TERMINAL: [Self; 5] = [
        Self::Satisfied,
        Self::Failed,
        Self::Inconclusive,
        Self::TimedOut,
        Self::Cancelled,
    ];

    pub(crate) fn is_terminal(self) -> bool {
        Self::TERMINAL.contains(&self)
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        use AgentVerificationStateV2 as State;

        matches!(
            (self, next),
            (State::Pending, State::Running | State::Cancelled)
                | (
                    State::Running,
                    State::Satisfied
                        | State::Failed
                        | State::Inconclusive
                        | State::TimedOut
                        | State::Cancelled
                )
        )
    }

    pub(crate) fn transition(self, next: Self) -> Result<Self, AgentStateTransitionErrorV2> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(AgentStateTransitionErrorV2::new(
                AgentStateMachineKindV2::Verification,
                verification_state_name(self),
                verification_state_name(next),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentStateMachineKindV2 {
    Run,
    ToolCall,
    Approval,
    Verification,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentStateTransitionErrorV2 {
    pub(crate) machine: AgentStateMachineKindV2,
    pub(crate) from: &'static str,
    pub(crate) to: &'static str,
}

impl AgentStateTransitionErrorV2 {
    fn new(machine: AgentStateMachineKindV2, from: &'static str, to: &'static str) -> Self {
        Self { machine, from, to }
    }
}

impl fmt::Display for AgentStateTransitionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let machine = match self.machine {
            AgentStateMachineKindV2::Run => "run",
            AgentStateMachineKindV2::ToolCall => "tool call",
            AgentStateMachineKindV2::Approval => "approval",
            AgentStateMachineKindV2::Verification => "verification",
        };
        write!(
            formatter,
            "illegal Agent v2 {machine} state transition from {} to {}",
            self.from, self.to
        )
    }
}

fn run_state_name(state: AgentRunStateV2) -> &'static str {
    match state {
        AgentRunStateV2::Created => "created",
        AgentRunStateV2::CollectingContext => "collectingContext",
        AgentRunStateV2::Thinking => "thinking",
        AgentRunStateV2::ValidatingTool => "validatingTool",
        AgentRunStateV2::EvaluatingRisk => "evaluatingRisk",
        AgentRunStateV2::AwaitingApproval => "awaitingApproval",
        AgentRunStateV2::ExecutingTool => "executingTool",
        AgentRunStateV2::ExecutingChange => "executingChange",
        AgentRunStateV2::VerifyingChange => "verifyingChange",
        AgentRunStateV2::Observing => "observing",
        AgentRunStateV2::AwaitingUser => "awaitingUser",
        AgentRunStateV2::Pausing => "pausing",
        AgentRunStateV2::Paused => "paused",
        AgentRunStateV2::Cancelling => "cancelling",
        AgentRunStateV2::Completed => "completed",
        AgentRunStateV2::Failed => "failed",
        AgentRunStateV2::Cancelled => "cancelled",
        AgentRunStateV2::Blocked => "blocked",
    }
}

fn tool_state_name(state: AgentToolCallStateV2) -> &'static str {
    match state {
        AgentToolCallStateV2::Proposed => "proposed",
        AgentToolCallStateV2::Validating => "validating",
        AgentToolCallStateV2::PolicyEvaluated => "policyEvaluated",
        AgentToolCallStateV2::AwaitingApproval => "awaitingApproval",
        AgentToolCallStateV2::Approved => "approved",
        AgentToolCallStateV2::Rejected => "rejected",
        AgentToolCallStateV2::Expired => "expired",
        AgentToolCallStateV2::Revoked => "revoked",
        AgentToolCallStateV2::Executing => "executing",
        AgentToolCallStateV2::AwaitingVerification => "awaitingVerification",
        AgentToolCallStateV2::Verifying => "verifying",
        AgentToolCallStateV2::Completed => "completed",
        AgentToolCallStateV2::Partial => "partial",
        AgentToolCallStateV2::Failed => "failed",
        AgentToolCallStateV2::TimedOut => "timedOut",
        AgentToolCallStateV2::Cancelled => "cancelled",
        AgentToolCallStateV2::UnknownEffect => "unknownEffect",
        AgentToolCallStateV2::Denied => "denied",
    }
}

fn approval_state_name(state: AgentApprovalStateV2) -> &'static str {
    match state {
        AgentApprovalStateV2::Pending => "pending",
        AgentApprovalStateV2::ConfirmationPending => "confirmationPending",
        AgentApprovalStateV2::Approved => "approved",
        AgentApprovalStateV2::Rejected => "rejected",
        AgentApprovalStateV2::Expired => "expired",
        AgentApprovalStateV2::Revoked => "revoked",
        AgentApprovalStateV2::Consuming => "consuming",
        AgentApprovalStateV2::Consumed => "consumed",
    }
}

fn verification_state_name(state: AgentVerificationStateV2) -> &'static str {
    match state {
        AgentVerificationStateV2::Pending => "pending",
        AgentVerificationStateV2::Running => "running",
        AgentVerificationStateV2::Satisfied => "satisfied",
        AgentVerificationStateV2::Failed => "failed",
        AgentVerificationStateV2::Inconclusive => "inconclusive",
        AgentVerificationStateV2::TimedOut => "timedOut",
        AgentVerificationStateV2::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StateFixtureV2 {
        schema_version: u8,
        run_states: Vec<AgentRunStateV2>,
        run_terminal_states: Vec<AgentRunStateV2>,
        run_transitions: Vec<[AgentRunStateV2; 2]>,
        tool_states: Vec<AgentToolCallStateV2>,
        tool_terminal_states: Vec<AgentToolCallStateV2>,
        tool_transitions: Vec<[AgentToolCallStateV2; 2]>,
        approval_states: Vec<AgentApprovalStateV2>,
        approval_terminal_states: Vec<AgentApprovalStateV2>,
        approval_transitions: Vec<[AgentApprovalStateV2; 2]>,
        verification_states: Vec<AgentVerificationStateV2>,
        verification_terminal_states: Vec<AgentVerificationStateV2>,
        verification_transitions: Vec<[AgentVerificationStateV2; 2]>,
    }

    fn fixture() -> StateFixtureV2 {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/state-transitions.json"
        ))
        .expect("shared v2 state transition fixture must decode")
    }

    #[test]
    fn shared_fixture_is_the_complete_v2_transition_table() {
        let fixture = fixture();
        assert_eq!(fixture.schema_version, 2);
        assert_machine(
            &fixture.run_states,
            &AgentRunStateV2::ALL,
            &fixture.run_transitions,
            AgentRunStateV2::can_transition_to,
        );
        assert_eq!(fixture.run_terminal_states, AgentRunStateV2::TERMINAL);
        assert_machine(
            &fixture.tool_states,
            &AgentToolCallStateV2::ALL,
            &fixture.tool_transitions,
            AgentToolCallStateV2::can_transition_to,
        );
        assert_eq!(fixture.tool_terminal_states, AgentToolCallStateV2::TERMINAL);
        assert_machine(
            &fixture.approval_states,
            &AgentApprovalStateV2::ALL,
            &fixture.approval_transitions,
            AgentApprovalStateV2::can_transition_to,
        );
        assert_eq!(
            fixture.approval_terminal_states,
            AgentApprovalStateV2::TERMINAL
        );
        assert_machine(
            &fixture.verification_states,
            &AgentVerificationStateV2::ALL,
            &fixture.verification_transitions,
            AgentVerificationStateV2::can_transition_to,
        );
        assert_eq!(
            fixture.verification_terminal_states,
            AgentVerificationStateV2::TERMINAL
        );
    }

    fn assert_machine<T: Copy + Eq + std::hash::Hash + fmt::Debug, const N: usize>(
        fixture_states: &[T],
        all: &[T; N],
        fixture_transitions: &[[T; 2]],
        can_transition: fn(T, T) -> bool,
    ) {
        assert_eq!(fixture_states, all);
        let transitions = fixture_transitions.iter().copied().collect::<HashSet<_>>();
        for from in *all {
            for to in *all {
                assert_eq!(
                    can_transition(from, to),
                    transitions.contains(&[from, to]),
                    "transition {from:?} -> {to:?} differs from the shared fixture"
                );
            }
        }
    }

    #[test]
    fn every_v2_terminal_state_rejects_every_late_override() {
        for terminal in AgentRunStateV2::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentRunStateV2::ALL {
                assert!(!terminal.can_transition_to(late));
                terminal
                    .transition(late)
                    .expect_err("run terminal is immutable");
            }
        }
        for terminal in AgentToolCallStateV2::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentToolCallStateV2::ALL {
                assert!(!terminal.can_transition_to(late));
                terminal
                    .transition(late)
                    .expect_err("tool terminal is immutable");
            }
        }
        for terminal in AgentApprovalStateV2::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentApprovalStateV2::ALL {
                assert!(!terminal.can_transition_to(late));
                terminal
                    .transition(late)
                    .expect_err("approval terminal is immutable");
            }
        }
        for terminal in AgentVerificationStateV2::TERMINAL {
            assert!(terminal.is_terminal());
            for late in AgentVerificationStateV2::ALL {
                assert!(!terminal.can_transition_to(late));
                terminal
                    .transition(late)
                    .expect_err("verification terminal is immutable");
            }
        }
    }

    #[test]
    fn unknown_v2_state_enums_fail_closed() {
        assert!(serde_json::from_str::<AgentRunStateV2>("\"running\"").is_err());
        assert!(serde_json::from_str::<AgentToolCallStateV2>("\"succeeded\"").is_err());
        assert!(serde_json::from_str::<AgentApprovalStateV2>("\"accepted\"").is_err());
        assert!(serde_json::from_str::<AgentVerificationStateV2>("\"complete\"").is_err());
    }
}
