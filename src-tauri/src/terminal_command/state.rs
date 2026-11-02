use super::protocol::sha as digest;
use serde::{Deserialize, Serialize};

use crate::terminal_broker::{TerminalCommandRequestedSettlement, TerminalCommandState};

pub(crate) use super::protocol::Identity as CommandIdentity;

// Source and plan are private immutable values. Do not derive Debug/Serialize:
// neither belongs in diagnostics, frontend snapshots or the submission journal.
pub(crate) struct CommandIntent {
    pub identity: CommandIdentity,
    authorization: Option<IntentAuthorization>,
    source: String,
    source_digest: String,
}

pub(crate) struct IntentAuthorization {
    pub request_id: String,
    pub capability_id: String,
    pub approved_call_id: String,
    pub frozen_target: crate::agent_runtime::AgentToolTargetNative,
}
impl std::fmt::Debug for IntentAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntentAuthorization")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for CommandIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandIntent")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

impl CommandIntent {
    pub fn new(identity: CommandIdentity, source: String) -> Result<Self, String> {
        crate::agent_runtime::validate_visible_command_input(&source)?;
        Ok(Self {
            identity,
            authorization: None,
            source_digest: digest(&source),
            source,
        })
    }
    pub fn with_authorization(mut self, authorization: Option<IntentAuthorization>) -> Self {
        self.authorization = authorization;
        self
    }
    pub fn source(&self) -> &str {
        &self.source
    }
    pub fn source_digest(&self) -> &str {
        &self.source_digest
    }
    pub fn validate_authorization_binding(
        &self,
        transport: &str,
        job: Option<&crate::terminal_jobs::PreparedShellJob>,
    ) -> Result<(), String> {
        let Some(binding) = &self.authorization else {
            return Ok(());
        };
        if binding.request_id.is_empty()
            || binding.capability_id.is_empty()
            || binding.approved_call_id.is_empty()
        {
            return Err("TERMINAL_INTENT_AUTHORIZATION_MISMATCH".into());
        }
        let matches = match &binding.frozen_target {
            crate::agent_runtime::AgentToolTargetNative::Local { session_id, .. }
            | crate::agent_runtime::AgentToolTargetNative::Remote { session_id, .. } => {
                session_id == transport
            }
            crate::agent_runtime::AgentToolTargetNative::Process {
                process_handle,
                owner_target_id,
                ..
            } => job.is_some_and(|prepared| {
                &prepared.job.process_handle == process_handle
                    && &prepared.job.owner_target_id == owner_target_id
            }),
        };
        if matches {
            Ok(())
        } else {
            Err("TERMINAL_INTENT_AUTHORIZATION_MISMATCH".into())
        }
    }
}

pub(crate) struct ExecutionPlan {
    pub native_job: Option<super::protocol::JobExecution>,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Native proof verification uses the shell; its production adapter is wired in P2"
        )
    )]
    pub shell: Option<crate::terminal_integration::TerminalShellKind>,
    pub method: ExecutionMethod,
    submitted_line: String,
    digest: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum ExecutionMethod {
    LegacyEditor,
    NativeInline,
    NativeJobLaunch,
    NativeJobControl,
}

/// Constructed only after comparison with a real private editor receipt.
/// It is intentionally neither public JSON nor frontend metadata.
pub(crate) struct FullInputProof {
    identity: CommandIdentity,
    source_digest: String,
    plan_digest: String,
}
impl std::fmt::Debug for FullInputProof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FullInputProof").finish_non_exhaustive()
    }
}

impl FullInputProof {
    fn native_plan_matches(intent:&CommandIntent,plan:&ExecutionPlan)->bool {
        let Some(shell)=plan.shell else{return false;};
        let Ok(family)=super::registration::shell_family(shell)else{return false;};
        let expected=match &plan.native_job {
            Some(job)=>super::protocol::native_shell_job_plan(intent.source(),family,job),
            None=>super::protocol::native_foreground_plan(intent.source(),family),
        };
        expected.is_ok_and(|expected|expected==plan.submitted_line())
    }
    pub fn verify_native_control(
        intent: &CommandIntent,
        plan: &ExecutionPlan,
        plan_digest: &str,
        editor_empty: bool,
    ) -> Result<Self, String> {
        if !editor_empty
            || !Self::native_plan_matches(intent,plan)
            || !matches!(
                plan.native_job,
                Some(super::protocol::JobExecution::Control { .. })
            )
            || plan_digest != plan.digest()
        {
            return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
        }
        Ok(Self {
            identity: intent.identity.clone(),
            source_digest: intent.source_digest().into(),
            plan_digest: plan_digest.into(),
        })
    }
    pub fn verify_legacy_control(
        intent: &CommandIntent,
        plan: &ExecutionPlan,
        descriptor: &str,
        buffer: &str,
    ) -> Result<Self, String> {
        if !matches!(plan.method, ExecutionMethod::NativeJobControl)
            || !buffer.is_empty()
            || descriptor.len() != 65
            || !matches!(descriptor.as_bytes()[0], b'p' | b's')
        {
            return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
        }
        Ok(Self {
            identity: intent.identity.clone(),
            source_digest: intent.source_digest().into(),
            plan_digest: plan.digest().into(),
        })
    }
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Real native proof verification is tested in P1 and wired to production in P2"
        )
    )]
    pub fn verify_native(
        intent: &CommandIntent,
        plan: &ExecutionPlan,
        source_digest: &str,
        plan_digest: &str,
        bytes: usize,
        point: usize,
        end: usize,
    ) -> Result<Self, String> {
        if !matches!(plan.method, ExecutionMethod::NativeInline)
            || !Self::native_plan_matches(intent,plan)
            || matches!(
                plan.native_job,
                Some(super::protocol::JobExecution::Control { .. })
            )
            || !plan.shell.is_some_and(|shell| super::registration::shell_family(shell).is_ok())
            || source_digest != intent.source_digest()
            || plan_digest != plan.digest()
            || bytes != intent.source().len()
            || point != bytes
            || end != bytes
        {
            return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
        }
        Ok(Self {
            identity: intent.identity.clone(),
            source_digest: source_digest.into(),
            plan_digest: plan_digest.into(),
        })
    }
    pub fn verify_editor(
        intent: &CommandIntent,
        plan: &ExecutionPlan,
        actual_buffer: &str,
    ) -> Result<Self, String> {
        if matches!(plan.method, ExecutionMethod::NativeInline)
            || actual_buffer != plan.submitted_line()
        {
            return Err("TERMINAL_INPUT_PROOF_MISMATCH".into());
        }
        Ok(Self {
            identity: intent.identity.clone(),
            source_digest: intent.source_digest().into(),
            plan_digest: plan.digest().into(),
        })
    }
    pub fn matches(&self, intent: &CommandIntent, plan: &ExecutionPlan) -> bool {
        self.identity == intent.identity
            && self.source_digest == intent.source_digest()
            && self.plan_digest == plan.digest()
    }
}

impl std::fmt::Debug for ExecutionPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionPlan").finish_non_exhaustive()
    }
}

impl ExecutionPlan {
    pub fn new(
        intent: &CommandIntent,
        submitted_line: String,
        shell: Option<crate::terminal_integration::TerminalShellKind>,
        method: ExecutionMethod,
    ) -> Self {
        // Bind the source and actual submission as distinct length-delimited values.
        Self {
            native_job: None,
            digest: super::protocol::bound_plan_digest(intent.source_digest(), &submitted_line),
            submitted_line,
            shell,
            method,
        }
    }
    pub fn submitted_line(&self) -> &str {
        &self.submitted_line
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CommandPhase {
    AwaitingReady,
    Preparing,
    Typing,
    InputConfirmed,
    SubmissionAttempted,
    Running,
    Completed,
    CancelRequested,
    Cancelled,
    Failed,
    Uncertain,
    RecoveryRequired,
}
impl CommandPhase {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Cancelled
                | Self::Failed
                | Self::Uncertain
                | Self::RecoveryRequired
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandEvent {
    Ready,
    BeginInput,
    ConfirmInput,
    AttemptSubmission,
    LegacyAttemptSubmission,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Strict NIP/1 event; production adapter is wired in P2"
        )
    )]
    Started,
    LegacyStarted,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Strict NIP/1 event; production adapter is wired in P2"
        )
    )]
    Settled,
    LegacySettled,
    RequestCancel(TerminalCommandRequestedSettlement),
    StopUnconfirmed,
    WithdrawBeforeSubmission,
    NoOwnedDraft,
    LegacyInterruptEnqueued,
    LegacyEditReturned,
    DraftCleared,
    PreparationFailed,
    ParserRejected,
    SettledUncertain,
    CaptureIncomplete,
    InputLost,
    ControlLost,
    TransportClosed,
    ApplicationExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Transition {
    Accepted,
    Idempotent,
}

#[derive(Debug)]
pub(crate) struct CommandLifecycle {
    phase: CommandPhase,
    may_have_submitted: bool,
    started: bool,
    ended: bool,
    settlement: Option<TerminalCommandRequestedSettlement>,
    submission_revoked: bool,
    draft_cleared: bool,
    legacy_interrupt_enqueued: bool,
    source_rejected: bool,
}

impl Default for CommandLifecycle {
    fn default() -> Self {
        Self {
            phase: CommandPhase::AwaitingReady,
            may_have_submitted: false,
            started: false,
            ended: false,
            settlement: None,
            submission_revoked: false,
            draft_cleared: false,
            legacy_interrupt_enqueued: false,
            source_rejected: false,
        }
    }
}

impl CommandLifecycle {
    pub fn phase(&self) -> CommandPhase {
        self.phase
    }
    pub fn may_have_submitted(&self) -> bool {
        self.may_have_submitted
    }
    pub fn started(&self) -> bool {
        self.started
    }
    pub fn ended(&self) -> bool {
        self.ended
    }
    pub fn requested_settlement(&self) -> Option<TerminalCommandRequestedSettlement> {
        self.settlement
    }
    pub fn submission_revoked(&self) -> bool {
        self.submission_revoked
    }
    pub fn draft_cleared(&self) -> bool {
        self.draft_cleared
    }
    pub fn source_rejected(&self) -> bool {
        self.source_rejected
    }
    pub fn is_terminal(&self) -> bool {
        self.phase.is_terminal()
    }
    pub fn can_edit(&self) -> bool {
        matches!(
            self.phase,
            CommandPhase::Preparing | CommandPhase::Typing | CommandPhase::InputConfirmed
        ) && !self.may_have_submitted
    }
    pub fn legacy_state(&self) -> TerminalCommandState {
        match self.phase {
            CommandPhase::Running => TerminalCommandState::Running,
            CommandPhase::Completed => TerminalCommandState::Completed,
            CommandPhase::CancelRequested if !self.submission_revoked => {
                TerminalCommandState::CancelRequested
            }
            CommandPhase::Cancelled | CommandPhase::CancelRequested => match self.settlement {
                Some(TerminalCommandRequestedSettlement::TimedOut) => {
                    TerminalCommandState::TimedOut
                }
                Some(TerminalCommandRequestedSettlement::TakenOver) => {
                    TerminalCommandState::TakenOver
                }
                _ => TerminalCommandState::Cancelled,
            },
            CommandPhase::Failed => TerminalCommandState::Failed,
            CommandPhase::Uncertain | CommandPhase::RecoveryRequired => {
                TerminalCommandState::Uncertain
            }
            _ => TerminalCommandState::Submitted,
        }
    }
    pub fn apply(&mut self, event: CommandEvent) -> Result<Transition, String> {
        use CommandEvent as E;
        use CommandPhase as P;
        let previous = self.phase;
        let facts = (
            self.phase,
            self.may_have_submitted,
            self.started,
            self.ended,
            self.settlement,
            self.submission_revoked,
            self.draft_cleared,
            self.legacy_interrupt_enqueued,
            self.source_rejected,
        );
        let next = match event {
            E::Ready if previous == P::AwaitingReady => P::Preparing,
            E::Ready if previous == P::Preparing => return Ok(Transition::Idempotent),
            E::BeginInput if self.can_edit() => P::Typing,
            E::ConfirmInput if self.can_edit() => P::InputConfirmed,
            E::AttemptSubmission if previous == P::InputConfirmed && !self.may_have_submitted => {
                self.may_have_submitted = true;
                P::SubmissionAttempted
            }
            E::LegacyAttemptSubmission if self.can_edit() => {
                self.may_have_submitted = true;
                P::SubmissionAttempted
            }
            E::Started
                if previous == P::SubmissionAttempted
                    || matches!(previous, P::CancelRequested | P::Uncertain)
                        && self.may_have_submitted
                        && !self.ended =>
            {
                self.started = true;
                if matches!(previous, P::CancelRequested | P::Uncertain) {
                    previous
                } else {
                    P::Running
                }
            }
            E::LegacyStarted
                if (!self.submission_revoked || self.may_have_submitted)
                    && matches!(
                        previous,
                        P::Preparing
                            | P::Typing
                            | P::InputConfirmed
                            | P::SubmissionAttempted
                            | P::CancelRequested
                    ) =>
            {
                // A matching legacy private S is itself submission evidence.
                self.may_have_submitted = true;
                self.started = true;
                if previous == P::CancelRequested {
                    previous
                } else {
                    P::Running
                }
            }
            E::Started | E::LegacyStarted
                if self.started && matches!(previous, P::Running | P::Uncertain) =>
            {
                return Ok(Transition::Idempotent)
            }
            E::Settled
                if self.may_have_submitted
                    && matches!(
                        previous,
                        P::SubmissionAttempted | P::Running | P::CancelRequested | P::Uncertain
                    ) =>
            {
                self.ended = true;
                if self.settlement.is_some() {
                    P::Cancelled
                } else {
                    P::Completed
                }
            }
            E::LegacySettled
                if (!self.submission_revoked || self.may_have_submitted)
                    && matches!(previous, P::Running | P::CancelRequested) =>
            {
                self.ended = true;
                if self.settlement.is_some() {
                    P::Cancelled
                } else {
                    P::Completed
                }
            }
            E::Settled | E::LegacySettled if self.ended => return Ok(Transition::Idempotent),
            E::SettledUncertain if matches!(previous, P::Running | P::CancelRequested) => {
                self.ended = true;
                P::Uncertain
            }
            E::ParserRejected if !self.is_terminal() => {
                self.source_rejected = true;
                if self.settlement.is_some() {
                    P::CancelRequested
                } else {
                    P::Failed
                }
            }
            E::RequestCancel(reason)
                if !self.is_terminal()
                    || matches!(previous, P::Uncertain | P::RecoveryRequired) && !self.ended =>
            {
                if self.settlement.is_some() {
                    return Ok(Transition::Idempotent);
                }
                self.settlement = Some(reason);
                P::CancelRequested
            }
            E::RequestCancel(_) => return Ok(Transition::Idempotent),
            E::StopUnconfirmed if previous == P::CancelRequested => {
                if self.may_have_submitted {
                    P::Uncertain
                } else {
                    P::RecoveryRequired
                }
            }
            E::WithdrawBeforeSubmission
                if previous == P::CancelRequested && !self.may_have_submitted =>
            {
                self.submission_revoked = true;
                previous
            }
            E::NoOwnedDraft
                if previous == P::CancelRequested
                    && self.submission_revoked
                    && !self.may_have_submitted =>
            {
                P::Cancelled
            }
            E::LegacyInterruptEnqueued
                if previous == P::CancelRequested
                    && self.submission_revoked
                    && !self.may_have_submitted =>
            {
                self.legacy_interrupt_enqueued = true;
                previous
            }
            E::LegacyEditReturned
                if previous == P::CancelRequested
                    && (self.legacy_interrupt_enqueued && !self.may_have_submitted
                        || self.source_rejected) =>
            {
                P::Cancelled
            }
            E::DraftCleared
                if previous == P::CancelRequested
                    && (!self.may_have_submitted || self.source_rejected) =>
            {
                self.draft_cleared = true;
                P::Cancelled
            }
            E::DraftCleared
                if !self.may_have_submitted
                    && matches!(previous, P::Uncertain | P::RecoveryRequired | P::Failed) =>
            {
                self.draft_cleared = true;
                previous
            }
            E::DraftCleared if previous == P::Cancelled => return Ok(Transition::Idempotent),
            E::PreparationFailed if !self.may_have_submitted && !self.is_terminal() => P::Failed,
            E::CaptureIncomplete if self.may_have_submitted => P::Uncertain,
            E::InputLost if !self.is_terminal() || previous == P::Uncertain => P::RecoveryRequired,
            E::ControlLost | E::TransportClosed | E::ApplicationExit if !self.is_terminal() => {
                P::Uncertain
            }
            E::ControlLost | E::TransportClosed | E::ApplicationExit => {
                return Ok(Transition::Idempotent)
            }
            _ => return Err("TERMINAL_COMMAND_EVENT_REJECTED".into()),
        };
        self.phase = next;
        Ok(
            if facts
                == (
                    self.phase,
                    self.may_have_submitted,
                    self.started,
                    self.ended,
                    self.settlement,
                    self.submission_revoked,
                    self.draft_cleared,
                    self.legacy_interrupt_enqueued,
                    self.source_rejected,
                )
            {
                Transition::Idempotent
            } else {
                Transition::Accepted
            },
        )
    }
}
