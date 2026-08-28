//! Backend-authoritative orchestration for the dedicated Agent PTY.
//!
//! Model output enters only as a strict `agent-terminal/v1` proposal. This
//! coordinator owns idempotency, local policy, exact approval, audit prewrite,
//! lease fencing, observation capture, handoff, and verification obligations.
//! The checked-in production admission is intentionally blocked; deterministic
//! fake integration can exercise the complete path without connecting a model,
//! arbitrary process launcher, SSH mutation adapter, or generic write IPC.

use super::terminal_driver::TERMINAL_DRIVER_REGISTRY_VERSION_V1;
use super::terminal_observation::{
    digest_text_v1, BoundedTerminalCaptureV1, TerminalCapturedObservationV1,
    TerminalModelObservationV1,
};
use super::terminal_policy::{
    TerminalActionOutcomeV1, TerminalAuthorityContextV1, TerminalInteractionControllerV1,
    TerminalPolicyErrorCodeV1, TerminalPromptObservationInputV1,
};
use super::terminal_protocol::{
    decode_terminal_action_v1, TerminalActionV1, TerminalDriverIdV1, TerminalFixtureScenarioV1,
    TerminalProgramIdV1,
};
use crate::models::SessionManager;
use crate::terminal_lease::{
    AgentTerminalBinding, TerminalLeaseOwner, TerminalLeaseRevocationReason, TerminalLeaseSnapshot,
    TerminalLeaseState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;
use zeroize::Zeroize;

pub(crate) const AGENT_TERMINAL_POLICY_VERSION_V1: &str = "agent-terminal-policy-v1";
pub(crate) const DEFAULT_TERMINAL_APPROVAL_TTL_MS_V1: u64 = 5 * 60 * 1_000;
pub(crate) const MAX_TERMINAL_APPROVAL_TTL_MS_V1: u64 = 10 * 60 * 1_000;
const MAX_OBSERVATIONS_PER_RUN_V1: usize = 16;
const MAX_EVENTS_PER_RUN_V1: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AgentTerminalAdmissionV1 {
    pub(crate) p2_verified: bool,
    pub(crate) feature_enabled: bool,
    #[cfg(test)]
    pub(crate) fake_integration: bool,
}

pub(crate) const CURRENT_AGENT_TERMINAL_ADMISSION_V1: AgentTerminalAdmissionV1 =
    AgentTerminalAdmissionV1 {
        p2_verified: false,
        feature_enabled: false,
        #[cfg(test)]
        fake_integration: false,
    };

impl AgentTerminalAdmissionV1 {
    fn admitted(self) -> bool {
        #[cfg(test)]
        if self.fake_integration {
            return true;
        }
        self.p2_verified && self.feature_enabled
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalInteractionStateV1 {
    Proposed,
    Validating,
    EvaluatingRisk,
    AwaitingApproval,
    Approved,
    Rejected,
    Expired,
    Revoked,
    Writing,
    AwaitingObservation,
    HandoffRequired,
    Completed,
    Failed,
    Cancelled,
    UnknownEffect,
}

impl TerminalInteractionStateV1 {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Rejected
                | Self::Expired
                | Self::Revoked
                | Self::HandoffRequired
                | Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::UnknownEffect
        )
    }

    fn can_transition_to(self, next: Self) -> bool {
        use TerminalInteractionStateV1 as State;
        matches!(
            (self, next),
            (
                State::Proposed,
                State::Validating | State::Cancelled | State::Failed
            ) | (
                State::Validating,
                State::EvaluatingRisk | State::HandoffRequired | State::Cancelled | State::Failed
            ) | (
                State::EvaluatingRisk,
                State::AwaitingApproval
                    | State::Writing
                    | State::AwaitingObservation
                    | State::HandoffRequired
                    | State::Cancelled
                    | State::Failed
            ) | (
                State::AwaitingApproval,
                State::Approved
                    | State::Rejected
                    | State::Expired
                    | State::Revoked
                    | State::Cancelled
            ) | (
                State::Approved,
                State::Writing | State::Expired | State::Revoked | State::Cancelled
            ) | (
                State::Writing,
                State::AwaitingObservation
                    | State::Completed
                    | State::Failed
                    | State::Cancelled
                    | State::UnknownEffect
            ) | (
                State::AwaitingObservation,
                State::Completed
                    | State::Failed
                    | State::Cancelled
                    | State::HandoffRequired
                    | State::UnknownEffect
            )
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalRunControlStateV1 {
    Agent,
    User,
    Paused,
    Stopped,
    Disconnected,
    HandoffRequired,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalRiskSeverityV1 {
    Low,
    Medium,
    Critical,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalRiskVerdictV1 {
    AllowRegisteredStart,
    RequiresApproval,
    DenyAndHandoff,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRiskSnapshotV1 {
    pub(crate) severity: TerminalRiskSeverityV1,
    pub(crate) verdict: TerminalRiskVerdictV1,
    pub(crate) state_change: bool,
    pub(crate) policy_version: String,
    pub(crate) risk_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalApprovalStateV1 {
    Pending,
    Approved,
    Rejected,
    Expired,
    Revoked,
    Consumed,
}

impl TerminalApprovalStateV1 {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Rejected | Self::Expired | Self::Revoked | Self::Consumed
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalApprovalSnapshotV1 {
    pub(crate) approval_id: String,
    pub(crate) action_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) session_id: String,
    pub(crate) action_digest: String,
    pub(crate) driver: TerminalDriverIdV1,
    pub(crate) program: TerminalProgramIdV1,
    pub(crate) scenario: TerminalFixtureScenarioV1,
    pub(crate) observation_id: String,
    pub(crate) observation_digest: String,
    pub(crate) risk: TerminalRiskSnapshotV1,
    pub(crate) lease_epoch: u64,
    pub(crate) lease_revision: u64,
    pub(crate) issued_at_ms: u64,
    pub(crate) expires_at_ms: u64,
    pub(crate) state: TerminalApprovalStateV1,
}

#[derive(Debug, Clone)]
struct TerminalApprovalRecordV1 {
    public: TerminalApprovalSnapshotV1,
    approval_digest: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalVerificationStateV1 {
    Pending,
    Running,
    Satisfied,
    Failed,
    Inconclusive,
    Cancelled,
}

impl TerminalVerificationStateV1 {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Satisfied | Self::Failed | Self::Inconclusive | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalVerificationSnapshotV1 {
    pub(crate) obligation_id: String,
    pub(crate) action_id: String,
    pub(crate) state: TerminalVerificationStateV1,
    pub(crate) evidence_id: Option<String>,
    pub(crate) evidence_digest: Option<String>,
    pub(crate) independent: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalActionSnapshotV1 {
    pub(crate) action_id: String,
    pub(crate) action_kind: String,
    pub(crate) action_digest: String,
    pub(crate) state: TerminalInteractionStateV1,
    pub(crate) risk: Option<TerminalRiskSnapshotV1>,
    pub(crate) approval_id: Option<String>,
    pub(crate) observation_id: Option<String>,
    pub(crate) verification: Option<TerminalVerificationSnapshotV1>,
    pub(crate) verified: bool,
    pub(crate) proposed_at_ms: u64,
    pub(crate) updated_at_ms: u64,
}

#[derive(Debug, Clone)]
struct TerminalActionRecordV1 {
    action: Option<TerminalActionV1>,
    public: TerminalActionSnapshotV1,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalJournalEventV1 {
    pub(crate) schema_version: u8,
    pub(crate) run_id: String,
    pub(crate) action_id: String,
    pub(crate) sequence: u64,
    pub(crate) occurred_at_ms: u64,
    pub(crate) state: TerminalInteractionStateV1,
    pub(crate) event_digest: String,
    pub(crate) redacted_preview: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalSnapshotV1 {
    pub(crate) schema_version: u8,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) session_id: String,
    pub(crate) last_sequence: u64,
    pub(crate) control_state: TerminalRunControlStateV1,
    pub(crate) capture_epoch: u64,
    pub(crate) lease_owner: TerminalLeaseOwner,
    pub(crate) lease_state: TerminalLeaseState,
    pub(crate) lease_epoch: u64,
    pub(crate) lease_revision: u64,
    pub(crate) current_observation: Option<TerminalModelObservationV1>,
    pub(crate) actions: Vec<TerminalActionSnapshotV1>,
    pub(crate) pending_approval: Option<TerminalApprovalSnapshotV1>,
    pub(crate) events: Vec<TerminalJournalEventV1>,
}

/// Fixed audit payload. It intentionally has no raw input/output/transcript,
/// provider content, credential, challenge, token, or extensible metadata map.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalAuditEventV1 {
    pub(crate) event_id: String,
    pub(crate) run_id: String,
    pub(crate) action_id: String,
    pub(crate) sequence: u64,
    pub(crate) occurred_at_ms: u64,
    pub(crate) target_digest: String,
    pub(crate) session_id: String,
    pub(crate) state: TerminalInteractionStateV1,
    pub(crate) action_digest: String,
    pub(crate) risk_digest: Option<String>,
    pub(crate) approval_digest: Option<String>,
    pub(crate) lease_epoch: u64,
    pub(crate) lease_revision: u64,
    pub(crate) driver: Option<String>,
    pub(crate) program: Option<String>,
    pub(crate) scenario: Option<String>,
    pub(crate) event_digest: String,
    pub(crate) redacted_preview: String,
}

pub(crate) trait TerminalAuditWriterV1: Send + Sync {
    fn append(&self, event: &TerminalAuditEventV1) -> Result<(), String>;
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalVerificationRequestV1 {
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) action_id: String,
    pub(crate) obligation_id: String,
    pub(crate) action_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalIndependentEvidenceV1 {
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) obligation_id: String,
    pub(crate) observed_at_ms: u64,
    pub(crate) successful: bool,
    pub(crate) independent_read_only: bool,
    pub(crate) structured_digest: String,
}

pub(crate) trait TerminalVerifierV1: Send + Sync {
    fn verify(
        &self,
        request: &TerminalVerificationRequestV1,
    ) -> Result<TerminalIndependentEvidenceV1, String>;
}

#[derive(Default)]
pub(crate) struct BlockedTerminalVerifierV1;

impl TerminalVerifierV1 for BlockedTerminalVerifierV1 {
    fn verify(
        &self,
        _request: &TerminalVerificationRequestV1,
    ) -> Result<TerminalIndependentEvidenceV1, String> {
        Err(
            "independent terminal verifier is blocked by the P0/P1/P2 production admission gate"
                .to_string(),
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalApprovalDecisionV1 {
    Approve,
    Reject,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalResolveApprovalRequestV1 {
    pub(crate) schema_version: u8,
    pub(crate) run_id: String,
    pub(crate) approval_id: String,
    pub(crate) client_action_id: String,
    pub(crate) decision: TerminalApprovalDecisionV1,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalRunControlRequestV1 {
    pub(crate) schema_version: u8,
    pub(crate) run_id: String,
    pub(crate) client_action_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalTakeoverAndWriteRequestV1 {
    pub(crate) schema_version: u8,
    pub(crate) run_id: String,
    pub(crate) client_action_id: String,
    pub(crate) data: String,
}

impl Drop for TerminalTakeoverAndWriteRequestV1 {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CachedControlRequestV1 {
    Resolve {
        approval_id: String,
        decision: TerminalApprovalDecisionV1,
    },
    Takeover,
    ReturnControl,
    Pause,
    Stop,
}

struct TerminalRunRecordV1 {
    run_id: String,
    target_digest: String,
    binding: AgentTerminalBinding,
    lease: TerminalLeaseSnapshot,
    controller: TerminalInteractionControllerV1<SessionManager>,
    capture: BoundedTerminalCaptureV1,
    control_state: TerminalRunControlStateV1,
    actions: HashMap<String, TerminalActionRecordV1>,
    action_order: Vec<String>,
    approvals: HashMap<String, TerminalApprovalRecordV1>,
    current_observation: Option<TerminalModelObservationV1>,
    observation_sequence: u64,
    next_sequence: u64,
    events: Vec<TerminalJournalEventV1>,
    control_requests: HashMap<String, CachedControlRequestV1>,
}

impl TerminalRunRecordV1 {
    fn snapshot(&self) -> AgentTerminalSnapshotV1 {
        AgentTerminalSnapshotV1 {
            schema_version: 1,
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            session_id: self.binding.session_id.clone(),
            last_sequence: self.next_sequence.saturating_sub(1),
            control_state: self.control_state,
            capture_epoch: self.capture.capture_epoch(),
            lease_owner: self.lease.owner,
            lease_state: self.lease.state,
            lease_epoch: self.lease.epoch,
            lease_revision: self.lease.revision,
            current_observation: self.current_observation.clone(),
            actions: self
                .action_order
                .iter()
                .filter_map(|id| self.actions.get(id).map(|record| record.public.clone()))
                .collect(),
            pending_approval: self
                .approvals
                .values()
                .find(|record| record.public.state == TerminalApprovalStateV1::Pending)
                .map(|record| record.public.clone()),
            events: self.events.clone(),
        }
    }

    fn authority(&self, now_ms: u64) -> TerminalAuthorityContextV1 {
        TerminalAuthorityContextV1 {
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            binding: self.binding.clone(),
            lease_token: self.lease.token(),
            now_ms,
        }
    }

    fn append_transition(
        &mut self,
        action_id: &str,
        next: TerminalInteractionStateV1,
        occurred_at_ms: u64,
        preview: &str,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<(), TerminalCoordinatorErrorV1> {
        let record = self.actions.get(action_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::ActionNotFound,
                "terminal action was not found",
            )
        })?;
        let is_initial_proposed = record.public.state == TerminalInteractionStateV1::Proposed
            && next == TerminalInteractionStateV1::Proposed
            && !self.events.iter().any(|event| event.action_id == action_id);
        if record.public.state.is_terminal()
            || (!is_initial_proposed && !record.public.state.can_transition_to(next))
        {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidState,
                "terminal action state transition is not allowed",
            ));
        }
        let sequence = self.next_sequence;
        let event_digest = digest_tuple_v1(&[
            "terminal-event-v1",
            &self.run_id,
            action_id,
            &sequence.to_string(),
            state_name_v1(next),
            &occurred_at_ms.to_string(),
            &record.public.action_digest,
        ]);
        let approval = record
            .public
            .approval_id
            .as_deref()
            .and_then(|id| self.approvals.get(id));
        let driver_binding = active_driver_binding_v1(self).ok();
        let audit_event = TerminalAuditEventV1 {
            event_id: format!("agent-terminal-{}-{sequence}", self.run_id),
            run_id: self.run_id.clone(),
            action_id: action_id.to_string(),
            sequence,
            occurred_at_ms,
            target_digest: self.target_digest.clone(),
            session_id: self.binding.session_id.clone(),
            state: next,
            action_digest: record.public.action_digest.clone(),
            risk_digest: record
                .public
                .risk
                .as_ref()
                .map(|risk| risk.risk_digest.clone()),
            approval_digest: approval.map(|approval| approval.approval_digest.clone()),
            lease_epoch: self.lease.epoch,
            lease_revision: self.lease.revision,
            driver: driver_binding.and_then(|value| protocol_enum_name_v1(value.0)),
            program: driver_binding.and_then(|value| protocol_enum_name_v1(value.1)),
            scenario: driver_binding.and_then(|value| protocol_enum_name_v1(value.2)),
            event_digest: event_digest.clone(),
            redacted_preview: bounded_preview_v1(preview),
        };
        audit.append(&audit_event).map_err(|_| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::AuditPrewriteFailed,
                "terminal audit prewrite failed",
            )
        })?;
        self.next_sequence = sequence.checked_add(1).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::SequenceExhausted,
                "terminal journal sequence exhausted",
            )
        })?;
        let record = self
            .actions
            .get_mut(action_id)
            .expect("checked action exists");
        record.public.state = next;
        record.public.updated_at_ms = occurred_at_ms;
        self.events.push(TerminalJournalEventV1 {
            schema_version: 1,
            run_id: self.run_id.clone(),
            action_id: action_id.to_string(),
            sequence,
            occurred_at_ms,
            state: next,
            event_digest,
            redacted_preview: bounded_preview_v1(preview),
        });
        if self.events.len() > MAX_EVENTS_PER_RUN_V1 {
            self.events.remove(0);
        }
        Ok(())
    }

    fn revoke_pending_approvals(&mut self, now_ms: u64, audit: &dyn TerminalAuditWriterV1) {
        let ids = self
            .approvals
            .iter()
            .filter(|(_, record)| !record.public.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for approval_id in ids {
            let action_id = self.approvals[&approval_id].public.action_id.clone();
            self.approvals
                .get_mut(&approval_id)
                .expect("approval exists")
                .public
                .state = TerminalApprovalStateV1::Revoked;
            let state = self.actions[&action_id].public.state;
            if matches!(
                state,
                TerminalInteractionStateV1::AwaitingApproval | TerminalInteractionStateV1::Approved
            ) {
                let _ = self.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::Revoked,
                    now_ms,
                    "approval revoked by terminal control change",
                    audit,
                );
            }
        }
    }
}

#[derive(Default)]
struct TerminalCoordinatorRegistryV1 {
    runs: HashMap<String, TerminalRunRecordV1>,
    session_to_run: HashMap<String, String>,
}

pub(crate) struct AgentTerminalCoordinatorV1 {
    admission: AgentTerminalAdmissionV1,
    registry: Mutex<TerminalCoordinatorRegistryV1>,
}

impl Default for AgentTerminalCoordinatorV1 {
    fn default() -> Self {
        Self {
            admission: CURRENT_AGENT_TERMINAL_ADMISSION_V1,
            registry: Mutex::new(TerminalCoordinatorRegistryV1::default()),
        }
    }
}

impl AgentTerminalCoordinatorV1 {
    #[cfg(test)]
    fn new_fake() -> Self {
        Self {
            admission: AgentTerminalAdmissionV1 {
                p2_verified: false,
                feature_enabled: false,
                fake_integration: true,
            },
            registry: Mutex::new(TerminalCoordinatorRegistryV1::default()),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn register_interaction(
        &self,
        run_id: String,
        target_digest: String,
        lease: TerminalLeaseSnapshot,
        sessions: SessionManager,
        now_ms: u64,
        additional_secrets: Vec<String>,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        if !self.admission.admitted() {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::AdmissionBlocked,
                "Agent terminal production admission remains blocked until P0/P1/P2 are verified and the feature is explicitly enabled",
            ));
        }
        if lease.binding.run_id != run_id
            || lease.owner != TerminalLeaseOwner::Agent
            || lease.state != TerminalLeaseState::Active
            || target_digest.trim().is_empty()
        {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::BindingMismatch,
                "Agent terminal registration binding is invalid",
            ));
        }
        let binding = lease.binding.clone();
        let controller = TerminalInteractionControllerV1::new(
            run_id.clone(),
            target_digest.clone(),
            binding.clone(),
            lease.clone(),
            sessions,
        )
        .map_err(policy_to_coordinator_error_v1)?;
        let record = TerminalRunRecordV1 {
            run_id: run_id.clone(),
            target_digest,
            binding: binding.clone(),
            lease,
            controller,
            capture: BoundedTerminalCaptureV1::new(now_ms, additional_secrets),
            control_state: TerminalRunControlStateV1::Agent,
            actions: HashMap::new(),
            action_order: Vec::new(),
            approvals: HashMap::new(),
            current_observation: None,
            observation_sequence: 0,
            next_sequence: 1,
            events: Vec::new(),
            control_requests: HashMap::new(),
        };
        let snapshot = record.snapshot();
        let mut registry = self.lock_registry()?;
        if registry.runs.contains_key(&run_id)
            || registry.session_to_run.contains_key(&binding.session_id)
        {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "Agent terminal run or session is already registered",
            ));
        }
        registry
            .session_to_run
            .insert(binding.session_id, run_id.clone());
        registry.runs.insert(run_id, record);
        Ok(snapshot)
    }

    #[allow(dead_code)]
    pub(crate) fn propose_action(
        &self,
        run_id: &str,
        raw_action: &str,
        now_ms: u64,
        approval_ttl_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        let action = decode_terminal_action_v1(raw_action).map_err(|_| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidContract,
                "terminal proposal is not a strict agent-terminal/v1 action",
            )
        })?;
        let action_digest = digest_action_v1(&action);
        let action_id = action.action_id().to_string();
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        if run.control_state != TerminalRunControlStateV1::Agent {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidState,
                "Agent terminal does not currently have Agent control",
            ));
        }
        if let Some(existing) = run.actions.get(&action_id) {
            if existing.public.action_digest == action_digest {
                return Ok(run.snapshot());
            }
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal action id was replayed with different content",
            ));
        }
        let action_kind = action_kind_v1(&action).to_string();
        run.actions.insert(
            action_id.clone(),
            TerminalActionRecordV1 {
                action: Some(action.clone()),
                public: TerminalActionSnapshotV1 {
                    action_id: action_id.clone(),
                    action_kind,
                    action_digest,
                    state: TerminalInteractionStateV1::Proposed,
                    risk: None,
                    approval_id: None,
                    observation_id: action.observation_id().map(str::to_string),
                    verification: None,
                    verified: false,
                    proposed_at_ms: now_ms,
                    updated_at_ms: now_ms,
                },
            },
        );
        run.action_order.push(action_id.clone());
        if let Err(error) = run.append_transition(
            &action_id,
            TerminalInteractionStateV1::Proposed,
            now_ms,
            "strict agent-terminal/v1 proposal received",
            audit,
        ) {
            run.actions.remove(&action_id);
            run.action_order.retain(|id| id != &action_id);
            return Err(error);
        }
        run.append_transition(
            &action_id,
            TerminalInteractionStateV1::Validating,
            now_ms,
            action_kind_v1(&action),
            audit,
        )?;
        let authority = run.authority(now_ms);
        if let Err(error) = run.controller.validate_action(&authority, &action) {
            if matches!(
                error.code,
                TerminalPolicyErrorCodeV1::HandoffRequired
                    | TerminalPolicyErrorCodeV1::UnsupportedSurface
            ) {
                let lease = sessions
                    .revoke_agent_terminal(
                        &run.binding,
                        TerminalLeaseRevocationReason::HandoffRequired,
                    )
                    .map_err(|_| {
                        coordinator_error(
                            TerminalCoordinatorErrorCodeV1::LeaseRejected,
                            "terminal handoff lease revocation failed",
                        )
                    })?;
                run.lease = lease.clone();
                run.controller
                    .synchronize_lease(lease, false)
                    .map_err(policy_to_coordinator_error_v1)?;
                run.capture.set_unowned();
                run.control_state = TerminalRunControlStateV1::HandoffRequired;
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::HandoffRequired,
                    now_ms,
                    "sensitive or unsupported prompt requires user handoff",
                    audit,
                )?;
                return Ok(run.snapshot());
            }
            run.append_transition(
                &action_id,
                TerminalInteractionStateV1::Failed,
                now_ms,
                "local terminal policy rejected proposal",
                audit,
            )?;
            return Err(policy_to_coordinator_error_v1(error));
        }
        run.append_transition(
            &action_id,
            TerminalInteractionStateV1::EvaluatingRisk,
            now_ms,
            "backend local risk evaluation",
            audit,
        )?;
        let risk = local_risk_v1(&action);
        run.actions
            .get_mut(&action_id)
            .expect("action exists")
            .public
            .risk = Some(risk.clone());
        match risk.verdict {
            TerminalRiskVerdictV1::AllowRegisteredStart => {
                let outcome = run
                    .controller
                    .apply_action(&authority, &action)
                    .map_err(policy_to_coordinator_error_v1)?;
                if !matches!(outcome, TerminalActionOutcomeV1::Start(_)) {
                    return Err(coordinator_error(
                        TerminalCoordinatorErrorCodeV1::RendererRejected,
                        "registered start produced an unexpected outcome",
                    ));
                }
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::AwaitingObservation,
                    now_ms,
                    "registered fake driver start intent accepted; no production launcher connected",
                    audit,
                )?;
            }
            TerminalRiskVerdictV1::DenyAndHandoff => {
                let outcome = run
                    .controller
                    .apply_action(&authority, &action)
                    .map_err(policy_to_coordinator_error_v1)?;
                if !matches!(outcome, TerminalActionOutcomeV1::Handoff(_)) {
                    return Err(coordinator_error(
                        TerminalCoordinatorErrorCodeV1::RendererRejected,
                        "handoff action produced an unexpected outcome",
                    ));
                }
                let lease = sessions
                    .revoke_agent_terminal(
                        &run.binding,
                        TerminalLeaseRevocationReason::HandoffRequired,
                    )
                    .map_err(|_| {
                        coordinator_error(
                            TerminalCoordinatorErrorCodeV1::LeaseRejected,
                            "terminal handoff lease revocation failed",
                        )
                    })?;
                run.lease = lease.clone();
                run.controller
                    .synchronize_lease(lease, false)
                    .map_err(policy_to_coordinator_error_v1)?;
                run.capture.set_unowned();
                run.control_state = TerminalRunControlStateV1::HandoffRequired;
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::HandoffRequired,
                    now_ms,
                    "terminal control transferred to explicit user handoff",
                    audit,
                )?;
            }
            TerminalRiskVerdictV1::RequiresApproval => {
                if approval_ttl_ms == 0 || approval_ttl_ms > MAX_TERMINAL_APPROVAL_TTL_MS_V1 {
                    return Err(coordinator_error(
                        TerminalCoordinatorErrorCodeV1::InvalidContract,
                        "terminal approval TTL is outside the backend limit",
                    ));
                }
                if run
                    .approvals
                    .values()
                    .any(|record| record.public.state == TerminalApprovalStateV1::Pending)
                {
                    return Err(coordinator_error(
                        TerminalCoordinatorErrorCodeV1::InvalidState,
                        "only one terminal approval may be pending per run",
                    ));
                }
                let (driver, program, scenario) = active_driver_binding_v1(run)?;
                let observation = run.current_observation.as_ref().ok_or_else(|| {
                    coordinator_error(
                        TerminalCoordinatorErrorCodeV1::ObservationMissing,
                        "terminal input approval requires a current backend observation",
                    )
                })?;
                if action.observation_id() != Some(observation.observation_id.as_str()) {
                    return Err(coordinator_error(
                        TerminalCoordinatorErrorCodeV1::BindingMismatch,
                        "terminal approval observation binding changed",
                    ));
                }
                let approval_id = format!("terminal-approval-{}", Uuid::new_v4());
                let expires_at_ms = now_ms.checked_add(approval_ttl_ms).ok_or_else(|| {
                    coordinator_error(
                        TerminalCoordinatorErrorCodeV1::InvalidContract,
                        "terminal approval expiry overflowed",
                    )
                })?;
                let driver_name = protocol_enum_name_v1(driver).expect("driver enum is a string");
                let program_name =
                    protocol_enum_name_v1(program).expect("program enum is a string");
                let scenario_name =
                    protocol_enum_name_v1(scenario).expect("scenario enum is a string");
                let approval_digest = digest_tuple_v1(&[
                    "terminal-approval-v1",
                    &run.run_id,
                    &run.target_digest,
                    &run.binding.session_id,
                    &run.actions[&action_id].public.action_digest,
                    &driver_name,
                    &program_name,
                    &scenario_name,
                    &observation.observation_id,
                    &observation.transcript_digest,
                    &risk.risk_digest,
                    AGENT_TERMINAL_POLICY_VERSION_V1,
                    TERMINAL_DRIVER_REGISTRY_VERSION_V1,
                    &run.lease.epoch.to_string(),
                    &run.lease.revision.to_string(),
                    &now_ms.to_string(),
                    &expires_at_ms.to_string(),
                ]);
                let public = TerminalApprovalSnapshotV1 {
                    approval_id: approval_id.clone(),
                    action_id: action_id.clone(),
                    run_id: run.run_id.clone(),
                    target_digest: run.target_digest.clone(),
                    session_id: run.binding.session_id.clone(),
                    action_digest: run.actions[&action_id].public.action_digest.clone(),
                    driver,
                    program,
                    scenario,
                    observation_id: observation.observation_id.clone(),
                    observation_digest: observation.transcript_digest.clone(),
                    risk,
                    lease_epoch: run.lease.epoch,
                    lease_revision: run.lease.revision,
                    issued_at_ms: now_ms,
                    expires_at_ms,
                    state: TerminalApprovalStateV1::Pending,
                };
                run.approvals.insert(
                    approval_id.clone(),
                    TerminalApprovalRecordV1 {
                        public,
                        approval_digest,
                    },
                );
                run.actions
                    .get_mut(&action_id)
                    .expect("action exists")
                    .public
                    .approval_id = Some(approval_id);
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::AwaitingApproval,
                    now_ms,
                    "exact terminal action awaits one-time approval",
                    audit,
                )?;
            }
        }
        Ok(run.snapshot())
    }

    pub(crate) fn resolve_approval(
        &self,
        request: TerminalResolveApprovalRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        validate_control_contract_v1(request.schema_version, &request.client_action_id)?;
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(&request.run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        let cached = CachedControlRequestV1::Resolve {
            approval_id: request.approval_id.clone(),
            decision: request.decision,
        };
        if let Some(previous) = run.control_requests.get(&request.client_action_id) {
            if previous == &cached {
                return Ok(run.snapshot());
            }
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal control request id was replayed with different content",
            ));
        }
        let approval = run.approvals.get(&request.approval_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::ApprovalNotFound,
                "terminal approval was not found",
            )
        })?;
        let action_id = approval.public.action_id.clone();
        if approval.public.state != TerminalApprovalStateV1::Pending
            || run.actions[&action_id].public.state != TerminalInteractionStateV1::AwaitingApproval
        {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::ApprovalReplay,
                "terminal approval is no longer pending",
            ));
        }
        let authoritative_lease = sessions
            .terminal_lease_snapshot(&run.binding.session_id)
            .map_err(|_| {
                coordinator_error(
                    TerminalCoordinatorErrorCodeV1::LeaseRejected,
                    "terminal approval lease authority is unavailable",
                )
            })?;
        if authoritative_lease.binding != run.binding
            || authoritative_lease.owner != TerminalLeaseOwner::Agent
            || authoritative_lease.state != TerminalLeaseState::Active
            || authoritative_lease.epoch != approval.public.lease_epoch
            || authoritative_lease.revision != approval.public.lease_revision
        {
            run.lease = authoritative_lease.clone();
            run.controller
                .synchronize_lease(authoritative_lease, false)
                .map_err(policy_to_coordinator_error_v1)?;
            run.capture.set_unowned();
            run.control_state = TerminalRunControlStateV1::HandoffRequired;
            run.append_transition(
                &action_id,
                TerminalInteractionStateV1::Revoked,
                now_ms,
                "terminal approval binding changed before consumption",
                audit,
            )?;
            run.approvals
                .get_mut(&request.approval_id)
                .expect("approval exists")
                .public
                .state = TerminalApprovalStateV1::Revoked;
            run.control_requests
                .insert(request.client_action_id, cached);
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::BindingMismatch,
                "terminal approval exact lease binding changed before consumption",
            ));
        }
        run.lease = authoritative_lease;
        if now_ms >= approval.public.expires_at_ms {
            run.append_transition(
                &action_id,
                TerminalInteractionStateV1::Expired,
                now_ms,
                "terminal approval expired",
                audit,
            )?;
            run.approvals
                .get_mut(&request.approval_id)
                .expect("approval exists")
                .public
                .state = TerminalApprovalStateV1::Expired;
            run.control_requests
                .insert(request.client_action_id, cached);
            return Ok(run.snapshot());
        }
        match request.decision {
            TerminalApprovalDecisionV1::Reject => {
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::Rejected,
                    now_ms,
                    "terminal approval rejected",
                    audit,
                )?;
                run.approvals
                    .get_mut(&request.approval_id)
                    .expect("approval exists")
                    .public
                    .state = TerminalApprovalStateV1::Rejected;
            }
            TerminalApprovalDecisionV1::Approve => {
                revalidate_approval_v1(run, &request.approval_id, now_ms)?;
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::Approved,
                    now_ms,
                    "terminal approval accepted once",
                    audit,
                )?;
                run.approvals
                    .get_mut(&request.approval_id)
                    .expect("approval exists")
                    .public
                    .state = TerminalApprovalStateV1::Approved;
                // This is the required durable prewrite. No renderer output can
                // reach SessionManager unless this append succeeds.
                run.append_transition(
                    &action_id,
                    TerminalInteractionStateV1::Writing,
                    now_ms,
                    "approved semantic terminal input prewrite",
                    audit,
                )?;
                let action = run.actions[&action_id]
                    .action
                    .clone()
                    .expect("model action record has semantic action");
                let authority = run.authority(now_ms);
                match run.controller.apply_action(&authority, &action) {
                    Ok(TerminalActionOutcomeV1::InputAccepted { lease, .. }) => {
                        run.lease = lease;
                        run.approvals
                            .get_mut(&request.approval_id)
                            .expect("approval exists")
                            .public
                            .state = TerminalApprovalStateV1::Consumed;
                        let obligation_id = format!("terminal-verification-{}", Uuid::new_v4());
                        run.actions
                            .get_mut(&action_id)
                            .expect("action exists")
                            .public
                            .verification = Some(TerminalVerificationSnapshotV1 {
                            obligation_id,
                            action_id: action_id.clone(),
                            state: TerminalVerificationStateV1::Pending,
                            evidence_id: None,
                            evidence_digest: None,
                            independent: false,
                        });
                        run.append_transition(
                            &action_id,
                            TerminalInteractionStateV1::AwaitingObservation,
                            now_ms,
                            "semantic input accepted; PTY output remains untrusted and independent verification is pending",
                            audit,
                        )?;
                    }
                    Ok(_) => {
                        run.append_transition(
                            &action_id,
                            TerminalInteractionStateV1::Failed,
                            now_ms,
                            "renderer outcome did not match approved input",
                            audit,
                        )?;
                    }
                    Err(error) => {
                        // Once Writing was durably prewritten, a process crash or
                        // transport ambiguity must never cause automatic replay.
                        let terminal = if matches!(
                            error.code,
                            TerminalPolicyErrorCodeV1::WriterRejected
                                | TerminalPolicyErrorCodeV1::WriterLeaseMismatch
                        ) {
                            TerminalInteractionStateV1::UnknownEffect
                        } else {
                            TerminalInteractionStateV1::Failed
                        };
                        if terminal == TerminalInteractionStateV1::UnknownEffect {
                            if let Ok(lease) =
                                sessions.terminal_lease_snapshot(&run.binding.session_id)
                            {
                                run.lease = lease.clone();
                                let _ = run.controller.synchronize_lease(lease, false);
                            }
                            run.capture.set_unowned();
                            run.control_state = TerminalRunControlStateV1::HandoffRequired;
                        }
                        run.append_transition(
                            &action_id,
                            terminal,
                            now_ms,
                            "terminal write failed closed and will not be replayed",
                            audit,
                        )?;
                    }
                }
            }
        }
        run.control_requests
            .insert(request.client_action_id, cached);
        Ok(run.snapshot())
    }

    pub(crate) fn ingest_output(
        &self,
        session_id: &str,
        chunk: &str,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<Option<TerminalModelObservationV1>, TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run_id) = registry.session_to_run.get(session_id).cloned() else {
            return Ok(None);
        };
        let run = registry
            .runs
            .get_mut(&run_id)
            .expect("session index is valid");
        if !run.capture.ingest(chunk, now_ms) {
            return Ok(None);
        }
        if run.capture.should_handoff_immediately() {
            let Some(observation) = finish_observation_v1(run, now_ms)? else {
                return Ok(None);
            };
            let lease = sessions
                .revoke_agent_terminal(&run.binding, TerminalLeaseRevocationReason::HandoffRequired)
                .map_err(|_| {
                    coordinator_error(
                        TerminalCoordinatorErrorCodeV1::LeaseRejected,
                        "sensitive terminal output lease revocation failed",
                    )
                })?;
            run.lease = lease.clone();
            run.controller
                .synchronize_lease(lease, false)
                .map_err(policy_to_coordinator_error_v1)?;
            run.capture.set_unowned();
            run.control_state = TerminalRunControlStateV1::HandoffRequired;
            let action_id = create_backend_safety_action_v1(run, now_ms, &observation);
            run.append_transition(
                &action_id,
                TerminalInteractionStateV1::HandoffRequired,
                now_ms,
                "local output detector revoked Agent control for sensitive or unsupported interaction",
                audit,
            )?;
            return Ok(Some(observation));
        }
        Ok(None)
    }

    /// Flushes the current bounded capture at a driver/quiet boundary. Unknown
    /// prompts fail closed into a real lease-revoking handoff.
    #[allow(dead_code)]
    pub(crate) fn finish_observation(
        &self,
        run_id: &str,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<Option<TerminalModelObservationV1>, TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        let Some(observation) = finish_observation_v1(run, now_ms)? else {
            return Ok(None);
        };
        if observation.prompt_class == super::terminal_policy::TerminalPromptClassV1::Unknown
            || observation.surface != super::terminal_policy::TerminalPromptSurfaceV1::LinePrompt
        {
            let lease = sessions
                .revoke_agent_terminal(&run.binding, TerminalLeaseRevocationReason::HandoffRequired)
                .map_err(|_| {
                    coordinator_error(
                        TerminalCoordinatorErrorCodeV1::LeaseRejected,
                        "unknown terminal prompt lease revocation failed",
                    )
                })?;
            run.lease = lease.clone();
            run.controller
                .synchronize_lease(lease, false)
                .map_err(policy_to_coordinator_error_v1)?;
            run.capture.set_unowned();
            run.control_state = TerminalRunControlStateV1::HandoffRequired;
            let action_id = create_backend_safety_action_v1(run, now_ms, &observation);
            run.append_transition(
                &action_id,
                TerminalInteractionStateV1::HandoffRequired,
                now_ms,
                "unknown terminal interaction requires user handoff",
                audit,
            )?;
        } else {
            complete_observed_action_v1(run, &observation, now_ms, audit)?;
        }
        Ok(Some(observation))
    }

    pub(crate) fn verify_pending_action(
        &self,
        run_id: &str,
        action_id: &str,
        now_ms: u64,
        verifier: &dyn TerminalVerifierV1,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        let action = run.actions.get_mut(action_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::ActionNotFound,
                "terminal action was not found",
            )
        })?;
        if action.public.state != TerminalInteractionStateV1::AwaitingObservation
            || action.public.observation_id.is_none()
        {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidState,
                "terminal verification requires a completed PTY observation boundary",
            ));
        }
        let verification = action.public.verification.as_mut().ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::VerificationMissing,
                "state-changing terminal input has no verification obligation",
            )
        })?;
        if verification.state.is_terminal() {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal verification obligation is already terminal",
            ));
        }
        verification.state = TerminalVerificationStateV1::Running;
        let request = TerminalVerificationRequestV1 {
            run_id: run.run_id.clone(),
            target_digest: run.target_digest.clone(),
            action_id: action_id.to_string(),
            obligation_id: verification.obligation_id.clone(),
            action_digest: action.public.action_digest.clone(),
        };
        let result = verifier.verify(&request);
        let action = run.actions.get_mut(action_id).expect("action exists");
        let verification = action
            .public
            .verification
            .as_mut()
            .expect("verification exists");
        match result {
            Ok(evidence)
                if evidence.run_id == run.run_id
                    && evidence.target_digest == run.target_digest
                    && evidence.obligation_id == verification.obligation_id
                    && evidence.independent_read_only
                    && evidence.successful
                    && !evidence.evidence_id.is_empty()
                    && evidence.structured_digest.starts_with("sha256-v1:") =>
            {
                verification.state = TerminalVerificationStateV1::Satisfied;
                verification.evidence_id = Some(evidence.evidence_id);
                verification.evidence_digest = Some(evidence.structured_digest);
                verification.independent = true;
                action.public.verified = true;
                run.append_transition(
                    action_id,
                    TerminalInteractionStateV1::Completed,
                    now_ms,
                    "independent read-only structured verifier satisfied the obligation",
                    audit,
                )?;
            }
            Ok(evidence) => {
                verification.state = TerminalVerificationStateV1::Failed;
                verification.evidence_id = if evidence.evidence_id.is_empty() {
                    None
                } else {
                    Some(evidence.evidence_id)
                };
                verification.evidence_digest = None;
                verification.independent = false;
                action.public.verified = false;
                run.append_transition(
                    action_id,
                    TerminalInteractionStateV1::Failed,
                    now_ms,
                    "verification evidence was not independent, structured, successful, or correctly bound",
                    audit,
                )?;
            }
            Err(_) => {
                verification.state = TerminalVerificationStateV1::Inconclusive;
                verification.independent = false;
                action.public.verified = false;
                run.append_transition(
                    action_id,
                    TerminalInteractionStateV1::Failed,
                    now_ms,
                    "independent verification was unavailable; PTY output cannot verify success",
                    audit,
                )?;
            }
        }
        Ok(run.snapshot())
    }

    pub(crate) fn takeover_and_write(
        &self,
        mut request: TerminalTakeoverAndWriteRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        validate_control_contract_v1(request.schema_version, &request.client_action_id)?;
        if request.data.is_empty() || request.data.len() > 16 * 1024 || request.data.contains('\0')
        {
            request.data.zeroize();
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidContract,
                "user takeover input is empty, oversized, or contains NUL",
            ));
        }
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(&request.run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        if let Some(previous) = run.control_requests.get(&request.client_action_id) {
            request.data.zeroize();
            if previous == &CachedControlRequestV1::Takeover {
                return Ok(run.snapshot());
            }
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal control request id was replayed with different content",
            ));
        }
        let takeover_action_id = format!("user-takeover-{}", request.client_action_id);
        if run.actions.contains_key(&takeover_action_id) {
            request.data.zeroize();
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "user takeover was already prewritten and cannot be replayed",
            ));
        }
        // Prewrite only the existence and exact run binding of this dedicated
        // user-control operation. The raw user string is deliberately absent
        // from the digest, preview, action record, journal, and audit payload.
        let takeover_digest = digest_tuple_v1(&[
            "terminal-user-takeover-v1",
            &run.run_id,
            &run.target_digest,
            &run.binding.session_id,
            &request.client_action_id,
            &run.lease.epoch.to_string(),
            &run.lease.revision.to_string(),
        ]);
        run.actions.insert(
            takeover_action_id.clone(),
            TerminalActionRecordV1 {
                action: None,
                public: TerminalActionSnapshotV1 {
                    action_id: takeover_action_id.clone(),
                    action_kind: "terminal.userTakeoverAndWrite".to_string(),
                    action_digest: takeover_digest,
                    state: TerminalInteractionStateV1::EvaluatingRisk,
                    risk: None,
                    approval_id: None,
                    observation_id: None,
                    verification: None,
                    verified: false,
                    proposed_at_ms: now_ms,
                    updated_at_ms: now_ms,
                },
            },
        );
        run.action_order.push(takeover_action_id.clone());
        run.append_transition(
            &takeover_action_id,
            TerminalInteractionStateV1::Writing,
            now_ms,
            "atomic user takeover and first input prewrite; raw user input omitted",
            audit,
        )?;
        // The raw string crosses only this dedicated call and SessionManager's
        // atomic owner-transfer+first-write seam. It is cleared immediately and
        // is never copied into a record, event, audit payload, or snapshot.
        let data = std::mem::take(&mut request.data);
        let lease = match sessions.take_over_agent_pty_and_write(&run.binding, data) {
            Ok(lease) => lease,
            Err(_) => {
                let _ = run.append_transition(
                    &takeover_action_id,
                    TerminalInteractionStateV1::UnknownEffect,
                    now_ms,
                    "atomic takeover writer failed; input effect is unknown and will not replay",
                    audit,
                );
                return Err(coordinator_error(
                    TerminalCoordinatorErrorCodeV1::LeaseRejected,
                    "user takeover and first write failed closed",
                ));
            }
        };
        run.lease = lease.clone();
        run.controller
            .synchronize_lease(lease, false)
            .map_err(policy_to_coordinator_error_v1)?;
        run.capture.take_over_by_user();
        run.control_state = TerminalRunControlStateV1::User;
        run.revoke_pending_approvals(now_ms, audit);
        run.append_transition(
            &takeover_action_id,
            TerminalInteractionStateV1::Completed,
            now_ms,
            "user ownership transfer and first input completed; raw user input omitted",
            audit,
        )?;
        run.control_requests.insert(
            std::mem::take(&mut request.client_action_id),
            CachedControlRequestV1::Takeover,
        );
        Ok(run.snapshot())
    }

    pub(crate) fn return_control(
        &self,
        request: TerminalRunControlRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        validate_control_contract_v1(request.schema_version, &request.client_action_id)?;
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(&request.run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        if let Some(previous) = run.control_requests.get(&request.client_action_id) {
            if previous == &CachedControlRequestV1::ReturnControl {
                return Ok(run.snapshot());
            }
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal control request id was replayed with different content",
            ));
        }
        let return_action_id = format!("user-return-{}", request.client_action_id);
        if run.actions.contains_key(&return_action_id) {
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "return-control operation was already prewritten and cannot be replayed",
            ));
        }
        let action_digest = digest_tuple_v1(&[
            "terminal-user-return-v1",
            &run.run_id,
            &run.target_digest,
            &run.binding.session_id,
            &request.client_action_id,
            &run.lease.epoch.to_string(),
            &run.lease.revision.to_string(),
        ]);
        run.actions.insert(
            return_action_id.clone(),
            TerminalActionRecordV1 {
                action: None,
                public: TerminalActionSnapshotV1 {
                    action_id: return_action_id.clone(),
                    action_kind: "terminal.returnControl".to_string(),
                    action_digest,
                    state: TerminalInteractionStateV1::EvaluatingRisk,
                    risk: None,
                    approval_id: None,
                    observation_id: None,
                    verification: None,
                    verified: false,
                    proposed_at_ms: now_ms,
                    updated_at_ms: now_ms,
                },
            },
        );
        run.action_order.push(return_action_id.clone());
        run.append_transition(
            &return_action_id,
            TerminalInteractionStateV1::Writing,
            now_ms,
            "explicit return-control authority prewrite",
            audit,
        )?;
        let lease = match sessions.return_agent_pty_control(&run.binding) {
            Ok(lease) => lease,
            Err(_) => {
                let _ = run.append_transition(
                    &return_action_id,
                    TerminalInteractionStateV1::UnknownEffect,
                    now_ms,
                    "return-control authority effect is unknown and will not replay",
                    audit,
                );
                return Err(coordinator_error(
                    TerminalCoordinatorErrorCodeV1::LeaseRejected,
                    "explicit return of Agent terminal control failed closed",
                ));
            }
        };
        run.capture.return_to_agent(now_ms).map_err(|_| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidState,
                "terminal capture was not user-owned",
            )
        })?;
        run.lease = lease.clone();
        run.controller
            .synchronize_lease(lease, true)
            .map_err(policy_to_coordinator_error_v1)?;
        run.current_observation = None;
        run.control_state = TerminalRunControlStateV1::Agent;
        run.append_transition(
            &return_action_id,
            TerminalInteractionStateV1::Completed,
            now_ms,
            "explicit return-control authority completed after capture rotation",
            audit,
        )?;
        run.control_requests.insert(
            request.client_action_id,
            CachedControlRequestV1::ReturnControl,
        );
        Ok(run.snapshot())
    }

    pub(crate) fn pause(
        &self,
        request: TerminalRunControlRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        self.revoke_control(
            request,
            now_ms,
            sessions,
            audit,
            CachedControlRequestV1::Pause,
            TerminalLeaseRevocationReason::Paused,
            TerminalRunControlStateV1::Paused,
        )
    }

    pub(crate) fn stop(
        &self,
        request: TerminalRunControlRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        self.revoke_control(
            request,
            now_ms,
            sessions,
            audit,
            CachedControlRequestV1::Stop,
            TerminalLeaseRevocationReason::Stopped,
            TerminalRunControlStateV1::Stopped,
        )
    }

    fn revoke_control(
        &self,
        request: TerminalRunControlRequestV1,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
        cached: CachedControlRequestV1,
        reason: TerminalLeaseRevocationReason,
        control_state: TerminalRunControlStateV1,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        validate_control_contract_v1(request.schema_version, &request.client_action_id)?;
        // Lease revocation occurs before any coordinator state or approval
        // mutation, fencing every later Agent write even if journaling fails.
        let mut registry = self.lock_registry()?;
        let run = registry.runs.get_mut(&request.run_id).ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::RunNotFound,
                "Agent terminal run was not found",
            )
        })?;
        if let Some(previous) = run.control_requests.get(&request.client_action_id) {
            if previous == &cached {
                return Ok(run.snapshot());
            }
            return Err(coordinator_error(
                TerminalCoordinatorErrorCodeV1::Replay,
                "terminal control request id was replayed with different content",
            ));
        }
        let lease = sessions
            .revoke_agent_terminal(&run.binding, reason)
            .map_err(|_| {
                coordinator_error(
                    TerminalCoordinatorErrorCodeV1::LeaseRejected,
                    "terminal lifecycle lease revocation failed",
                )
            })?;
        run.lease = lease.clone();
        run.controller
            .synchronize_lease(lease, false)
            .map_err(policy_to_coordinator_error_v1)?;
        run.capture.set_unowned();
        run.control_state = control_state;
        run.revoke_pending_approvals(now_ms, audit);
        let active_ids = run
            .actions
            .iter()
            .filter(|(_, record)| !record.public.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for action_id in active_ids {
            let current = run.actions[&action_id].public.state;
            let next = if matches!(
                current,
                TerminalInteractionStateV1::Writing
                    | TerminalInteractionStateV1::AwaitingObservation
            ) {
                TerminalInteractionStateV1::UnknownEffect
            } else if current.can_transition_to(TerminalInteractionStateV1::Cancelled) {
                TerminalInteractionStateV1::Cancelled
            } else {
                continue;
            };
            let _ = run.append_transition(
                &action_id,
                next,
                now_ms,
                "terminal lifecycle control revoked further Agent input",
                audit,
            );
            if let Some(verification) = run
                .actions
                .get_mut(&action_id)
                .and_then(|record| record.public.verification.as_mut())
            {
                if !verification.state.is_terminal() {
                    verification.state = TerminalVerificationStateV1::Cancelled;
                }
            }
        }
        run.control_requests
            .insert(request.client_action_id, cached);
        Ok(run.snapshot())
    }

    pub(crate) fn handle_disconnect(
        &self,
        session_id: &str,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<(), TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run_id) = registry.session_to_run.get(session_id).cloned() else {
            return Ok(());
        };
        let run = registry
            .runs
            .get_mut(&run_id)
            .expect("session index is valid");
        let lease = sessions.terminal_lease_snapshot(session_id).map_err(|_| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::LeaseRejected,
                "disconnected terminal lease snapshot is unavailable",
            )
        })?;
        run.lease = lease.clone();
        run.controller
            .synchronize_lease(lease, false)
            .map_err(policy_to_coordinator_error_v1)?;
        run.capture.set_unowned();
        run.control_state = TerminalRunControlStateV1::Disconnected;
        run.revoke_pending_approvals(now_ms, audit);
        let active_ids = run
            .actions
            .iter()
            .filter(|(_, record)| !record.public.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for action_id in active_ids {
            let current = run.actions[&action_id].public.state;
            let next = if matches!(
                current,
                TerminalInteractionStateV1::Writing
                    | TerminalInteractionStateV1::AwaitingObservation
            ) {
                TerminalInteractionStateV1::UnknownEffect
            } else if current.can_transition_to(TerminalInteractionStateV1::Cancelled) {
                TerminalInteractionStateV1::Cancelled
            } else {
                continue;
            };
            let _ = run.append_transition(
                &action_id,
                next,
                now_ms,
                "terminal disconnect made pending effect observation unknown",
                audit,
            );
        }
        Ok(())
    }

    /// Reconnect is deliberately observation-only: it never calls the lease
    /// grant path. A later explicit return-control request is still required.
    pub(crate) fn handle_reconnect(
        &self,
        session_id: &str,
        sessions: &SessionManager,
    ) -> Result<(), TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let Some(run_id) = registry.session_to_run.get(session_id).cloned() else {
            return Ok(());
        };
        let run = registry
            .runs
            .get_mut(&run_id)
            .expect("session index is valid");
        let lease = sessions
            .mark_agent_session_reconnected(session_id)
            .map_err(|_| {
                coordinator_error(
                    TerminalCoordinatorErrorCodeV1::LeaseRejected,
                    "reconnected terminal lease could not be fenced",
                )
            })?;
        run.lease = lease.clone();
        run.controller
            .synchronize_lease(lease, false)
            .map_err(policy_to_coordinator_error_v1)?;
        run.capture.set_unowned();
        run.control_state = TerminalRunControlStateV1::Disconnected;
        Ok(())
    }

    /// Mirrors already-revoked SessionManager authority into every run before
    /// process exit. No run, approval, or proposal is reconstructed on the
    /// next launch; persisted in-flight effects recover only as unknownEffect.
    pub(crate) fn handle_application_exit_after_revoke(
        &self,
        now_ms: u64,
        sessions: &SessionManager,
        audit: &dyn TerminalAuditWriterV1,
    ) -> Result<usize, TerminalCoordinatorErrorV1> {
        let mut registry = self.lock_registry()?;
        let mut stopped = 0usize;
        for run in registry.runs.values_mut() {
            let lease = sessions
                .terminal_lease_snapshot(&run.binding.session_id)
                .map_err(|_| {
                    coordinator_error(
                        TerminalCoordinatorErrorCodeV1::LeaseRejected,
                        "application-exit lease snapshot is unavailable",
                    )
                })?;
            run.lease = lease.clone();
            run.controller
                .synchronize_lease(lease, false)
                .map_err(policy_to_coordinator_error_v1)?;
            run.capture.set_unowned();
            run.control_state = TerminalRunControlStateV1::Stopped;
            run.revoke_pending_approvals(now_ms, audit);
            let active_ids = run
                .actions
                .iter()
                .filter(|(_, record)| !record.public.state.is_terminal())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for action_id in active_ids {
                let current = run.actions[&action_id].public.state;
                let next = if matches!(
                    current,
                    TerminalInteractionStateV1::Writing
                        | TerminalInteractionStateV1::AwaitingObservation
                ) {
                    TerminalInteractionStateV1::UnknownEffect
                } else if current.can_transition_to(TerminalInteractionStateV1::Cancelled) {
                    TerminalInteractionStateV1::Cancelled
                } else {
                    continue;
                };
                let _ = run.append_transition(
                    &action_id,
                    next,
                    now_ms,
                    "application exit revoked terminal control and disabled replay",
                    audit,
                );
            }
            stopped += 1;
        }
        Ok(stopped)
    }

    pub(crate) fn snapshot(
        &self,
        run_id: &str,
    ) -> Result<AgentTerminalSnapshotV1, TerminalCoordinatorErrorV1> {
        let registry = self.lock_registry()?;
        registry
            .runs
            .get(run_id)
            .map(TerminalRunRecordV1::snapshot)
            .ok_or_else(|| {
                coordinator_error(
                    TerminalCoordinatorErrorCodeV1::RunNotFound,
                    "Agent terminal run was not found",
                )
            })
    }

    fn lock_registry(
        &self,
    ) -> Result<MutexGuard<'_, TerminalCoordinatorRegistryV1>, TerminalCoordinatorErrorV1> {
        self.registry.lock().map_err(|_| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::LockUnavailable,
                "Agent terminal coordinator lock is unavailable",
            )
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalCoordinatorErrorCodeV1 {
    AdmissionBlocked,
    InvalidContract,
    RunNotFound,
    ActionNotFound,
    ApprovalNotFound,
    ApprovalReplay,
    ApprovalExpired,
    BindingMismatch,
    ObservationMissing,
    VerificationMissing,
    InvalidState,
    Replay,
    AuditPrewriteFailed,
    LeaseRejected,
    RendererRejected,
    SequenceExhausted,
    LockUnavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCoordinatorErrorV1 {
    pub(crate) code: TerminalCoordinatorErrorCodeV1,
    pub(crate) message: String,
}

impl TerminalCoordinatorErrorV1 {
    pub(crate) fn invalid_contract(message: impl Into<String>) -> Self {
        coordinator_error(TerminalCoordinatorErrorCodeV1::InvalidContract, message)
    }
}

impl fmt::Display for TerminalCoordinatorErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn coordinator_error(
    code: TerminalCoordinatorErrorCodeV1,
    message: impl Into<String>,
) -> TerminalCoordinatorErrorV1 {
    TerminalCoordinatorErrorV1 {
        code,
        message: message.into(),
    }
}

fn policy_to_coordinator_error_v1(
    error: super::terminal_policy::TerminalPolicyErrorV1,
) -> TerminalCoordinatorErrorV1 {
    let code = match error.code {
        TerminalPolicyErrorCodeV1::BindingMismatch
        | TerminalPolicyErrorCodeV1::ContextRunMismatch
        | TerminalPolicyErrorCodeV1::TargetMismatch
        | TerminalPolicyErrorCodeV1::LeaseMismatch => {
            TerminalCoordinatorErrorCodeV1::BindingMismatch
        }
        TerminalPolicyErrorCodeV1::Replay | TerminalPolicyErrorCodeV1::ObservationReplay => {
            TerminalCoordinatorErrorCodeV1::Replay
        }
        TerminalPolicyErrorCodeV1::RendererRejected => {
            TerminalCoordinatorErrorCodeV1::RendererRejected
        }
        TerminalPolicyErrorCodeV1::WriterRejected
        | TerminalPolicyErrorCodeV1::WriterLeaseMismatch
        | TerminalPolicyErrorCodeV1::LeaseNotAgentOwned => {
            TerminalCoordinatorErrorCodeV1::LeaseRejected
        }
        _ => TerminalCoordinatorErrorCodeV1::InvalidState,
    };
    coordinator_error(code, error.message)
}

fn validate_control_contract_v1(
    schema_version: u8,
    client_action_id: &str,
) -> Result<(), TerminalCoordinatorErrorV1> {
    if schema_version != 1
        || client_action_id.is_empty()
        || client_action_id.len() > 128
        || !client_action_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err(coordinator_error(
            TerminalCoordinatorErrorCodeV1::InvalidContract,
            "terminal control request contract is invalid",
        ));
    }
    Ok(())
}

fn action_kind_v1(action: &TerminalActionV1) -> &'static str {
    match action {
        TerminalActionV1::Start(_) => "terminal.start",
        TerminalActionV1::Respond(_) => "terminal.respond",
        TerminalActionV1::Key(_) => "terminal.key",
        TerminalActionV1::Handoff(_) => "terminal.handoff",
    }
}

fn local_risk_v1(action: &TerminalActionV1) -> TerminalRiskSnapshotV1 {
    let (severity, verdict, state_change) = match action {
        TerminalActionV1::Start(_) => (
            TerminalRiskSeverityV1::Low,
            TerminalRiskVerdictV1::AllowRegisteredStart,
            false,
        ),
        TerminalActionV1::Respond(_) | TerminalActionV1::Key(_) => (
            TerminalRiskSeverityV1::Medium,
            TerminalRiskVerdictV1::RequiresApproval,
            true,
        ),
        TerminalActionV1::Handoff(_) => (
            TerminalRiskSeverityV1::Critical,
            TerminalRiskVerdictV1::DenyAndHandoff,
            false,
        ),
    };
    let risk_digest = digest_tuple_v1(&[
        "terminal-risk-v1",
        action_kind_v1(action),
        &format!("{severity:?}"),
        &format!("{verdict:?}"),
        if state_change {
            "stateChange"
        } else {
            "noChange"
        },
        AGENT_TERMINAL_POLICY_VERSION_V1,
        TERMINAL_DRIVER_REGISTRY_VERSION_V1,
    ]);
    TerminalRiskSnapshotV1 {
        severity,
        verdict,
        state_change,
        policy_version: AGENT_TERMINAL_POLICY_VERSION_V1.to_string(),
        risk_digest,
    }
}

fn active_driver_binding_v1(
    run: &TerminalRunRecordV1,
) -> Result<
    (
        TerminalDriverIdV1,
        TerminalProgramIdV1,
        TerminalFixtureScenarioV1,
    ),
    TerminalCoordinatorErrorV1,
> {
    run.action_order
        .iter()
        .filter_map(|id| run.actions.get(id))
        .find_map(|record| match record.action.as_ref() {
            Some(TerminalActionV1::Start(start)) => {
                Some((start.driver, start.program, start.arguments.scenario))
            }
            _ => None,
        })
        .ok_or_else(|| {
            coordinator_error(
                TerminalCoordinatorErrorCodeV1::InvalidState,
                "terminal driver has not been started",
            )
        })
}

fn revalidate_approval_v1(
    run: &TerminalRunRecordV1,
    approval_id: &str,
    now_ms: u64,
) -> Result<(), TerminalCoordinatorErrorV1> {
    let approval = run.approvals.get(approval_id).ok_or_else(|| {
        coordinator_error(
            TerminalCoordinatorErrorCodeV1::ApprovalNotFound,
            "terminal approval was not found",
        )
    })?;
    if now_ms >= approval.public.expires_at_ms {
        return Err(coordinator_error(
            TerminalCoordinatorErrorCodeV1::ApprovalExpired,
            "terminal approval expired before consumption",
        ));
    }
    let action = run.actions.get(&approval.public.action_id).ok_or_else(|| {
        coordinator_error(
            TerminalCoordinatorErrorCodeV1::ActionNotFound,
            "approved terminal action was not found",
        )
    })?;
    let observation = run.current_observation.as_ref().ok_or_else(|| {
        coordinator_error(
            TerminalCoordinatorErrorCodeV1::ObservationMissing,
            "approved terminal observation is no longer current",
        )
    })?;
    if run.control_state != TerminalRunControlStateV1::Agent
        || run.lease.owner != TerminalLeaseOwner::Agent
        || run.lease.state != TerminalLeaseState::Active
        || action.public.action_digest != approval.public.action_digest
        || run.run_id != approval.public.run_id
        || run.target_digest != approval.public.target_digest
        || run.binding.session_id != approval.public.session_id
        || run.lease.epoch != approval.public.lease_epoch
        || run.lease.revision != approval.public.lease_revision
        || observation.observation_id != approval.public.observation_id
        || observation.transcript_digest != approval.public.observation_digest
        || action.public.risk.as_ref().map(|risk| &risk.risk_digest)
            != Some(&approval.public.risk.risk_digest)
    {
        return Err(coordinator_error(
            TerminalCoordinatorErrorCodeV1::BindingMismatch,
            "terminal approval exact binding changed before consumption",
        ));
    }
    Ok(())
}

fn finish_observation_v1(
    run: &mut TerminalRunRecordV1,
    now_ms: u64,
) -> Result<Option<TerminalModelObservationV1>, TerminalCoordinatorErrorV1> {
    let Some(captured) = run.capture.finish(now_ms) else {
        return Ok(None);
    };
    run.observation_sequence = run.observation_sequence.checked_add(1).ok_or_else(|| {
        coordinator_error(
            TerminalCoordinatorErrorCodeV1::SequenceExhausted,
            "terminal observation sequence exhausted",
        )
    })?;
    let observation_id = format!(
        "terminal-observation-{}-{}",
        captured.capture_epoch, run.observation_sequence
    );
    let prompt_text = captured
        .redacted_transcript
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(&captured.redacted_transcript)
        .chars()
        .take(4_096)
        .collect::<String>();
    let input = TerminalPromptObservationInputV1 {
        observation_id: observation_id.clone(),
        evidence_id: format!("untrusted-pty-{}", run.observation_sequence),
        run_id: run.run_id.clone(),
        target_digest: run.target_digest.clone(),
        binding: run.binding.clone(),
        sequence: run.observation_sequence,
        observed_at_ms: now_ms,
        surface: captured.surface,
        claimed_class: captured.prompt_class,
        untrusted_prompt_text: prompt_text,
    };
    let authority = run.authority(now_ms);
    // The Rust capture remains useful for an immediate safety handoff even if
    // no driver has started yet. Failing to project it into the phase-2 driver
    // controller only makes future automation impossible; it must never delay
    // lease revocation for sensitive/unsupported output.
    let _ = run.controller.record_prompt_observation(&authority, input);
    let model = model_observation_v1(observation_id, captured);
    run.current_observation = Some(model.clone());
    // The current snapshot is bounded even across a panel remount; old model
    // observations live only in the Agent orchestrator's own bounded context.
    if run.observation_sequence as usize > MAX_OBSERVATIONS_PER_RUN_V1 {
        run.current_observation = Some(model.clone());
    }
    Ok(Some(model))
}

fn model_observation_v1(
    observation_id: String,
    captured: TerminalCapturedObservationV1,
) -> TerminalModelObservationV1 {
    TerminalModelObservationV1 {
        observation_id,
        capture_epoch: captured.capture_epoch,
        observed_at_ms: captured.observed_at_ms,
        redacted_transcript: captured.redacted_transcript,
        transcript_digest: captured.transcript_digest,
        truncated: captured.truncated,
        surface: captured.surface,
        prompt_class: captured.prompt_class,
        untrusted: true,
    }
}

fn complete_observed_action_v1(
    run: &mut TerminalRunRecordV1,
    observation: &TerminalModelObservationV1,
    now_ms: u64,
    audit: &dyn TerminalAuditWriterV1,
) -> Result<(), TerminalCoordinatorErrorV1> {
    let Some(action_id) = run.action_order.iter().rev().find_map(|id| {
        let record = run.actions.get(id)?;
        (record.public.state == TerminalInteractionStateV1::AwaitingObservation).then(|| id.clone())
    }) else {
        return Ok(());
    };
    let record = run.actions.get_mut(&action_id).expect("action exists");
    record.public.observation_id = Some(observation.observation_id.clone());
    if record.public.verification.is_none() {
        run.append_transition(
            &action_id,
            TerminalInteractionStateV1::Completed,
            now_ms,
            "bounded redacted untrusted observation completed the non-state-changing interaction",
            audit,
        )?;
    }
    Ok(())
}

fn create_backend_safety_action_v1(
    run: &mut TerminalRunRecordV1,
    now_ms: u64,
    observation: &TerminalModelObservationV1,
) -> String {
    let action_id = format!(
        "backend-handoff-{}-{}",
        observation.capture_epoch, run.observation_sequence
    );
    let action_digest = digest_tuple_v1(&[
        "backend-terminal-handoff-v1",
        &run.run_id,
        &observation.observation_id,
        &observation.transcript_digest,
        &format!("{:?}", observation.prompt_class),
        &format!("{:?}", observation.surface),
    ]);
    run.actions.insert(
        action_id.clone(),
        TerminalActionRecordV1 {
            action: None,
            public: TerminalActionSnapshotV1 {
                action_id: action_id.clone(),
                action_kind: "terminal.handoff".to_string(),
                action_digest,
                state: TerminalInteractionStateV1::EvaluatingRisk,
                risk: Some(TerminalRiskSnapshotV1 {
                    severity: TerminalRiskSeverityV1::Critical,
                    verdict: TerminalRiskVerdictV1::DenyAndHandoff,
                    state_change: false,
                    policy_version: AGENT_TERMINAL_POLICY_VERSION_V1.to_string(),
                    risk_digest: digest_text_v1("terminal-sensitive-handoff-risk-v1"),
                }),
                approval_id: None,
                observation_id: Some(observation.observation_id.clone()),
                verification: None,
                verified: false,
                proposed_at_ms: now_ms,
                updated_at_ms: now_ms,
            },
        },
    );
    run.action_order.push(action_id.clone());
    action_id
}

fn digest_action_v1(action: &TerminalActionV1) -> String {
    let encoded = serde_json::to_vec(action).expect("terminal action serialization is infallible");
    let mut hasher = Sha256::new();
    hasher.update(b"agent-terminal-action-v1\0");
    hasher.update((encoded.len() as u64).to_be_bytes());
    hasher.update(encoded);
    format!("sha256-v1:{}", hex_bytes_v1(&hasher.finalize()))
}

fn digest_tuple_v1(values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("sha256-v1:{}", hex_bytes_v1(&hasher.finalize()))
}

fn hex_bytes_v1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn protocol_enum_name_v1(value: impl Serialize) -> Option<String> {
    serde_json::to_value(value)
        .ok()?
        .as_str()
        .map(str::to_string)
}

fn bounded_preview_v1(value: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '\0'))
        .take(240)
        .collect::<String>();
    if sanitized.is_empty() {
        "[REDACTED]".to_string()
    } else {
        sanitized
    }
}

fn state_name_v1(state: TerminalInteractionStateV1) -> &'static str {
    match state {
        TerminalInteractionStateV1::Proposed => "proposed",
        TerminalInteractionStateV1::Validating => "validating",
        TerminalInteractionStateV1::EvaluatingRisk => "evaluatingRisk",
        TerminalInteractionStateV1::AwaitingApproval => "awaitingApproval",
        TerminalInteractionStateV1::Approved => "approved",
        TerminalInteractionStateV1::Rejected => "rejected",
        TerminalInteractionStateV1::Expired => "expired",
        TerminalInteractionStateV1::Revoked => "revoked",
        TerminalInteractionStateV1::Writing => "writing",
        TerminalInteractionStateV1::AwaitingObservation => "awaitingObservation",
        TerminalInteractionStateV1::HandoffRequired => "handoffRequired",
        TerminalInteractionStateV1::Completed => "completed",
        TerminalInteractionStateV1::Failed => "failed",
        TerminalInteractionStateV1::Cancelled => "cancelled",
        TerminalInteractionStateV1::UnknownEffect => "unknownEffect",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionStatus, StatusEvent,
    };
    use crate::terminal_lease::SessionKind;
    use crossbeam_channel::{unbounded, Receiver};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[test]
    fn shared_coordinator_fixture_covers_every_backend_state_and_private_field_boundary() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-terminal-protocol/v1/terminal-coordinator.json"
        ))
        .unwrap();
        let expected = fixture["stateNames"].as_array().unwrap();
        let actual = [
            TerminalInteractionStateV1::Proposed,
            TerminalInteractionStateV1::Validating,
            TerminalInteractionStateV1::EvaluatingRisk,
            TerminalInteractionStateV1::AwaitingApproval,
            TerminalInteractionStateV1::Approved,
            TerminalInteractionStateV1::Rejected,
            TerminalInteractionStateV1::Expired,
            TerminalInteractionStateV1::Revoked,
            TerminalInteractionStateV1::Writing,
            TerminalInteractionStateV1::AwaitingObservation,
            TerminalInteractionStateV1::HandoffRequired,
            TerminalInteractionStateV1::Completed,
            TerminalInteractionStateV1::Failed,
            TerminalInteractionStateV1::Cancelled,
            TerminalInteractionStateV1::UnknownEffect,
        ];
        assert_eq!(expected.len(), actual.len());
        for (expected, actual) in expected.iter().zip(actual) {
            assert_eq!(expected.as_str(), Some(state_name_v1(actual)));
        }
        let snapshot_source = include_str!("terminal_coordinator.rs");
        for field in fixture["forbiddenSnapshotFields"].as_array().unwrap() {
            let field = field.as_str().unwrap();
            assert!(!snapshot_source.contains(&format!("pub(crate) {field}:")));
        }
    }

    #[test]
    fn terminal_acceptance_fixture_is_shared_and_production_gates_remain_closed() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-terminal-protocol/v1/terminal-acceptance.json"
        ))
        .unwrap();
        assert_eq!(fixture["schemaVersion"], 1);
        assert_eq!(
            fixture["startCommit"],
            "18cd213d426d650e6c6229f28897308f7a0b22c9"
        );
        assert_eq!(fixture["knownBaseline"]["uniqueErrors"], 30);
        let requirements = fixture["requirements"].as_array().unwrap();
        assert_eq!(requirements.len(), 10);
        let ids = requirements
            .iter()
            .map(|requirement| requirement["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), requirements.len());
        assert!(requirements.iter().all(|requirement| {
            !requirement["codeLocations"].as_array().unwrap().is_empty()
                && !requirement["automatedEvidence"]
                    .as_array()
                    .unwrap()
                    .is_empty()
                && !requirement["exitCondition"].as_str().unwrap().is_empty()
        }));
        assert!(!CURRENT_AGENT_TERMINAL_ADMISSION_V1.p2_verified);
        assert!(!CURRENT_AGENT_TERMINAL_ADMISSION_V1.feature_enabled);

        let (manager, _receiver) = manager_and_receiver();
        let lease = manager.terminal_lease_snapshot("agent-session-1").unwrap();
        let error = AgentTerminalCoordinatorV1::default()
            .register_interaction(
                "run-1".to_string(),
                "sha256-v1:target".to_string(),
                lease,
                manager,
                1_000,
                Vec::new(),
            )
            .unwrap_err();
        assert_eq!(error.code, TerminalCoordinatorErrorCodeV1::AdmissionBlocked);
    }

    #[derive(Default)]
    struct MemoryAudit {
        events: Mutex<Vec<TerminalAuditEventV1>>,
        fail: Mutex<bool>,
    }

    impl TerminalAuditWriterV1 for MemoryAudit {
        fn append(&self, event: &TerminalAuditEventV1) -> Result<(), String> {
            if *self.fail.lock().unwrap() {
                return Err("fixture audit failure".to_string());
            }
            self.events.lock().unwrap().push(event.clone());
            Ok(())
        }
    }

    struct FakeVerifier {
        independent: bool,
    }

    impl TerminalVerifierV1 for FakeVerifier {
        fn verify(
            &self,
            request: &TerminalVerificationRequestV1,
        ) -> Result<TerminalIndependentEvidenceV1, String> {
            Ok(TerminalIndependentEvidenceV1 {
                evidence_id: "structured-evidence-1".to_string(),
                run_id: request.run_id.clone(),
                target_digest: request.target_digest.clone(),
                obligation_id: request.obligation_id.clone(),
                observed_at_ms: 1_100,
                successful: true,
                independent_read_only: self.independent,
                structured_digest: digest_text_v1("structured=true"),
            })
        }
    }

    fn manager_and_receiver() -> (SessionManager, Receiver<SessionCommand>) {
        let manager = SessionManager::default();
        let (sender, receiver) = unbounded();
        manager
            .insert_agent_pty(
                "agent-session-1".to_string(),
                "run-1".to_string(),
                ManagedSession {
                    kind: SessionKind::UserTerminal,
                    sender: SessionCommandSender::Event(sender),
                    waker: None,
                    output_state_sender: None,
                    status: StatusEvent {
                        session_id: "agent-session-1".to_string(),
                        status: SessionStatus::Connected,
                        message: None,
                    },
                    output_ready: Arc::new(AtomicBool::new(true)),
                    output_paused: Arc::new(AtomicBool::new(false)),
                },
            )
            .unwrap();
        (manager, receiver)
    }

    fn setup() -> (
        AgentTerminalCoordinatorV1,
        SessionManager,
        Receiver<SessionCommand>,
        MemoryAudit,
    ) {
        let (manager, receiver) = manager_and_receiver();
        let coordinator = AgentTerminalCoordinatorV1::new_fake();
        coordinator
            .register_interaction(
                "run-1".to_string(),
                "sha256-v1:target".to_string(),
                manager.terminal_lease_snapshot("agent-session-1").unwrap(),
                manager.clone(),
                1_000,
                Vec::new(),
            )
            .unwrap();
        (coordinator, manager, receiver, MemoryAudit::default())
    }

    fn start_and_observe(
        coordinator: &AgentTerminalCoordinatorV1,
        manager: &SessionManager,
        audit: &MemoryAudit,
    ) {
        coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.start","actionId":"start-1","driver":"fixture.shellPrompt","program":"termbridge-interactive-fixture","arguments":{"scenario":"confirm"}}"#,
                1_001,
                DEFAULT_TERMINAL_APPROVAL_TTL_MS_V1,
                manager,
                audit,
            )
            .unwrap();
        coordinator
            .ingest_output("agent-session-1", "Continue? [y/N]", 1_002, manager, audit)
            .unwrap();
        coordinator
            .finish_observation("run-1", 1_003, manager, audit)
            .unwrap();
    }

    #[test]
    fn fake_happy_path_uses_approval_writer_observation_and_independent_verifier() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-1","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                DEFAULT_TERMINAL_APPROVAL_TTL_MS_V1,
                &manager,
                &audit,
            )
            .unwrap();
        let approval = snapshot.pending_approval.unwrap();
        assert_eq!(approval.run_id, "run-1");
        assert_eq!(approval.session_id, "agent-session-1");
        assert_eq!(approval.driver, TerminalDriverIdV1::FixtureShellPrompt);
        let approval_id = approval.approval_id;
        let snapshot = coordinator
            .resolve_approval(
                TerminalResolveApprovalRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    approval_id,
                    client_action_id: "approve-1".to_string(),
                    decision: TerminalApprovalDecisionV1::Approve,
                },
                1_005,
                &manager,
                &audit,
            )
            .unwrap();
        match receiver.recv().unwrap() {
            SessionCommand::Write(data) => assert_eq!(data, "yes\r"),
            SessionCommand::Resize { .. } | SessionCommand::Close => {
                panic!("approved terminal action did not render one write")
            }
        }
        assert_eq!(
            snapshot.actions.last().unwrap().state,
            TerminalInteractionStateV1::AwaitingObservation
        );
        assert!(!snapshot.actions.last().unwrap().verified);
        coordinator
            .ingest_output(
                "agent-session-1",
                "Done\nContinue? [y/N]",
                1_006,
                &manager,
                &audit,
            )
            .unwrap();
        coordinator
            .finish_observation("run-1", 1_007, &manager, &audit)
            .unwrap();
        let snapshot = coordinator
            .verify_pending_action(
                "run-1",
                "respond-1",
                1_008,
                &FakeVerifier { independent: true },
                &audit,
            )
            .unwrap();
        let action = snapshot.actions.last().unwrap();
        assert_eq!(action.state, TerminalInteractionStateV1::Completed);
        assert!(action.verified);
        assert!(action
            .verification
            .as_ref()
            .is_some_and(|verification| verification.independent));
    }

    #[test]
    fn audit_prewrite_failure_prevents_effecting_input_and_replay() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-1","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                DEFAULT_TERMINAL_APPROVAL_TTL_MS_V1,
                &manager,
                &audit,
            )
            .unwrap();
        *audit.fail.lock().unwrap() = true;
        let result = coordinator.resolve_approval(
            TerminalResolveApprovalRequestV1 {
                schema_version: 1,
                run_id: "run-1".to_string(),
                approval_id: snapshot.pending_approval.unwrap().approval_id,
                client_action_id: "approve-1".to_string(),
                decision: TerminalApprovalDecisionV1::Approve,
            },
            1_005,
            &manager,
            &audit,
        );
        assert_eq!(
            result.unwrap_err().code,
            TerminalCoordinatorErrorCodeV1::AuditPrewriteFailed
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn takeover_audit_prewrite_failure_keeps_agent_owner_and_sends_no_user_input() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        *audit.fail.lock().unwrap() = true;
        let error = coordinator
            .takeover_and_write(
                TerminalTakeoverAndWriteRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "takeover-prewrite-fails".to_string(),
                    data: "raw-user-secret\n".to_string(),
                },
                1_004,
                &manager,
                &audit,
            )
            .unwrap_err();
        assert_eq!(
            error.code,
            TerminalCoordinatorErrorCodeV1::AuditPrewriteFailed
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            manager
                .terminal_lease_snapshot("agent-session-1")
                .unwrap()
                .owner,
            TerminalLeaseOwner::Agent
        );
        assert!(
            !serde_json::to_string(&coordinator.snapshot("run-1").unwrap())
                .unwrap()
                .contains("raw-user-secret")
        );
    }

    #[test]
    fn approval_expiry_and_single_use_replay_send_at_most_one_input() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-expire","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                5,
                &manager,
                &audit,
            )
            .unwrap();
        let approval_id = snapshot.pending_approval.unwrap().approval_id;
        let request = TerminalResolveApprovalRequestV1 {
            schema_version: 1,
            run_id: "run-1".to_string(),
            approval_id: approval_id.clone(),
            client_action_id: "expire-on-boundary".to_string(),
            decision: TerminalApprovalDecisionV1::Approve,
        };
        let expired = coordinator
            .resolve_approval(request.clone(), 1_009, &manager, &audit)
            .unwrap();
        assert_eq!(
            expired.actions.last().unwrap().state,
            TerminalInteractionStateV1::Expired
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            coordinator
                .resolve_approval(request, 1_010, &manager, &audit)
                .unwrap()
                .last_sequence,
            expired.last_sequence
        );
        let replay = coordinator.resolve_approval(
            TerminalResolveApprovalRequestV1 {
                schema_version: 1,
                run_id: "run-1".to_string(),
                approval_id,
                client_action_id: "different-replay-id".to_string(),
                decision: TerminalApprovalDecisionV1::Approve,
            },
            1_010,
            &manager,
            &audit,
        );
        assert_eq!(
            replay.unwrap_err().code,
            TerminalCoordinatorErrorCodeV1::ApprovalReplay
        );
    }

    #[test]
    fn action_idempotency_accepts_identical_proposal_and_rejects_changed_replay() {
        let (coordinator, manager, _receiver, audit) = setup();
        let start = r#"{"schemaVersion":1,"action":"terminal.start","actionId":"same-action","driver":"fixture.shellPrompt","program":"termbridge-interactive-fixture","arguments":{"scenario":"confirm"}}"#;
        let first = coordinator
            .propose_action("run-1", start, 1_001, 5_000, &manager, &audit)
            .unwrap();
        let identical = coordinator
            .propose_action("run-1", start, 1_002, 5_000, &manager, &audit)
            .unwrap();
        assert_eq!(identical.last_sequence, first.last_sequence);
        let changed = coordinator.propose_action(
            "run-1",
            r#"{"schemaVersion":1,"action":"terminal.start","actionId":"same-action","driver":"fixture.shellPrompt","program":"termbridge-interactive-fixture","arguments":{"scenario":"choice"}}"#,
            1_003,
            5_000,
            &manager,
            &audit,
        );
        assert_eq!(
            changed.unwrap_err().code,
            TerminalCoordinatorErrorCodeV1::Replay
        );
    }

    #[test]
    fn control_and_approval_retries_are_exactly_once_and_reject_is_terminal() {
        let (coordinator, manager, receiver, audit) = setup();
        let first = coordinator
            .takeover_and_write(
                TerminalTakeoverAndWriteRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "takeover-retry".to_string(),
                    data: "first-user-input\n".to_string(),
                },
                1_001,
                &manager,
                &audit,
            )
            .unwrap();
        let retry = coordinator
            .takeover_and_write(
                TerminalTakeoverAndWriteRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "takeover-retry".to_string(),
                    data: "different-retry-payload-must-not-write\n".to_string(),
                },
                1_002,
                &manager,
                &audit,
            )
            .unwrap();
        assert_eq!(retry.last_sequence, first.last_sequence);
        assert_eq!(
            receiver
                .try_iter()
                .filter(|command| matches!(command, SessionCommand::Write(_)))
                .count(),
            1
        );
        let serialized = serde_json::to_string(&retry).unwrap();
        assert!(!serialized.contains("first-user-input"));
        assert!(!serialized.contains("different-retry-payload"));

        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let pending = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-reject","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                5_000,
                &manager,
                &audit,
            )
            .unwrap();
        let approval_id = pending.pending_approval.unwrap().approval_id;
        let request = TerminalResolveApprovalRequestV1 {
            schema_version: 1,
            run_id: "run-1".to_string(),
            approval_id: approval_id.clone(),
            client_action_id: "reject-retry".to_string(),
            decision: TerminalApprovalDecisionV1::Reject,
        };
        let rejected = coordinator
            .resolve_approval(request.clone(), 1_005, &manager, &audit)
            .unwrap();
        assert_eq!(
            rejected.actions.last().unwrap().state,
            TerminalInteractionStateV1::Rejected
        );
        assert_eq!(
            coordinator
                .resolve_approval(request, 1_006, &manager, &audit)
                .unwrap()
                .last_sequence,
            rejected.last_sequence
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(
            coordinator
                .resolve_approval(
                    TerminalResolveApprovalRequestV1 {
                        schema_version: 1,
                        run_id: "run-1".to_string(),
                        approval_id,
                        client_action_id: "reject-changed-replay".to_string(),
                        decision: TerminalApprovalDecisionV1::Reject,
                    },
                    1_007,
                    &manager,
                    &audit,
                )
                .unwrap_err()
                .code,
            TerminalCoordinatorErrorCodeV1::ApprovalReplay
        );
    }

    #[test]
    fn changed_authoritative_lease_revokes_exact_approval_binding() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-stale","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                5_000,
                &manager,
                &audit,
            )
            .unwrap();
        let approval_id = snapshot.pending_approval.unwrap().approval_id;
        manager
            .revoke_agent_terminal(
                &AgentTerminalBinding {
                    run_id: "run-1".to_string(),
                    session_id: "agent-session-1".to_string(),
                },
                TerminalLeaseRevocationReason::Paused,
            )
            .unwrap();
        let error = coordinator
            .resolve_approval(
                TerminalResolveApprovalRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    approval_id,
                    client_action_id: "approve-stale-lease".to_string(),
                    decision: TerminalApprovalDecisionV1::Approve,
                },
                1_005,
                &manager,
                &audit,
            )
            .unwrap_err();
        assert_eq!(error.code, TerminalCoordinatorErrorCodeV1::BindingMismatch);
        assert!(receiver.try_recv().is_err());
        let snapshot = coordinator.snapshot("run-1").unwrap();
        assert_eq!(
            snapshot.actions.last().unwrap().state,
            TerminalInteractionStateV1::Revoked
        );
        assert!(snapshot.pending_approval.is_none());
    }

    #[test]
    fn ambiguous_writer_failure_is_unknown_effect_and_never_replayed() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-unknown","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                5_000,
                &manager,
                &audit,
            )
            .unwrap();
        let approval_id = snapshot.pending_approval.unwrap().approval_id;
        drop(receiver);
        let resolved = coordinator
            .resolve_approval(
                TerminalResolveApprovalRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    approval_id: approval_id.clone(),
                    client_action_id: "unknown-writer".to_string(),
                    decision: TerminalApprovalDecisionV1::Approve,
                },
                1_005,
                &manager,
                &audit,
            )
            .unwrap();
        assert_eq!(
            resolved.actions.last().unwrap().state,
            TerminalInteractionStateV1::UnknownEffect
        );
        let replay = coordinator.resolve_approval(
            TerminalResolveApprovalRequestV1 {
                schema_version: 1,
                run_id: "run-1".to_string(),
                approval_id,
                client_action_id: "unknown-writer-replay".to_string(),
                decision: TerminalApprovalDecisionV1::Approve,
            },
            1_006,
            &manager,
            &audit,
        );
        assert_eq!(
            replay.unwrap_err().code,
            TerminalCoordinatorErrorCodeV1::ApprovalReplay
        );
    }

    #[test]
    fn takeover_is_atomic_user_output_isolated_and_return_rotates_capture() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let before = coordinator.snapshot("run-1").unwrap().capture_epoch;
        let snapshot = coordinator
            .takeover_and_write(
                TerminalTakeoverAndWriteRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "takeover-1".to_string(),
                    data: "raw-user-secret\n".to_string(),
                },
                1_004,
                &manager,
                &audit,
            )
            .unwrap();
        assert_eq!(snapshot.control_state, TerminalRunControlStateV1::User);
        match receiver.recv().unwrap() {
            SessionCommand::Write(data) => assert_eq!(data, "raw-user-secret\n"),
            SessionCommand::Resize { .. } | SessionCommand::Close => {
                panic!("takeover did not enqueue the first user write")
            }
        }
        assert!(coordinator
            .ingest_output(
                "agent-session-1",
                "raw-user-secret\n",
                1_005,
                &manager,
                &audit,
            )
            .unwrap()
            .is_none());
        let snapshot = coordinator
            .return_control(
                TerminalRunControlRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "return-1".to_string(),
                },
                1_006,
                &manager,
                &audit,
            )
            .unwrap();
        assert!(snapshot.capture_epoch > before);
        assert!(snapshot.current_observation.is_none());
        let serialized = serde_json::to_string(&snapshot).unwrap();
        let audits = serde_json::to_string(&*audit.events.lock().unwrap()).unwrap();
        assert!(!serialized.contains("raw-user-secret"));
        assert!(!audits.contains("raw-user-secret"));
    }

    #[test]
    fn sensitive_output_revokes_lease_and_never_offers_approval() {
        let (coordinator, manager, _receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let observation = coordinator
            .ingest_output("agent-session-1", "Password:", 1_004, &manager, &audit)
            .unwrap()
            .unwrap();
        assert_eq!(
            observation.prompt_class,
            super::super::terminal_policy::TerminalPromptClassV1::Password
        );
        let snapshot = coordinator.snapshot("run-1").unwrap();
        assert_eq!(
            snapshot.control_state,
            TerminalRunControlStateV1::HandoffRequired
        );
        assert_eq!(snapshot.lease_owner, TerminalLeaseOwner::Unowned);
        assert!(snapshot.pending_approval.is_none());
        let sequence = snapshot.last_sequence;
        assert!(coordinator
            .ingest_output(
                "agent-session-1",
                "late Password: and token=do-not-capture",
                1_005,
                &manager,
                &audit,
            )
            .unwrap()
            .is_none());
        let late = coordinator.snapshot("run-1").unwrap();
        assert_eq!(late.last_sequence, sequence);
        assert!(!serde_json::to_string(&late)
            .unwrap()
            .contains("do-not-capture"));
    }

    #[test]
    fn disconnect_reconnect_never_reacquires_and_pause_stop_revoke_before_cancel() {
        let (coordinator, manager, _receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        manager
            .set_status(
                "agent-session-1",
                StatusEvent {
                    session_id: "agent-session-1".to_string(),
                    status: SessionStatus::Disconnected,
                    message: None,
                },
            )
            .unwrap();
        coordinator
            .handle_disconnect("agent-session-1", 1_004, &manager, &audit)
            .unwrap();
        coordinator
            .handle_reconnect("agent-session-1", &manager)
            .unwrap();
        let reconnected = coordinator.snapshot("run-1").unwrap();
        assert_eq!(
            reconnected.control_state,
            TerminalRunControlStateV1::Disconnected
        );
        assert_eq!(reconnected.lease_owner, TerminalLeaseOwner::Unowned);
        assert_eq!(reconnected.lease_state, TerminalLeaseState::Revoked);

        let (paused_coordinator, paused_manager, _receiver, paused_audit) = setup();
        start_and_observe(&paused_coordinator, &paused_manager, &paused_audit);
        let paused = paused_coordinator
            .pause(
                TerminalRunControlRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "pause-1".to_string(),
                },
                1_004,
                &paused_manager,
                &paused_audit,
            )
            .unwrap();
        assert_eq!(paused.control_state, TerminalRunControlStateV1::Paused);
        assert_eq!(paused.lease_owner, TerminalLeaseOwner::Unowned);

        let (stopped_coordinator, stopped_manager, _receiver, stopped_audit) = setup();
        start_and_observe(&stopped_coordinator, &stopped_manager, &stopped_audit);
        let stopped = stopped_coordinator
            .stop(
                TerminalRunControlRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    client_action_id: "stop-1".to_string(),
                },
                1_004,
                &stopped_manager,
                &stopped_audit,
            )
            .unwrap();
        assert_eq!(stopped.control_state, TerminalRunControlStateV1::Stopped);
        assert_eq!(stopped.lease_owner, TerminalLeaseOwner::Unowned);
    }

    #[test]
    fn application_exit_after_revoke_cancels_without_reacquiring_or_writing() {
        let (coordinator, manager, receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"exit-pending","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                5_000,
                &manager,
                &audit,
            )
            .unwrap();
        manager
            .revoke_agent_terminals_for_application_exit()
            .unwrap();
        assert_eq!(
            coordinator
                .handle_application_exit_after_revoke(1_005, &manager, &audit)
                .unwrap(),
            1
        );
        let snapshot = coordinator.snapshot("run-1").unwrap();
        assert_eq!(snapshot.control_state, TerminalRunControlStateV1::Stopped);
        assert_eq!(snapshot.lease_owner, TerminalLeaseOwner::Unowned);
        assert_eq!(snapshot.lease_state, TerminalLeaseState::Revoked);
        assert!(snapshot.pending_approval.is_none());
        assert_eq!(
            snapshot.actions.last().unwrap().state,
            TerminalInteractionStateV1::Revoked
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn fixed_seed_sequence_and_terminal_state_immutability_properties_hold() {
        let states = [
            TerminalInteractionStateV1::Proposed,
            TerminalInteractionStateV1::Validating,
            TerminalInteractionStateV1::EvaluatingRisk,
            TerminalInteractionStateV1::AwaitingApproval,
            TerminalInteractionStateV1::Approved,
            TerminalInteractionStateV1::Rejected,
            TerminalInteractionStateV1::Expired,
            TerminalInteractionStateV1::Revoked,
            TerminalInteractionStateV1::Writing,
            TerminalInteractionStateV1::AwaitingObservation,
            TerminalInteractionStateV1::HandoffRequired,
            TerminalInteractionStateV1::Completed,
            TerminalInteractionStateV1::Failed,
            TerminalInteractionStateV1::Cancelled,
            TerminalInteractionStateV1::UnknownEffect,
        ];
        let mut seed = 0x51a7_e123_u32;
        for index in 0..2_048 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let from = states[seed as usize % states.len()];
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let to = states[seed as usize % states.len()];
            if from.is_terminal() {
                assert!(
                    !from.can_transition_to(to),
                    "terminal seeded transition {index}: {from:?} -> {to:?}"
                );
            }
        }

        let (coordinator, manager, _receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let before = coordinator.snapshot("run-1").unwrap();
        assert!(before.actions[0].state.is_terminal());
        assert!(before
            .events
            .windows(2)
            .all(|events| events[0].sequence < events[1].sequence));
        let mut registry = coordinator.lock_registry().unwrap();
        let run = registry.runs.get_mut("run-1").unwrap();
        let sequence = run.next_sequence;
        let state = run.actions["start-1"].public.state;
        let error = run
            .append_transition(
                "start-1",
                TerminalInteractionStateV1::Failed,
                2_000,
                "late terminal mutation",
                &audit,
            )
            .unwrap_err();
        assert_eq!(error.code, TerminalCoordinatorErrorCodeV1::InvalidState);
        assert_eq!(run.next_sequence, sequence);
        assert_eq!(run.actions["start-1"].public.state, state);
    }

    #[test]
    fn non_independent_evidence_can_never_mark_verified() {
        let (coordinator, manager, _receiver, audit) = setup();
        start_and_observe(&coordinator, &manager, &audit);
        let snapshot = coordinator
            .propose_action(
                "run-1",
                r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-1","observationId":"terminal-observation-1-1","response":"accept"}"#,
                1_004,
                DEFAULT_TERMINAL_APPROVAL_TTL_MS_V1,
                &manager,
                &audit,
            )
            .unwrap();
        coordinator
            .resolve_approval(
                TerminalResolveApprovalRequestV1 {
                    schema_version: 1,
                    run_id: "run-1".to_string(),
                    approval_id: snapshot.pending_approval.unwrap().approval_id,
                    client_action_id: "approve-1".to_string(),
                    decision: TerminalApprovalDecisionV1::Approve,
                },
                1_005,
                &manager,
                &audit,
            )
            .unwrap();
        coordinator
            .ingest_output(
                "agent-session-1",
                "Continue? [y/N]",
                1_006,
                &manager,
                &audit,
            )
            .unwrap();
        coordinator
            .finish_observation("run-1", 1_007, &manager, &audit)
            .unwrap();
        let snapshot = coordinator
            .verify_pending_action(
                "run-1",
                "respond-1",
                1_008,
                &FakeVerifier { independent: false },
                &audit,
            )
            .unwrap();
        assert!(!snapshot.actions.last().unwrap().verified);
    }
}
