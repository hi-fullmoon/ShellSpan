//! Backend-authoritative P3 terminal interaction policy and lease gateway.
//!
//! The controller binds every action to one run, target, dedicated PTY, lease
//! token, active compile-time driver, and current prompt observation. Terminal
//! output is untrusted; prompt detection can only make a classification more
//! restrictive. This module is not wired into the production Agent manager.

use super::terminal_driver::{
    allowed_keys_v1, allowed_responses_v1, lookup_terminal_driver_v1, render_terminal_action_v1,
    RegisteredTerminalStartV1, RenderedTerminalActionV1, RenderedTerminalInputV1,
};
use super::terminal_protocol::{
    valid_terminal_identifier, TerminalActionV1, TerminalDriverIdV1, TerminalFixtureScenarioV1,
    TerminalHandoffReasonV1, TerminalProgramIdV1,
};
use crate::models::SessionManager;
use crate::terminal_lease::{
    AgentTerminalBinding, TerminalLeaseOwner, TerminalLeaseSnapshot, TerminalLeaseState,
    TerminalLeaseToken,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;

pub(crate) const MAX_PROMPT_OBSERVATION_AGE_MS_V1: u64 = 30_000;
const MAX_PROMPT_CHARACTERS_V1: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalAuthorityContextV1 {
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) binding: AgentTerminalBinding,
    pub(crate) lease_token: TerminalLeaseToken,
    pub(crate) now_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalPromptSurfaceV1 {
    LinePrompt,
    FullScreen,
    Editor,
    Installer,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalPromptClassV1 {
    Confirm,
    Choice,
    Password,
    Passphrase,
    Mfa,
    Otp,
    Token,
    Credential,
    UnknownSensitive,
    Unknown,
}

impl TerminalPromptClassV1 {
    pub(crate) fn is_sensitive(self) -> bool {
        matches!(
            self,
            Self::Password
                | Self::Passphrase
                | Self::Mfa
                | Self::Otp
                | Self::Token
                | Self::Credential
                | Self::UnknownSensitive
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalPromptObservationInputV1 {
    pub(crate) observation_id: String,
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) binding: AgentTerminalBinding,
    pub(crate) sequence: u64,
    pub(crate) observed_at_ms: u64,
    pub(crate) surface: TerminalPromptSurfaceV1,
    pub(crate) claimed_class: TerminalPromptClassV1,
    pub(crate) untrusted_prompt_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalPromptObservationV1 {
    pub(crate) observation_id: String,
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) binding: AgentTerminalBinding,
    pub(crate) driver: TerminalDriverIdV1,
    pub(crate) program: TerminalProgramIdV1,
    pub(crate) scenario: TerminalFixtureScenarioV1,
    pub(crate) sequence: u64,
    pub(crate) observed_at_ms: u64,
    pub(crate) surface: TerminalPromptSurfaceV1,
    pub(crate) effective_class: TerminalPromptClassV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalControllerStateV1 {
    NotStarted,
    Active,
    HandoffPending,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveTerminalDriverV1 {
    driver: TerminalDriverIdV1,
    program: TerminalProgramIdV1,
    scenario: TerminalFixtureScenarioV1,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalPolicyErrorCodeV1 {
    InvalidIdentity,
    ContextRunMismatch,
    TargetMismatch,
    BindingMismatch,
    LeaseMismatch,
    LeaseNotAgentOwned,
    Replay,
    DriverNotRegistered,
    DriverNotStarted,
    DriverAlreadyStarted,
    InteractionClosed,
    ObservationInvalid,
    ObservationNotFound,
    ObservationNotCurrent,
    ObservationReplay,
    ObservationStale,
    ObservationFuture,
    ObservationMismatch,
    UnsupportedSurface,
    HandoffRequired,
    ResponseNotAllowed,
    KeyNotAllowed,
    RendererRejected,
    WriterRejected,
    WriterLeaseMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalPolicyErrorV1 {
    pub(crate) code: TerminalPolicyErrorCodeV1,
    pub(crate) message: String,
}

impl fmt::Display for TerminalPolicyErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn policy_error(
    code: TerminalPolicyErrorCodeV1,
    message: impl Into<String>,
) -> TerminalPolicyErrorV1 {
    TerminalPolicyErrorV1 {
        code,
        message: message.into(),
    }
}

pub(crate) trait TerminalLeaseInputWriterV1 {
    fn write_rendered_input(
        &mut self,
        binding: &AgentTerminalBinding,
        token: TerminalLeaseToken,
        input: &RenderedTerminalInputV1,
    ) -> Result<TerminalLeaseSnapshot, String>;
}

impl TerminalLeaseInputWriterV1 for SessionManager {
    fn write_rendered_input(
        &mut self,
        binding: &AgentTerminalBinding,
        token: TerminalLeaseToken,
        input: &RenderedTerminalInputV1,
    ) -> Result<TerminalLeaseSnapshot, String> {
        self.write_agent_input(binding, token, input.as_str().to_string())
            .map_err(|error| error.to_string())
    }
}

impl TerminalLeaseInputWriterV1 for &SessionManager {
    fn write_rendered_input(
        &mut self,
        binding: &AgentTerminalBinding,
        token: TerminalLeaseToken,
        input: &RenderedTerminalInputV1,
    ) -> Result<TerminalLeaseSnapshot, String> {
        self.write_agent_input(binding, token, input.as_str().to_string())
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalControlTransferIntentV1 {
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) binding: AgentTerminalBinding,
    pub(crate) observation_id: String,
    pub(crate) evidence_id: String,
    pub(crate) reason: TerminalHandoffReasonV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalActionOutcomeV1 {
    Start(RegisteredTerminalStartV1),
    InputAccepted {
        lease: TerminalLeaseSnapshot,
        observation_id: String,
        evidence_id: String,
    },
    Handoff(TerminalControlTransferIntentV1),
}

pub(crate) struct TerminalInteractionControllerV1<W> {
    run_id: String,
    target_digest: String,
    binding: AgentTerminalBinding,
    lease: TerminalLeaseSnapshot,
    state: TerminalControllerStateV1,
    active_driver: Option<ActiveTerminalDriverV1>,
    observations: HashMap<String, TerminalPromptObservationV1>,
    current_observation_id: Option<String>,
    last_observation_sequence: u64,
    consumed_observation_ids: HashSet<String>,
    processed_action_ids: HashSet<String>,
    writer: W,
}

impl<W: TerminalLeaseInputWriterV1> TerminalInteractionControllerV1<W> {
    pub(crate) fn new(
        run_id: String,
        target_digest: String,
        binding: AgentTerminalBinding,
        lease: TerminalLeaseSnapshot,
        writer: W,
    ) -> Result<Self, TerminalPolicyErrorV1> {
        if !valid_terminal_identifier(&run_id)
            || !valid_terminal_identifier(&binding.run_id)
            || !valid_terminal_identifier(&binding.session_id)
            || target_digest.trim().is_empty()
            || target_digest.chars().count() > 200
            || target_digest.chars().any(char::is_control)
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::InvalidIdentity,
                "terminal controller identity is invalid",
            ));
        }
        if binding.run_id != run_id || lease.binding != binding {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::BindingMismatch,
                "terminal controller binding does not match run or lease",
            ));
        }
        if lease.owner != TerminalLeaseOwner::Agent || lease.state != TerminalLeaseState::Active {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::LeaseNotAgentOwned,
                "terminal controller requires an active Agent-owned lease",
            ));
        }
        Ok(Self {
            run_id,
            target_digest,
            binding,
            lease,
            state: TerminalControllerStateV1::NotStarted,
            active_driver: None,
            observations: HashMap::new(),
            current_observation_id: None,
            last_observation_sequence: 0,
            consumed_observation_ids: HashSet::new(),
            processed_action_ids: HashSet::new(),
            writer,
        })
    }

    pub(crate) fn lease_snapshot(&self) -> TerminalLeaseSnapshot {
        self.lease.clone()
    }

    pub(crate) fn synchronize_lease(
        &mut self,
        lease: TerminalLeaseSnapshot,
        returned_to_agent: bool,
    ) -> Result<(), TerminalPolicyErrorV1> {
        if lease.binding != self.binding {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::BindingMismatch,
                "terminal lease synchronization binding is mismatched",
            ));
        }
        self.lease = lease;
        self.current_observation_id = None;
        self.observations.clear();
        self.consumed_observation_ids.clear();
        if returned_to_agent {
            if self.lease.owner != TerminalLeaseOwner::Agent
                || self.lease.state != TerminalLeaseState::Active
            {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::LeaseNotAgentOwned,
                    "returned terminal lease is not active and Agent-owned",
                ));
            }
            self.state = if self.active_driver.is_some() {
                TerminalControllerStateV1::Active
            } else {
                TerminalControllerStateV1::NotStarted
            };
        } else if self.active_driver.is_some() {
            self.state = TerminalControllerStateV1::HandoffPending;
        }
        Ok(())
    }

    /// Runs the complete local driver/prompt/lease policy without consuming an
    /// action or crossing the writer seam. The coordinator uses this before it
    /// creates an exact, one-time approval and repeats the same validation at
    /// consumption time through `apply_action`.
    pub(crate) fn validate_action(
        &self,
        context: &TerminalAuthorityContextV1,
        action: &TerminalActionV1,
    ) -> Result<(), TerminalPolicyErrorV1> {
        self.validate_context(context)?;
        if self.processed_action_ids.contains(action.action_id()) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::Replay,
                "terminal action was already processed",
            ));
        }
        if let TerminalActionV1::Start(start) = action {
            if self.state != TerminalControllerStateV1::NotStarted {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::DriverAlreadyStarted,
                    "terminal driver can be started only once",
                ));
            }
            lookup_terminal_driver_v1(start.driver, start.program).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::DriverNotRegistered,
                    "terminal driver/program is not registered",
                )
            })?;
            render_terminal_action_v1(action).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal start renderer rejected the action",
                )
            })?;
            return Ok(());
        }
        if self.state != TerminalControllerStateV1::Active {
            return Err(policy_error(
                if self.state == TerminalControllerStateV1::NotStarted {
                    TerminalPolicyErrorCodeV1::DriverNotStarted
                } else {
                    TerminalPolicyErrorCodeV1::InteractionClosed
                },
                "terminal interaction is not active",
            ));
        }
        let observation_id = action
            .observation_id()
            .expect("non-start actions always carry observationId");
        if self.current_observation_id.as_deref() != Some(observation_id) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationNotCurrent,
                "terminal action does not reference the current observation",
            ));
        }
        if self.consumed_observation_ids.contains(observation_id) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationReplay,
                "terminal prompt observation was already consumed",
            ));
        }
        let observation = self.observations.get(observation_id).ok_or_else(|| {
            policy_error(
                TerminalPolicyErrorCodeV1::ObservationNotFound,
                "terminal prompt observation is unknown",
            )
        })?;
        self.validate_observation_binding(observation)?;
        if matches!(action, TerminalActionV1::Handoff(_)) {
            render_terminal_action_v1(action).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal handoff renderer rejected the action",
                )
            })?;
            return Ok(());
        }
        self.validate_observation_freshness(context, observation)?;
        self.require_automatable_line_prompt(observation)?;
        let active = self.active_driver.expect("active state has a driver");
        match action {
            TerminalActionV1::Respond(value)
                if allowed_responses_v1(active.scenario).contains(&value.response)
                    && prompt_class_matches_scenario(
                        observation.effective_class,
                        active.scenario,
                    ) => {}
            TerminalActionV1::Key(value)
                if allowed_keys_v1(active.scenario).contains(&value.key)
                    && prompt_class_matches_scenario(
                        observation.effective_class,
                        active.scenario,
                    ) => {}
            TerminalActionV1::Respond(_) => {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::ResponseNotAllowed,
                    "response is not allowed for the current driver prompt",
                ));
            }
            TerminalActionV1::Key(_) => {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::KeyNotAllowed,
                    "key is not allowed for the current driver prompt",
                ));
            }
            TerminalActionV1::Start(_) | TerminalActionV1::Handoff(_) => unreachable!(),
        }
        render_terminal_action_v1(action).map_err(|_| {
            policy_error(
                TerminalPolicyErrorCodeV1::RendererRejected,
                "terminal renderer rejected the semantic action",
            )
        })?;
        Ok(())
    }

    pub(crate) fn record_prompt_observation(
        &mut self,
        context: &TerminalAuthorityContextV1,
        input: TerminalPromptObservationInputV1,
    ) -> Result<TerminalPromptObservationV1, TerminalPolicyErrorV1> {
        self.validate_context(context)?;
        if self.state != TerminalControllerStateV1::Active {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::DriverNotStarted,
                "prompt observation requires an active terminal driver",
            ));
        }
        if !valid_terminal_identifier(&input.observation_id)
            || !valid_terminal_identifier(&input.evidence_id)
            || input.untrusted_prompt_text.chars().count() > MAX_PROMPT_CHARACTERS_V1
            || input.untrusted_prompt_text.contains('\0')
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationInvalid,
                "prompt observation is invalid or oversized",
            ));
        }
        if input.run_id != self.run_id
            || input.target_digest != self.target_digest
            || input.binding != self.binding
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationMismatch,
                "prompt observation run, target, or terminal binding is mismatched",
            ));
        }
        if input.observed_at_ms > context.now_ms {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationFuture,
                "prompt observation timestamp is in the future",
            ));
        }
        if input.sequence <= self.last_observation_sequence
            || self.observations.contains_key(&input.observation_id)
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationReplay,
                "prompt observation sequence or identity was replayed",
            ));
        }
        let active = self.active_driver.expect("active state has a driver");
        let observation = TerminalPromptObservationV1 {
            observation_id: input.observation_id.clone(),
            evidence_id: input.evidence_id,
            run_id: input.run_id,
            target_digest: input.target_digest,
            binding: input.binding,
            driver: active.driver,
            program: active.program,
            scenario: active.scenario,
            sequence: input.sequence,
            observed_at_ms: input.observed_at_ms,
            surface: input.surface,
            effective_class: elevate_prompt_class_v1(
                input.claimed_class,
                &input.untrusted_prompt_text,
            ),
        };
        self.last_observation_sequence = observation.sequence;
        self.current_observation_id = Some(observation.observation_id.clone());
        self.observations
            .insert(observation.observation_id.clone(), observation.clone());
        Ok(observation)
    }

    pub(crate) fn apply_action(
        &mut self,
        context: &TerminalAuthorityContextV1,
        action: &TerminalActionV1,
    ) -> Result<TerminalActionOutcomeV1, TerminalPolicyErrorV1> {
        self.validate_context(context)?;
        if self.processed_action_ids.contains(action.action_id()) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::Replay,
                "terminal action was already processed",
            ));
        }

        if let TerminalActionV1::Start(start) = action {
            if self.state != TerminalControllerStateV1::NotStarted {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::DriverAlreadyStarted,
                    "terminal driver can be started only once",
                ));
            }
            lookup_terminal_driver_v1(start.driver, start.program).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::DriverNotRegistered,
                    "terminal driver/program is not registered",
                )
            })?;
            let rendered = render_terminal_action_v1(action).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal start renderer rejected the action",
                )
            })?;
            let RenderedTerminalActionV1::Start(start_intent) = rendered else {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal start rendered to the wrong internal action",
                ));
            };
            self.processed_action_ids
                .insert(action.action_id().to_string());
            self.active_driver = Some(ActiveTerminalDriverV1 {
                driver: start.driver,
                program: start.program,
                scenario: start.arguments.scenario,
            });
            self.state = TerminalControllerStateV1::Active;
            return Ok(TerminalActionOutcomeV1::Start(start_intent));
        }

        if self.state != TerminalControllerStateV1::Active {
            let code = if self.state == TerminalControllerStateV1::NotStarted {
                TerminalPolicyErrorCodeV1::DriverNotStarted
            } else {
                TerminalPolicyErrorCodeV1::InteractionClosed
            };
            return Err(policy_error(code, "terminal interaction is not active"));
        }

        let observation_id = action
            .observation_id()
            .expect("non-start actions always carry observationId");
        if self.current_observation_id.as_deref() != Some(observation_id) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationNotCurrent,
                "terminal action does not reference the current observation",
            ));
        }
        if self.consumed_observation_ids.contains(observation_id) {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationReplay,
                "terminal prompt observation was already consumed",
            ));
        }
        let observation = self
            .observations
            .get(observation_id)
            .cloned()
            .ok_or_else(|| {
                policy_error(
                    TerminalPolicyErrorCodeV1::ObservationNotFound,
                    "terminal prompt observation is unknown",
                )
            })?;
        self.validate_observation_binding(&observation)?;

        if let TerminalActionV1::Handoff(_) = action {
            let rendered = render_terminal_action_v1(action).map_err(|_| {
                policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal handoff renderer rejected the action",
                )
            })?;
            let RenderedTerminalActionV1::Handoff(reason) = rendered else {
                return Err(policy_error(
                    TerminalPolicyErrorCodeV1::RendererRejected,
                    "terminal handoff rendered to the wrong internal action",
                ));
            };
            self.processed_action_ids
                .insert(action.action_id().to_string());
            self.consumed_observation_ids
                .insert(observation.observation_id.clone());
            self.state = TerminalControllerStateV1::HandoffPending;
            return Ok(TerminalActionOutcomeV1::Handoff(
                TerminalControlTransferIntentV1 {
                    run_id: self.run_id.clone(),
                    target_digest: self.target_digest.clone(),
                    binding: self.binding.clone(),
                    observation_id: observation.observation_id,
                    evidence_id: observation.evidence_id,
                    reason,
                },
            ));
        }

        self.validate_observation_freshness(context, &observation)?;
        self.require_automatable_line_prompt(&observation)?;
        let active = self.active_driver.expect("active state has a driver");
        match action {
            TerminalActionV1::Respond(value) => {
                if !allowed_responses_v1(active.scenario).contains(&value.response)
                    || !prompt_class_matches_scenario(observation.effective_class, active.scenario)
                {
                    return Err(policy_error(
                        TerminalPolicyErrorCodeV1::ResponseNotAllowed,
                        "response is not allowed for the current driver prompt",
                    ));
                }
            }
            TerminalActionV1::Key(value) => {
                if !allowed_keys_v1(active.scenario).contains(&value.key)
                    || !prompt_class_matches_scenario(observation.effective_class, active.scenario)
                {
                    return Err(policy_error(
                        TerminalPolicyErrorCodeV1::KeyNotAllowed,
                        "key is not allowed for the current driver prompt",
                    ));
                }
            }
            TerminalActionV1::Start(_) | TerminalActionV1::Handoff(_) => unreachable!(),
        }

        let rendered = render_terminal_action_v1(action).map_err(|_| {
            policy_error(
                TerminalPolicyErrorCodeV1::RendererRejected,
                "terminal renderer rejected the semantic action",
            )
        })?;
        let RenderedTerminalActionV1::Input(input) = rendered else {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::RendererRejected,
                "terminal semantic input rendered to the wrong internal action",
            ));
        };

        // Fence replay before crossing the side-effect seam. A failed or
        // ambiguous write is never automatically retried with the same action.
        self.processed_action_ids
            .insert(action.action_id().to_string());
        self.consumed_observation_ids
            .insert(observation.observation_id.clone());
        let previous = self.lease.clone();
        let next =
            match self
                .writer
                .write_rendered_input(&self.binding, context.lease_token, &input)
            {
                Ok(next) => next,
                Err(error) => {
                    self.state = TerminalControllerStateV1::Blocked;
                    return Err(policy_error(
                        TerminalPolicyErrorCodeV1::WriterRejected,
                        format!("phase-1 terminal lease seam rejected input: {error}"),
                    ));
                }
            };
        if !valid_next_lease(&previous, &next) {
            self.state = TerminalControllerStateV1::Blocked;
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::WriterLeaseMismatch,
                "terminal writer returned an invalid lease transition",
            ));
        }
        self.lease = next.clone();
        Ok(TerminalActionOutcomeV1::InputAccepted {
            lease: next,
            observation_id: observation.observation_id,
            evidence_id: observation.evidence_id,
        })
    }

    fn validate_context(
        &self,
        context: &TerminalAuthorityContextV1,
    ) -> Result<(), TerminalPolicyErrorV1> {
        if context.run_id != self.run_id || context.binding.run_id != self.run_id {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ContextRunMismatch,
                "terminal authority context belongs to a different run",
            ));
        }
        if context.target_digest != self.target_digest {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::TargetMismatch,
                "terminal authority context belongs to a different target",
            ));
        }
        if context.binding != self.binding || self.lease.binding != self.binding {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::BindingMismatch,
                "terminal authority context belongs to a different PTY binding",
            ));
        }
        if context.lease_token != self.lease.token() {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::LeaseMismatch,
                "terminal authority context carries a stale lease token",
            ));
        }
        if self.lease.owner != TerminalLeaseOwner::Agent
            || self.lease.state != TerminalLeaseState::Active
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::LeaseNotAgentOwned,
                "terminal lease is not active and Agent-owned",
            ));
        }
        Ok(())
    }

    fn validate_observation_binding(
        &self,
        observation: &TerminalPromptObservationV1,
    ) -> Result<(), TerminalPolicyErrorV1> {
        let active = self.active_driver.expect("active state has a driver");
        if observation.run_id != self.run_id
            || observation.target_digest != self.target_digest
            || observation.binding != self.binding
            || observation.driver != active.driver
            || observation.program != active.program
            || observation.scenario != active.scenario
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationMismatch,
                "prompt observation does not match the active run, target, lease, or driver",
            ));
        }
        Ok(())
    }

    fn validate_observation_freshness(
        &self,
        context: &TerminalAuthorityContextV1,
        observation: &TerminalPromptObservationV1,
    ) -> Result<(), TerminalPolicyErrorV1> {
        let age = context
            .now_ms
            .checked_sub(observation.observed_at_ms)
            .ok_or_else(|| {
                policy_error(
                    TerminalPolicyErrorCodeV1::ObservationFuture,
                    "prompt observation timestamp is in the future",
                )
            })?;
        if age > MAX_PROMPT_OBSERVATION_AGE_MS_V1 {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::ObservationStale,
                "prompt observation is stale",
            ));
        }
        Ok(())
    }

    fn require_automatable_line_prompt(
        &self,
        observation: &TerminalPromptObservationV1,
    ) -> Result<(), TerminalPolicyErrorV1> {
        if observation.surface != TerminalPromptSurfaceV1::LinePrompt {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::UnsupportedSurface,
                "full-screen, editor, installer, and unknown terminal surfaces require user handoff",
            ));
        }
        if observation.effective_class.is_sensitive()
            || observation.effective_class == TerminalPromptClassV1::Unknown
        {
            return Err(policy_error(
                TerminalPolicyErrorCodeV1::HandoffRequired,
                "sensitive or unknown prompt requires user handoff",
            ));
        }
        Ok(())
    }
}

fn prompt_class_matches_scenario(
    class: TerminalPromptClassV1,
    scenario: TerminalFixtureScenarioV1,
) -> bool {
    matches!(
        (class, scenario),
        (
            TerminalPromptClassV1::Confirm,
            TerminalFixtureScenarioV1::Confirm
        ) | (
            TerminalPromptClassV1::Choice,
            TerminalFixtureScenarioV1::Choice
        )
    )
}

fn valid_next_lease(previous: &TerminalLeaseSnapshot, next: &TerminalLeaseSnapshot) -> bool {
    next.binding == previous.binding
        && next.owner == TerminalLeaseOwner::Agent
        && next.state == TerminalLeaseState::Active
        && next.revocation_reason.is_none()
        && next.epoch == previous.epoch
        && previous
            .revision
            .checked_add(1)
            .is_some_and(|revision| next.revision == revision)
}

/// Detector results only elevate a locally claimed class. It never turns an
/// unknown or sensitive prompt into an automatable prompt.
fn elevate_prompt_class_v1(
    claimed: TerminalPromptClassV1,
    untrusted_prompt_text: &str,
) -> TerminalPromptClassV1 {
    if claimed.is_sensitive() || claimed == TerminalPromptClassV1::Unknown {
        return claimed;
    }
    detect_sensitive_prompt_v1(untrusted_prompt_text).unwrap_or(claimed)
}

pub(crate) fn detect_sensitive_prompt_v1(text: &str) -> Option<TerminalPromptClassV1> {
    if text.chars().any(|character| {
        character == '\n'
            || character == '\r'
            || character == '\u{1b}'
            || character == '\0'
            || (character.is_control() && character != '\t')
    }) {
        return Some(TerminalPromptClassV1::UnknownSensitive);
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("passphrase") {
        Some(TerminalPromptClassV1::Passphrase)
    } else if lower.contains("password") || lower.contains("pin:") {
        Some(TerminalPromptClassV1::Password)
    } else if lower.contains("multi-factor")
        || lower.contains("multifactor")
        || lower.contains("mfa")
        || lower.contains("2fa")
        || lower.contains("authenticator")
    {
        Some(TerminalPromptClassV1::Mfa)
    } else if lower.contains("one-time")
        || lower.contains("one time")
        || lower.contains("otp")
        || lower.contains("verification code")
    {
        Some(TerminalPromptClassV1::Otp)
    } else if lower.contains("token")
        || lower.contains("api key")
        || lower.contains("private key")
        || lower.contains("secret")
    {
        Some(TerminalPromptClassV1::Token)
    } else if lower.contains("credential") || lower.contains("login code") {
        Some(TerminalPromptClassV1::Credential)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::terminal_protocol::decode_terminal_action_v1;
    use crate::models::{
        ManagedSession, SessionCommand, SessionCommandSender, SessionStatus, StatusEvent,
    };
    use crate::terminal_lease::TerminalLease;
    use crossbeam_channel::unbounded;
    use serde::Deserialize;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    const NOW_MS: u64 = 1_000_000;

    #[derive(Debug)]
    struct FakeLeaseWriter {
        lease: TerminalLease,
        writes: Vec<String>,
    }

    impl TerminalLeaseInputWriterV1 for FakeLeaseWriter {
        fn write_rendered_input(
            &mut self,
            binding: &AgentTerminalBinding,
            token: TerminalLeaseToken,
            input: &RenderedTerminalInputV1,
        ) -> Result<TerminalLeaseSnapshot, String> {
            self.lease
                .validate_agent_input(binding, token)
                .map_err(|error| error.to_string())?;
            let next = self
                .lease
                .next_revision()
                .map_err(|error| error.to_string())?;
            self.writes.push(input.as_str().to_string());
            self.lease.commit_revision(next);
            Ok(self.lease.snapshot())
        }
    }

    fn binding() -> AgentTerminalBinding {
        AgentTerminalBinding {
            run_id: "run-1".to_string(),
            session_id: "agent-session-1".to_string(),
        }
    }

    fn lease() -> TerminalLeaseSnapshot {
        TerminalLease::new(binding()).snapshot()
    }

    fn context(snapshot: &TerminalLeaseSnapshot) -> TerminalAuthorityContextV1 {
        TerminalAuthorityContextV1 {
            run_id: "run-1".to_string(),
            target_digest: "sha256-v1:target-fixture".to_string(),
            binding: binding(),
            lease_token: snapshot.token(),
            now_ms: NOW_MS,
        }
    }

    fn fake_controller() -> TerminalInteractionControllerV1<FakeLeaseWriter> {
        let lease = lease();
        TerminalInteractionControllerV1::new(
            "run-1".to_string(),
            "sha256-v1:target-fixture".to_string(),
            binding(),
            lease.clone(),
            FakeLeaseWriter {
                lease: TerminalLease::new(binding()),
                writes: Vec::new(),
            },
        )
        .unwrap()
    }

    fn decode(raw: &str) -> TerminalActionV1 {
        decode_terminal_action_v1(raw).unwrap()
    }

    fn start_action(scenario: &str) -> TerminalActionV1 {
        decode(&format!(
            r#"{{"schemaVersion":1,"action":"terminal.start","actionId":"start-1","driver":"fixture.shellPrompt","program":"termbridge-interactive-fixture","arguments":{{"scenario":"{scenario}"}}}}"#
        ))
    }

    fn observation_input(
        prompt: &str,
        class: TerminalPromptClassV1,
        surface: TerminalPromptSurfaceV1,
        observed_at_ms: u64,
    ) -> TerminalPromptObservationInputV1 {
        TerminalPromptObservationInputV1 {
            observation_id: "observation-1".to_string(),
            evidence_id: "evidence-1".to_string(),
            run_id: "run-1".to_string(),
            target_digest: "sha256-v1:target-fixture".to_string(),
            binding: binding(),
            sequence: 1,
            observed_at_ms,
            surface,
            claimed_class: class,
            untrusted_prompt_text: prompt.to_string(),
        }
    }

    fn started_controller(
        scenario: &str,
    ) -> (
        TerminalInteractionControllerV1<FakeLeaseWriter>,
        TerminalAuthorityContextV1,
    ) {
        let mut controller = fake_controller();
        let context = context(&controller.lease_snapshot());
        assert!(matches!(
            controller
                .apply_action(&context, &start_action(scenario))
                .unwrap(),
            TerminalActionOutcomeV1::Start(_)
        ));
        (controller, context)
    }

    #[test]
    fn semantic_response_crosses_the_real_phase_one_lease_seam() {
        let manager = SessionManager::default();
        let (sender, receiver) = unbounded();
        let managed = ManagedSession {
            kind: crate::terminal_lease::SessionKind::UserTerminal,
            sender: SessionCommandSender::Event(sender),
            waker: None,
            output_state_sender: None,
            status: StatusEvent {
                session_id: "agent-session-1".to_string(),
                status: SessionStatus::Connected,
                message: Some("ready".to_string()),
            },
            output_ready: Arc::new(AtomicBool::new(true)),
            output_paused: Arc::new(AtomicBool::new(false)),
        };
        let initial = manager
            .insert_agent_pty("agent-session-1".to_string(), "run-1".to_string(), managed)
            .unwrap();
        let mut controller = TerminalInteractionControllerV1::new(
            "run-1".to_string(),
            "sha256-v1:target-fixture".to_string(),
            binding(),
            initial.clone(),
            &manager,
        )
        .unwrap();
        let authority = context(&initial);
        controller
            .apply_action(&authority, &start_action("confirm"))
            .unwrap();
        controller
            .record_prompt_observation(
                &authority,
                observation_input(
                    "Continue? [y/N]",
                    TerminalPromptClassV1::Confirm,
                    TerminalPromptSurfaceV1::LinePrompt,
                    NOW_MS,
                ),
            )
            .unwrap();
        let action = decode(
            r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-1","observationId":"observation-1","response":"accept"}"#,
        );
        let outcome = controller.apply_action(&authority, &action).unwrap();
        assert!(matches!(
            outcome,
            TerminalActionOutcomeV1::InputAccepted { .. }
        ));
        match receiver.recv().unwrap() {
            SessionCommand::Write(data) => assert_eq!(data, "yes\r"),
            SessionCommand::Resize { .. } | SessionCommand::Close => {
                panic!("semantic response did not enqueue a terminal write")
            }
        }
    }

    #[test]
    fn sensitive_detector_only_elevates_and_handoff_never_writes() {
        let (mut controller, authority) = started_controller("confirm");
        let observation = controller
            .record_prompt_observation(
                &authority,
                observation_input(
                    "Password:",
                    TerminalPromptClassV1::Confirm,
                    TerminalPromptSurfaceV1::LinePrompt,
                    NOW_MS,
                ),
            )
            .unwrap();
        assert_eq!(observation.effective_class, TerminalPromptClassV1::Password);

        let respond = decode(
            r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-1","observationId":"observation-1","response":"accept"}"#,
        );
        assert_eq!(
            controller
                .apply_action(&authority, &respond)
                .unwrap_err()
                .code,
            TerminalPolicyErrorCodeV1::HandoffRequired
        );
        assert!(controller.writer.writes.is_empty());

        let handoff = decode(
            r#"{"schemaVersion":1,"action":"terminal.handoff","actionId":"handoff-1","observationId":"observation-1","reason":"sensitivePrompt"}"#,
        );
        assert!(matches!(
            controller.apply_action(&authority, &handoff).unwrap(),
            TerminalActionOutcomeV1::Handoff(_)
        ));
        assert!(controller.writer.writes.is_empty());
    }

    #[test]
    fn replay_old_epoch_and_observation_freshness_fail_closed() {
        let (mut controller, mut authority) = started_controller("confirm");
        controller
            .record_prompt_observation(
                &authority,
                observation_input(
                    "Continue?",
                    TerminalPromptClassV1::Confirm,
                    TerminalPromptSurfaceV1::LinePrompt,
                    NOW_MS - MAX_PROMPT_OBSERVATION_AGE_MS_V1 - 1,
                ),
            )
            .unwrap();
        let respond = decode(
            r#"{"schemaVersion":1,"action":"terminal.respond","actionId":"respond-stale","observationId":"observation-1","response":"accept"}"#,
        );
        assert_eq!(
            controller
                .apply_action(&authority, &respond)
                .unwrap_err()
                .code,
            TerminalPolicyErrorCodeV1::ObservationStale
        );

        authority.lease_token.epoch += 1;
        assert_eq!(
            controller
                .apply_action(&authority, &respond)
                .unwrap_err()
                .code,
            TerminalPolicyErrorCodeV1::LeaseMismatch
        );
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SafetyFixture {
        schema_version: u8,
        cases: Vec<SafetyCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SafetyCase {
        name: String,
        scenario: String,
        prompt: String,
        claimed_class: TerminalPromptClassV1,
        surface: TerminalPromptSurfaceV1,
        observation_age_ms: u64,
        action: serde_json::Value,
        context_patch: Option<ContextPatch>,
        repeat: Option<bool>,
        expected_outcome: String,
        expected_error: Option<TerminalPolicyErrorCodeV1>,
        expected_write: Option<String>,
    }

    #[derive(Default, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ContextPatch {
        run_id: Option<String>,
        target_digest: Option<String>,
        session_id: Option<String>,
        epoch: Option<u64>,
        revision: Option<u64>,
    }

    #[test]
    fn shared_safety_corpus_covers_prompt_key_replay_and_authority_boundaries() {
        let fixture: SafetyFixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-terminal-protocol/v1/terminal-safety.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        for fixture_case in fixture.cases {
            let (mut controller, mut authority) = started_controller(&fixture_case.scenario);
            controller
                .record_prompt_observation(
                    &authority,
                    observation_input(
                        &fixture_case.prompt,
                        fixture_case.claimed_class,
                        fixture_case.surface,
                        NOW_MS.saturating_sub(fixture_case.observation_age_ms),
                    ),
                )
                .unwrap();
            if let Some(patch) = fixture_case.context_patch {
                if let Some(run_id) = patch.run_id {
                    authority.run_id = run_id;
                }
                if let Some(target_digest) = patch.target_digest {
                    authority.target_digest = target_digest;
                }
                if let Some(session_id) = patch.session_id {
                    authority.binding.session_id = session_id;
                }
                if let Some(epoch) = patch.epoch {
                    authority.lease_token.epoch = epoch;
                }
                if let Some(revision) = patch.revision {
                    authority.lease_token.revision = revision;
                }
            }
            let action = decode_terminal_action_v1(&fixture_case.action.to_string()).unwrap();
            let first = controller.apply_action(&authority, &action);
            let result = if fixture_case.repeat.unwrap_or(false) {
                assert!(first.is_ok(), "{} first application", fixture_case.name);
                let mut refreshed = authority.clone();
                refreshed.lease_token = controller.lease_snapshot().token();
                controller.apply_action(&refreshed, &action)
            } else {
                first
            };
            match fixture_case.expected_outcome.as_str() {
                "input" => assert!(
                    matches!(result, Ok(TerminalActionOutcomeV1::InputAccepted { .. })),
                    "{}: {result:?}",
                    fixture_case.name
                ),
                "handoff" => assert!(
                    matches!(result, Ok(TerminalActionOutcomeV1::Handoff(_))),
                    "{}: {result:?}",
                    fixture_case.name
                ),
                "deny" => assert_eq!(
                    result.unwrap_err().code,
                    fixture_case.expected_error.unwrap(),
                    "{}",
                    fixture_case.name
                ),
                other => panic!("unknown fixture outcome {other}"),
            }
            assert_eq!(
                controller.writer.writes.last().cloned(),
                fixture_case.expected_write,
                "{}",
                fixture_case.name
            );
        }
    }

    #[test]
    fn overlong_prompt_and_observation_binding_mismatch_are_rejected() {
        let (mut controller, authority) = started_controller("confirm");
        let mut overlong = observation_input(
            &"x".repeat(MAX_PROMPT_CHARACTERS_V1 + 1),
            TerminalPromptClassV1::Confirm,
            TerminalPromptSurfaceV1::LinePrompt,
            NOW_MS,
        );
        assert_eq!(
            controller
                .record_prompt_observation(&authority, overlong.clone())
                .unwrap_err()
                .code,
            TerminalPolicyErrorCodeV1::ObservationInvalid
        );
        overlong.untrusted_prompt_text = "Continue?".to_string();
        overlong.run_id = "run-other".to_string();
        assert_eq!(
            controller
                .record_prompt_observation(&authority, overlong)
                .unwrap_err()
                .code,
            TerminalPolicyErrorCodeV1::ObservationMismatch
        );
    }
}
