use super::admission_v2::AgentTargetCapabilityV2;
use super::protocol_v2::{
    AgentResourceRefV2, ServiceControlActionV2, ServiceControlArgsV2, ServiceInspectFieldV2,
    ServiceManagerV2, ServiceValidatorV2,
};
use super::resource_v2::canonical_systemd_service_resource_v2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub(crate) const DEFAULT_SERVICE_STATUS_FRESHNESS_SECONDS_V2: u16 = 120;
pub(crate) const DEFAULT_CONFIG_VALIDATION_FRESHNESS_SECONDS_V2: u16 = 120;
pub(crate) const DEFAULT_LISTENER_FRESHNESS_SECONDS_V2: u16 = 60;
pub(crate) const DEFAULT_TARGET_CAPABILITY_FRESHNESS_SECONDS_V2: u16 = 300;
pub(crate) const HARD_MAX_EVIDENCE_FRESHNESS_SECONDS_V2: u16 = 300;

const MAX_SYSTEMD_SHOW_BYTES_V2: usize = 16 * 1024;
const MAX_LISTENER_PORTS_V2: usize = 128;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentEvidenceFreshnessClassV2 {
    ServiceStatus,
    ConfigValidation,
    Listener,
    TargetCapability,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentEvidenceFreshnessPolicyV2 {
    pub(crate) service_status_seconds: u16,
    pub(crate) config_validation_seconds: u16,
    pub(crate) listener_seconds: u16,
    pub(crate) target_capability_seconds: u16,
}

impl Default for AgentEvidenceFreshnessPolicyV2 {
    fn default() -> Self {
        Self {
            service_status_seconds: DEFAULT_SERVICE_STATUS_FRESHNESS_SECONDS_V2,
            config_validation_seconds: DEFAULT_CONFIG_VALIDATION_FRESHNESS_SECONDS_V2,
            listener_seconds: DEFAULT_LISTENER_FRESHNESS_SECONDS_V2,
            target_capability_seconds: DEFAULT_TARGET_CAPABILITY_FRESHNESS_SECONDS_V2,
        }
    }
}

impl AgentEvidenceFreshnessPolicyV2 {
    pub(crate) fn resolve(requested: Option<Self>) -> Result<Self, AgentEvidenceErrorV2> {
        let policy = requested.unwrap_or_default();
        for (class, seconds) in [
            (
                AgentEvidenceFreshnessClassV2::ServiceStatus,
                policy.service_status_seconds,
            ),
            (
                AgentEvidenceFreshnessClassV2::ConfigValidation,
                policy.config_validation_seconds,
            ),
            (
                AgentEvidenceFreshnessClassV2::Listener,
                policy.listener_seconds,
            ),
            (
                AgentEvidenceFreshnessClassV2::TargetCapability,
                policy.target_capability_seconds,
            ),
        ] {
            if seconds == 0 || seconds > HARD_MAX_EVIDENCE_FRESHNESS_SECONDS_V2 {
                return Err(AgentEvidenceErrorV2::new(
                    AgentEvidenceErrorKindV2::InvalidFreshnessPolicy,
                    format!("{class:?} freshness exceeds the P2 hard boundary."),
                ));
            }
        }
        Ok(policy)
    }

    fn ttl_millis(self, class: AgentEvidenceFreshnessClassV2) -> u64 {
        let seconds = match class {
            AgentEvidenceFreshnessClassV2::ServiceStatus => self.service_status_seconds,
            AgentEvidenceFreshnessClassV2::ConfigValidation => self.config_validation_seconds,
            AgentEvidenceFreshnessClassV2::Listener => self.listener_seconds,
            AgentEvidenceFreshnessClassV2::TargetCapability => self.target_capability_seconds,
        };
        u64::from(seconds) * 1_000
    }

    pub(crate) fn is_fresh(
        self,
        class: AgentEvidenceFreshnessClassV2,
        observed_at: u64,
        now: u64,
    ) -> bool {
        is_fresh_v2(observed_at, now, self.ttl_millis(class))
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentStructuredServiceClaimsV2 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) load_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sub_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) config_valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) listening_ports: Option<Vec<u16>>,
}

impl AgentStructuredServiceClaimsV2 {
    fn freshness_class(&self) -> Result<AgentEvidenceFreshnessClassV2, AgentEvidenceErrorV2> {
        let status =
            self.load_state.is_some() || self.active_state.is_some() || self.sub_state.is_some();
        let config = self.config_valid.is_some();
        let listener = self.listening_ports.is_some();
        match (status, config, listener) {
            (true, false, false) => Ok(AgentEvidenceFreshnessClassV2::ServiceStatus),
            (false, true, false) => Ok(AgentEvidenceFreshnessClassV2::ConfigValidation),
            (false, false, true) => Ok(AgentEvidenceFreshnessClassV2::Listener),
            _ => Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::InvalidClaims,
                "One structured evidence record must contain exactly one claim class.",
            )),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentStructuredEvidenceV2 {
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) observed_at: u64,
    pub(crate) successful: bool,
    pub(crate) claims: AgentStructuredServiceClaimsV2,
    pub(crate) observation_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentServiceCapabilityEvidenceV2 {
    pub(crate) evidence_id: String,
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) observed_at: u64,
    pub(crate) successful: bool,
    pub(crate) target_capability: AgentTargetCapabilityV2,
    pub(crate) supported_actions: Vec<ServiceControlActionV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) validator: Option<ServiceValidatorV2>,
    pub(crate) reload_may_interrupt: bool,
    pub(crate) capability_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentStructuredEvidenceOriginV2 {
    ServiceStatus,
    ConfigValidation(ServiceValidatorV2),
    Listener,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentStructuredEvidenceRecordV2 {
    pub(crate) evidence: AgentStructuredEvidenceV2,
    pub(crate) origin: AgentStructuredEvidenceOriginV2,
    pub(crate) tool_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentServiceCapabilityRecordV2 {
    pub(crate) evidence: AgentServiceCapabilityEvidenceV2,
    pub(crate) tool_call_id: String,
}

pub(crate) struct AgentStructuredEvidenceCandidateV2<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) target_digest: &'a str,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) tool_call_id: &'a str,
    pub(crate) observed_at: u64,
    pub(crate) successful: bool,
    pub(crate) observation_complete: bool,
    pub(crate) claims: AgentStructuredServiceClaimsV2,
    pub(crate) origin: AgentStructuredEvidenceOriginV2,
    pub(crate) observation_digest: &'a str,
}

pub(crate) struct AgentServiceCapabilityCandidateV2<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) target_digest: &'a str,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) tool_call_id: &'a str,
    pub(crate) observed_at: u64,
    pub(crate) successful: bool,
    pub(crate) observation_complete: bool,
    pub(crate) target_capability: AgentTargetCapabilityV2,
    pub(crate) supported_actions: Vec<ServiceControlActionV2>,
    pub(crate) validator: Option<ServiceValidatorV2>,
    pub(crate) reload_may_interrupt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentEvidenceErrorKindV2 {
    RunMismatch,
    TargetMismatch,
    ResourceMismatch,
    DuplicateToolCall,
    DuplicateEvidence,
    InvalidClaims,
    InvalidObservation,
    InvalidFreshnessPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentEvidenceErrorV2 {
    pub(crate) kind: AgentEvidenceErrorKindV2,
    pub(crate) message: String,
}

impl AgentEvidenceErrorV2 {
    fn new(kind: AgentEvidenceErrorKindV2, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentStructuredEvidenceLedgerV2 {
    run_id: String,
    target_digest: String,
    freshness: AgentEvidenceFreshnessPolicyV2,
    records: BTreeMap<String, AgentStructuredEvidenceRecordV2>,
    capabilities: BTreeMap<String, AgentServiceCapabilityRecordV2>,
    tool_call_ids: HashSet<String>,
    next_evidence_sequence: usize,
    next_capability_sequence: usize,
}

impl AgentStructuredEvidenceLedgerV2 {
    pub(crate) fn new(
        run_id: impl Into<String>,
        target_digest: impl Into<String>,
        freshness: AgentEvidenceFreshnessPolicyV2,
    ) -> Result<Self, AgentEvidenceErrorV2> {
        let run_id = run_id.into();
        let target_digest = target_digest.into();
        if !valid_protocol_identifier_v2(&run_id) {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::RunMismatch,
                "The structured ledger requires one backend run identity.",
            ));
        }
        canonical_systemd_service_resource_v2(
            &target_digest,
            ServiceManagerV2::Systemd,
            "validation.service",
        )
        .map_err(|_| {
            AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::TargetMismatch,
                "The structured ledger requires one frozen target digest.",
            )
        })?;
        Ok(Self {
            run_id,
            target_digest,
            freshness: AgentEvidenceFreshnessPolicyV2::resolve(Some(freshness))?,
            records: BTreeMap::new(),
            capabilities: BTreeMap::new(),
            tool_call_ids: HashSet::new(),
            next_evidence_sequence: 1,
            next_capability_sequence: 1,
        })
    }

    pub(crate) fn record_structured_evidence(
        &mut self,
        candidate: AgentStructuredEvidenceCandidateV2<'_>,
    ) -> Result<AgentStructuredEvidenceV2, AgentEvidenceErrorV2> {
        self.validate_candidate_ownership(
            candidate.run_id,
            candidate.target_digest,
            &candidate.resource,
            candidate.tool_call_id,
        )?;
        let class = candidate.claims.freshness_class()?;
        let origin_class = match candidate.origin {
            AgentStructuredEvidenceOriginV2::ServiceStatus => {
                AgentEvidenceFreshnessClassV2::ServiceStatus
            }
            AgentStructuredEvidenceOriginV2::ConfigValidation(_) => {
                AgentEvidenceFreshnessClassV2::ConfigValidation
            }
            AgentStructuredEvidenceOriginV2::Listener => AgentEvidenceFreshnessClassV2::Listener,
        };
        if class != origin_class || !valid_digest_v2(candidate.observation_digest) {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::InvalidObservation,
                "Structured claims do not match their fixed backend parser origin.",
            ));
        }

        let evidence_id = format!(
            "evidence-v2-{}-{}",
            short_hash_v2(&self.run_id),
            self.next_evidence_sequence
        );
        if self.records.contains_key(&evidence_id) {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::DuplicateEvidence,
                "A structured evidence identity cannot be reused.",
            ));
        }
        let evidence = AgentStructuredEvidenceV2 {
            evidence_id: evidence_id.clone(),
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            resource: candidate.resource,
            observed_at: candidate.observed_at,
            successful: candidate.successful && candidate.observation_complete,
            claims: candidate.claims,
            observation_digest: candidate.observation_digest.to_string(),
        };
        self.records.insert(
            evidence_id,
            AgentStructuredEvidenceRecordV2 {
                evidence: evidence.clone(),
                origin: candidate.origin,
                tool_call_id: candidate.tool_call_id.to_string(),
            },
        );
        self.tool_call_ids
            .insert(candidate.tool_call_id.to_string());
        self.next_evidence_sequence += 1;
        Ok(evidence)
    }

    pub(crate) fn record_service_capability(
        &mut self,
        mut candidate: AgentServiceCapabilityCandidateV2<'_>,
    ) -> Result<AgentServiceCapabilityEvidenceV2, AgentEvidenceErrorV2> {
        self.validate_candidate_ownership(
            candidate.run_id,
            candidate.target_digest,
            &candidate.resource,
            candidate.tool_call_id,
        )?;
        if candidate
            .supported_actions
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != candidate.supported_actions.len()
        {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::InvalidClaims,
                "A capability cannot duplicate a supported action.",
            ));
        }
        if candidate.target_capability != AgentTargetCapabilityV2::PosixSystemd
            && (!candidate.supported_actions.is_empty()
                || candidate.validator.is_some()
                || candidate.reload_may_interrupt)
        {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::InvalidClaims,
                "Unsupported or unknown targets cannot claim systemd service capabilities.",
            ));
        }
        if candidate.reload_may_interrupt
            && !candidate
                .supported_actions
                .contains(&ServiceControlActionV2::Reload)
        {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::InvalidClaims,
                "Reload interruption metadata requires a supported reload action.",
            ));
        }
        candidate
            .supported_actions
            .sort_by_key(|action| service_action_rank_v2(*action));
        let evidence_id = format!(
            "capability-v2-{}-{}",
            short_hash_v2(&self.run_id),
            self.next_capability_sequence
        );
        let successful = candidate.successful && candidate.observation_complete;
        let capability_digest = sha256_v2(&(
            &self.run_id,
            &self.target_digest,
            &candidate.resource,
            candidate.observed_at,
            successful,
            candidate.target_capability,
            &candidate.supported_actions,
            candidate.validator,
            candidate.reload_may_interrupt,
        ));
        let evidence = AgentServiceCapabilityEvidenceV2 {
            evidence_id: evidence_id.clone(),
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            resource: candidate.resource,
            observed_at: candidate.observed_at,
            successful,
            target_capability: candidate.target_capability,
            supported_actions: candidate.supported_actions,
            validator: candidate.validator,
            reload_may_interrupt: candidate.reload_may_interrupt,
            capability_digest,
        };
        self.capabilities.insert(
            evidence_id,
            AgentServiceCapabilityRecordV2 {
                evidence: evidence.clone(),
                tool_call_id: candidate.tool_call_id.to_string(),
            },
        );
        self.tool_call_ids
            .insert(candidate.tool_call_id.to_string());
        self.next_capability_sequence += 1;
        Ok(evidence)
    }

    pub(crate) fn structured_evidence(&self) -> Vec<AgentStructuredEvidenceV2> {
        self.records
            .values()
            .map(|record| record.evidence.clone())
            .collect()
    }

    pub(crate) fn capability(&self, evidence_id: &str) -> Option<&AgentServiceCapabilityRecordV2> {
        self.capabilities.get(evidence_id)
    }

    pub(crate) fn validate_service_capability(
        &self,
        evidence_id: &str,
        resource: &AgentResourceRefV2,
        action: ServiceControlActionV2,
        now: u64,
    ) -> Result<&AgentServiceCapabilityRecordV2, AgentPreconditionErrorV2> {
        let record = self.capability(evidence_id).ok_or_else(|| {
            precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::CapabilityMissing,
            )
        })?;
        let evidence = &record.evidence;
        if evidence.run_id != self.run_id {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::RunMismatch,
            ));
        }
        if evidence.target_digest != self.target_digest {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::TargetMismatch,
            ));
        }
        if &evidence.resource != resource {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::ResourceMismatch,
            ));
        }
        if !evidence.successful
            || evidence.target_capability != AgentTargetCapabilityV2::PosixSystemd
        {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::CapabilityUnsupported,
            ));
        }
        if !evidence.supported_actions.contains(&action) {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::ActionUnsupported,
            ));
        }
        if !self.freshness.is_fresh(
            AgentEvidenceFreshnessClassV2::TargetCapability,
            evidence.observed_at,
            now,
        ) {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::StaleEvidence,
                AgentPreconditionFailureReasonV2::CapabilityStale,
            ));
        }
        Ok(record)
    }

    fn validate_candidate_ownership(
        &self,
        run_id: &str,
        target_digest: &str,
        resource: &AgentResourceRefV2,
        tool_call_id: &str,
    ) -> Result<(), AgentEvidenceErrorV2> {
        if run_id != self.run_id {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::RunMismatch,
                "Structured evidence belongs to a different run.",
            ));
        }
        if target_digest != self.target_digest || resource.target_digest != self.target_digest {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::TargetMismatch,
                "Structured evidence belongs to a different frozen target.",
            ));
        }
        let unit = resource.identity.strip_prefix("systemd:").ok_or_else(|| {
            AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::ResourceMismatch,
                "Structured evidence has a non-authoritative resource identity.",
            )
        })?;
        let authoritative = canonical_systemd_service_resource_v2(
            &self.target_digest,
            ServiceManagerV2::Systemd,
            unit,
        )
        .map_err(|_| {
            AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::ResourceMismatch,
                "Structured evidence has an invalid resource identity.",
            )
        })?;
        if &authoritative != resource {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::ResourceMismatch,
                "Structured evidence resource does not match backend normalization.",
            ));
        }
        if !valid_protocol_identifier_v2(tool_call_id) || self.tool_call_ids.contains(tool_call_id)
        {
            return Err(AgentEvidenceErrorV2::new(
                AgentEvidenceErrorKindV2::DuplicateToolCall,
                "One fixed backend tool call can create at most one structured record.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn parse_systemd_show_claims_v2(
    output: &str,
    requested_fields: &[ServiceInspectFieldV2],
) -> Result<AgentStructuredServiceClaimsV2, AgentEvidenceErrorV2> {
    if output.is_empty()
        || output.len() > MAX_SYSTEMD_SHOW_BYTES_V2
        || requested_fields.is_empty()
        || requested_fields
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != requested_fields.len()
    {
        return Err(invalid_observation(
            "The fixed systemd observation is invalid.",
        ));
    }
    let expected = requested_fields
        .iter()
        .map(|field| match field {
            ServiceInspectFieldV2::LoadState => "LoadState",
            ServiceInspectFieldV2::ActiveState => "ActiveState",
            ServiceInspectFieldV2::SubState => "SubState",
            ServiceInspectFieldV2::MainPid => "MainPID",
            ServiceInspectFieldV2::Result => "Result",
        })
        .collect::<HashSet<_>>();
    let mut parsed = BTreeMap::new();
    for line in output.lines() {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| invalid_observation("systemctl show returned a malformed property."))?;
        if !expected.contains(key)
            || parsed.insert(key, value).is_some()
            || value.is_empty()
            || value.len() > 128
            || !value.is_ascii()
            || value.chars().any(char::is_control)
        {
            return Err(invalid_observation(
                "systemctl show returned an unknown, duplicate, or invalid property.",
            ));
        }
    }
    if parsed.len() != expected.len() {
        return Err(invalid_observation(
            "systemctl show did not return every fixed requested property.",
        ));
    }
    if let Some(main_pid) = parsed.get("MainPID") {
        main_pid
            .parse::<u32>()
            .map_err(|_| invalid_observation("systemctl show returned an invalid MainPID."))?;
    }
    let claims = AgentStructuredServiceClaimsV2 {
        load_state: parsed.get("LoadState").map(|value| (*value).to_string()),
        active_state: parsed.get("ActiveState").map(|value| (*value).to_string()),
        sub_state: parsed.get("SubState").map(|value| (*value).to_string()),
        config_valid: None,
        listening_ports: None,
    };
    claims.freshness_class()?;
    Ok(claims)
}

pub(crate) fn parse_config_validation_claims_v2(exit_code: i32) -> AgentStructuredServiceClaimsV2 {
    AgentStructuredServiceClaimsV2 {
        config_valid: Some(exit_code == 0),
        ..AgentStructuredServiceClaimsV2::default()
    }
}

pub(crate) fn parse_listener_claims_v2(
    ports: &[u16],
) -> Result<AgentStructuredServiceClaimsV2, AgentEvidenceErrorV2> {
    if ports.len() > MAX_LISTENER_PORTS_V2 || ports.contains(&0) {
        return Err(invalid_observation(
            "The fixed listener observation exceeds its bounded port set.",
        ));
    }
    let mut normalized = ports.to_vec();
    normalized.sort_unstable();
    normalized.dedup();
    if normalized.len() != ports.len() {
        return Err(invalid_observation(
            "The fixed listener observation contains duplicate ports.",
        ));
    }
    Ok(AgentStructuredServiceClaimsV2 {
        listening_ports: Some(normalized),
        ..AgentStructuredServiceClaimsV2::default()
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPreconditionErrorCategoryV2 {
    StaleEvidence,
    PreconditionFailed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentPreconditionFailureReasonV2 {
    RunMismatch,
    TargetMismatch,
    ResourceMismatch,
    CapabilityMissing,
    CapabilityUnsupported,
    CapabilityStale,
    ActionUnsupported,
    EvidenceMissing,
    EvidenceUnknown,
    EvidenceFailed,
    EvidenceStale,
    EvidenceDigestChanged,
    ConflictingClaims,
    StatusEvidenceRequired,
    ConfigEvidenceRequired,
    ConfigValidatorMismatch,
    UnitNotLoaded,
    UnitAlreadyActive,
    UnitNotActive,
    UnitNotActiveOrFailed,
    ConfigInvalid,
    StopIntentMissing,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPreconditionErrorV2 {
    pub(crate) category: AgentPreconditionErrorCategoryV2,
    pub(crate) reason: AgentPreconditionFailureReasonV2,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPreconditionValidationV2 {
    pub(crate) run_id: String,
    pub(crate) target_digest: String,
    pub(crate) resource: AgentResourceRefV2,
    pub(crate) action: ServiceControlActionV2,
    pub(crate) capability_evidence_id: String,
    pub(crate) evidence_ids: Vec<String>,
    pub(crate) evidence_set_digest: String,
    pub(crate) validated_at: u64,
}

pub(crate) struct AgentServiceControlPreconditionRequestV2<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) target_digest: &'a str,
    pub(crate) arguments: &'a ServiceControlArgsV2,
    pub(crate) capability_evidence_id: &'a str,
    pub(crate) evidence_ids: &'a [String],
    pub(crate) expected_evidence_set_digest: Option<&'a str>,
    pub(crate) user_goal_explicitly_requests_stop: bool,
    pub(crate) now: u64,
}

impl AgentStructuredEvidenceLedgerV2 {
    pub(crate) fn validate_service_control_preconditions(
        &self,
        request: AgentServiceControlPreconditionRequestV2<'_>,
    ) -> Result<AgentPreconditionValidationV2, AgentPreconditionErrorV2> {
        if request.run_id != self.run_id {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::RunMismatch,
            ));
        }
        if request.target_digest != self.target_digest {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::TargetMismatch,
            ));
        }
        let resource = canonical_systemd_service_resource_v2(
            &self.target_digest,
            request.arguments.manager,
            &request.arguments.unit,
        )
        .map_err(|_| {
            precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::ResourceMismatch,
            )
        })?;
        let capability = self.validate_service_capability(
            request.capability_evidence_id,
            &resource,
            request.arguments.action,
            request.now,
        )?;

        if request.evidence_ids.is_empty() {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::EvidenceMissing,
            ));
        }
        let mut unique = HashSet::new();
        let mut selected = Vec::new();
        for evidence_id in request.evidence_ids {
            if !unique.insert(evidence_id.as_str()) {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConflictingClaims,
                ));
            }
            let record = self.records.get(evidence_id).ok_or_else(|| {
                precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::EvidenceUnknown,
                )
            })?;
            if record.evidence.run_id != self.run_id {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::RunMismatch,
                ));
            }
            if record.evidence.target_digest != self.target_digest {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::TargetMismatch,
                ));
            }
            if record.evidence.resource != resource {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ResourceMismatch,
                ));
            }
            if !record.evidence.successful {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::EvidenceFailed,
                ));
            }
            let class = record.evidence.claims.freshness_class().map_err(|_| {
                precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConflictingClaims,
                )
            })?;
            if !self
                .freshness
                .is_fresh(class, record.evidence.observed_at, request.now)
            {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::StaleEvidence,
                    AgentPreconditionFailureReasonV2::EvidenceStale,
                ));
            }
            selected.push(record);
        }

        let claims = merge_claims_v2(&selected)?;
        let active_state = claims.active_state.as_deref();
        let config_required = match request.arguments.action {
            ServiceControlActionV2::Start => capability.evidence.validator.is_some(),
            ServiceControlActionV2::Reload | ServiceControlActionV2::Restart => true,
            ServiceControlActionV2::Stop => false,
        };
        if config_required {
            let expected_validator = capability.evidence.validator.ok_or_else(|| {
                precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConfigEvidenceRequired,
                )
            })?;
            let config_records = selected
                .iter()
                .filter_map(|record| match record.origin {
                    AgentStructuredEvidenceOriginV2::ConfigValidation(validator) => Some(validator),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if config_records.is_empty() || claims.config_valid.is_none() {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConfigEvidenceRequired,
                ));
            }
            if config_records
                .iter()
                .any(|validator| *validator != expected_validator)
            {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConfigValidatorMismatch,
                ));
            }
            if claims.config_valid != Some(true) {
                return Err(precondition_error(
                    AgentPreconditionErrorCategoryV2::PreconditionFailed,
                    AgentPreconditionFailureReasonV2::ConfigInvalid,
                ));
            }
        }

        match request.arguments.action {
            ServiceControlActionV2::Start => {
                if claims.load_state.as_deref() != Some("loaded") {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::UnitNotLoaded,
                    ));
                }
                let Some(active_state) = active_state else {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::StatusEvidenceRequired,
                    ));
                };
                if active_state == "active" {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::UnitAlreadyActive,
                    ));
                }
            }
            ServiceControlActionV2::Reload => {
                if active_state != Some("active") {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::UnitNotActive,
                    ));
                }
            }
            ServiceControlActionV2::Restart => {
                if !matches!(active_state, Some("active" | "failed")) {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::UnitNotActiveOrFailed,
                    ));
                }
            }
            ServiceControlActionV2::Stop => {
                if active_state != Some("active") {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::UnitNotActive,
                    ));
                }
                if !request.user_goal_explicitly_requests_stop {
                    return Err(precondition_error(
                        AgentPreconditionErrorCategoryV2::PreconditionFailed,
                        AgentPreconditionFailureReasonV2::StopIntentMissing,
                    ));
                }
            }
        }

        let mut evidence_bindings = selected
            .iter()
            .map(|record| {
                (
                    record.evidence.evidence_id.as_str(),
                    record.evidence.observation_digest.as_str(),
                )
            })
            .collect::<Vec<_>>();
        evidence_bindings.sort_unstable();
        let evidence_set_digest = sha256_v2(&(
            &self.run_id,
            &self.target_digest,
            &resource,
            request.arguments.action,
            request.capability_evidence_id,
            &capability.evidence.capability_digest,
            &evidence_bindings,
        ));
        if request
            .expected_evidence_set_digest
            .is_some_and(|expected| expected != evidence_set_digest)
        {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::StaleEvidence,
                AgentPreconditionFailureReasonV2::EvidenceDigestChanged,
            ));
        }

        Ok(AgentPreconditionValidationV2 {
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            resource,
            action: request.arguments.action,
            capability_evidence_id: request.capability_evidence_id.to_string(),
            evidence_ids: request.evidence_ids.to_vec(),
            evidence_set_digest,
            validated_at: request.now,
        })
    }
}

fn merge_claims_v2(
    records: &[&AgentStructuredEvidenceRecordV2],
) -> Result<AgentStructuredServiceClaimsV2, AgentPreconditionErrorV2> {
    let mut merged = AgentStructuredServiceClaimsV2::default();
    for record in records {
        merge_optional_claim_v2(&mut merged.load_state, &record.evidence.claims.load_state)?;
        merge_optional_claim_v2(
            &mut merged.active_state,
            &record.evidence.claims.active_state,
        )?;
        merge_optional_claim_v2(&mut merged.sub_state, &record.evidence.claims.sub_state)?;
        merge_optional_claim_v2(
            &mut merged.config_valid,
            &record.evidence.claims.config_valid,
        )?;
        merge_optional_claim_v2(
            &mut merged.listening_ports,
            &record.evidence.claims.listening_ports,
        )?;
    }
    Ok(merged)
}

fn merge_optional_claim_v2<T: Clone + PartialEq>(
    destination: &mut Option<T>,
    candidate: &Option<T>,
) -> Result<(), AgentPreconditionErrorV2> {
    if let Some(candidate) = candidate {
        if destination
            .as_ref()
            .is_some_and(|current| current != candidate)
        {
            return Err(precondition_error(
                AgentPreconditionErrorCategoryV2::PreconditionFailed,
                AgentPreconditionFailureReasonV2::ConflictingClaims,
            ));
        }
        *destination = Some(candidate.clone());
    }
    Ok(())
}

fn is_fresh_v2(observed_at: u64, now: u64, ttl_millis: u64) -> bool {
    now.checked_sub(observed_at)
        .is_some_and(|age| age <= ttl_millis)
}

fn service_action_rank_v2(action: ServiceControlActionV2) -> u8 {
    match action {
        ServiceControlActionV2::Start => 0,
        ServiceControlActionV2::Reload => 1,
        ServiceControlActionV2::Restart => 2,
        ServiceControlActionV2::Stop => 3,
    }
}

fn precondition_error(
    category: AgentPreconditionErrorCategoryV2,
    reason: AgentPreconditionFailureReasonV2,
) -> AgentPreconditionErrorV2 {
    AgentPreconditionErrorV2 { category, reason }
}

fn invalid_observation(message: impl Into<String>) -> AgentEvidenceErrorV2 {
    AgentEvidenceErrorV2::new(AgentEvidenceErrorKindV2::InvalidObservation, message)
}

fn valid_digest_v2(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
}

fn valid_protocol_identifier_v2(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.is_ascii()
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
}

fn short_hash_v2(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_v2<T: Serialize>(value: &T) -> String {
    let canonical = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(canonical);
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256-v2:{digest_hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN: &str = "run-1";
    const TARGET: &str = "sha256-v1:target-1";
    const NOW: u64 = 1_000_000;

    fn resource(unit: &str) -> AgentResourceRefV2 {
        canonical_systemd_service_resource_v2(TARGET, ServiceManagerV2::Systemd, unit).unwrap()
    }

    fn ledger() -> AgentStructuredEvidenceLedgerV2 {
        AgentStructuredEvidenceLedgerV2::new(RUN, TARGET, AgentEvidenceFreshnessPolicyV2::default())
            .unwrap()
    }

    fn control(action: ServiceControlActionV2) -> ServiceControlArgsV2 {
        ServiceControlArgsV2 {
            manager: ServiceManagerV2::Systemd,
            unit: "nginx.service".to_string(),
            action,
            timeout_seconds: Some(30),
            verification_hints: None,
        }
    }

    fn record_capability(
        ledger: &mut AgentStructuredEvidenceLedgerV2,
    ) -> AgentServiceCapabilityEvidenceV2 {
        ledger
            .record_service_capability(AgentServiceCapabilityCandidateV2 {
                run_id: RUN,
                target_digest: TARGET,
                resource: resource("nginx.service"),
                tool_call_id: "capability-tool-1",
                observed_at: NOW - 1_000,
                successful: true,
                observation_complete: true,
                target_capability: AgentTargetCapabilityV2::PosixSystemd,
                supported_actions: vec![
                    ServiceControlActionV2::Start,
                    ServiceControlActionV2::Reload,
                    ServiceControlActionV2::Restart,
                    ServiceControlActionV2::Stop,
                ],
                validator: Some(ServiceValidatorV2::Nginx),
                reload_may_interrupt: false,
            })
            .unwrap()
    }

    fn record_status(
        ledger: &mut AgentStructuredEvidenceLedgerV2,
        tool_call_id: &str,
        active_state: &str,
        observed_at: u64,
    ) -> AgentStructuredEvidenceV2 {
        ledger
            .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
                run_id: RUN,
                target_digest: TARGET,
                resource: resource("nginx.service"),
                tool_call_id,
                observed_at,
                successful: true,
                observation_complete: true,
                claims: AgentStructuredServiceClaimsV2 {
                    load_state: Some("loaded".to_string()),
                    active_state: Some(active_state.to_string()),
                    sub_state: Some(
                        if active_state == "active" {
                            "running"
                        } else {
                            "dead"
                        }
                        .to_string(),
                    ),
                    ..AgentStructuredServiceClaimsV2::default()
                },
                origin: AgentStructuredEvidenceOriginV2::ServiceStatus,
                observation_digest: "sha256-v1:status",
            })
            .unwrap()
    }

    fn record_config(
        ledger: &mut AgentStructuredEvidenceLedgerV2,
        tool_call_id: &str,
        valid: bool,
    ) -> AgentStructuredEvidenceV2 {
        ledger
            .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
                run_id: RUN,
                target_digest: TARGET,
                resource: resource("nginx.service"),
                tool_call_id,
                observed_at: NOW - 1_000,
                successful: true,
                observation_complete: true,
                claims: AgentStructuredServiceClaimsV2 {
                    config_valid: Some(valid),
                    ..AgentStructuredServiceClaimsV2::default()
                },
                origin: AgentStructuredEvidenceOriginV2::ConfigValidation(
                    ServiceValidatorV2::Nginx,
                ),
                observation_digest: "sha256-v1:config",
            })
            .unwrap()
    }

    #[test]
    fn fixed_parsers_create_only_bounded_claim_classes() {
        let status = parse_systemd_show_claims_v2(
            "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\n",
            &[
                ServiceInspectFieldV2::LoadState,
                ServiceInspectFieldV2::ActiveState,
                ServiceInspectFieldV2::SubState,
                ServiceInspectFieldV2::MainPid,
                ServiceInspectFieldV2::Result,
            ],
        )
        .unwrap();
        assert_eq!(status.load_state.as_deref(), Some("loaded"));
        assert_eq!(status.active_state.as_deref(), Some("inactive"));
        assert!(parse_systemd_show_claims_v2(
            "LoadState=loaded\nInjected=active\n",
            &[ServiceInspectFieldV2::LoadState],
        )
        .is_err());
        assert_eq!(
            parse_config_validation_claims_v2(1).config_valid,
            Some(false)
        );
        assert_eq!(
            parse_listener_claims_v2(&[443, 80])
                .unwrap()
                .listening_ports,
            Some(vec![80, 443])
        );
        assert!(parse_listener_claims_v2(&[80, 80]).is_err());
    }

    #[test]
    fn ledger_enforces_same_run_target_resource_and_complete_observation() {
        let mut ledger = ledger();
        let claims = AgentStructuredServiceClaimsV2 {
            active_state: Some("inactive".to_string()),
            ..AgentStructuredServiceClaimsV2::default()
        };
        let candidate =
            |run_id, target_digest, resource, tool_call_id| AgentStructuredEvidenceCandidateV2 {
                run_id,
                target_digest,
                resource,
                tool_call_id,
                observed_at: NOW,
                successful: true,
                observation_complete: true,
                claims: claims.clone(),
                origin: AgentStructuredEvidenceOriginV2::ServiceStatus,
                observation_digest: "sha256-v1:status",
            };
        assert_eq!(
            ledger
                .record_structured_evidence(candidate(
                    "run-2",
                    TARGET,
                    resource("nginx.service"),
                    "tool-1"
                ))
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV2::RunMismatch
        );
        assert_eq!(
            ledger
                .record_structured_evidence(candidate(
                    RUN,
                    "sha256-v1:other",
                    resource("nginx.service"),
                    "tool-1"
                ))
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV2::TargetMismatch
        );
        assert_eq!(
            ledger
                .record_structured_evidence(candidate(
                    RUN,
                    TARGET,
                    resource("sshd.service"),
                    "tool-1"
                ))
                .unwrap()
                .resource
                .identity,
            "systemd:sshd.service"
        );
        assert_eq!(ledger.structured_evidence().len(), 1);
        assert_eq!(
            ledger
                .record_structured_evidence(candidate(
                    RUN,
                    TARGET,
                    resource("nginx.service"),
                    "tool-1"
                ))
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV2::DuplicateToolCall
        );

        let incomplete = ledger
            .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
                observation_complete: false,
                tool_call_id: "tool-2",
                ..candidate(RUN, TARGET, resource("nginx.service"), "unused")
            })
            .unwrap();
        assert!(!incomplete.successful);
    }

    #[test]
    fn documented_freshness_defaults_and_hard_cap_fail_closed() {
        assert_eq!(
            AgentEvidenceFreshnessPolicyV2::default(),
            AgentEvidenceFreshnessPolicyV2 {
                service_status_seconds: 120,
                config_validation_seconds: 120,
                listener_seconds: 60,
                target_capability_seconds: 300,
            }
        );
        assert!(
            AgentEvidenceFreshnessPolicyV2::resolve(Some(AgentEvidenceFreshnessPolicyV2 {
                service_status_seconds: 301,
                ..AgentEvidenceFreshnessPolicyV2::default()
            }))
            .is_err()
        );
        assert!(!AgentEvidenceFreshnessPolicyV2::default().is_fresh(
            AgentEvidenceFreshnessClassV2::ServiceStatus,
            NOW + 1,
            NOW,
        ));
    }

    #[test]
    fn start_reload_restart_and_stop_preconditions_match_the_design_matrix() {
        let mut start_ledger = ledger();
        let capability = record_capability(&mut start_ledger);
        let inactive = record_status(
            &mut start_ledger,
            "status-inactive",
            "inactive",
            NOW - 1_000,
        );
        let config = record_config(&mut start_ledger, "config-valid", true);
        let start_ids = vec![inactive.evidence_id.clone(), config.evidence_id.clone()];
        assert!(start_ledger
            .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                run_id: RUN,
                target_digest: TARGET,
                arguments: &control(ServiceControlActionV2::Start),
                capability_evidence_id: &capability.evidence_id,
                evidence_ids: &start_ids,
                expected_evidence_set_digest: None,
                user_goal_explicitly_requests_stop: false,
                now: NOW,
            })
            .is_ok());

        let mut active_ledger = ledger();
        let capability = record_capability(&mut active_ledger);
        let active = record_status(&mut active_ledger, "status-active", "active", NOW - 1_000);
        let config = record_config(&mut active_ledger, "config-valid", true);
        let active_ids = vec![active.evidence_id, config.evidence_id];
        for action in [
            ServiceControlActionV2::Reload,
            ServiceControlActionV2::Restart,
        ] {
            assert!(active_ledger
                .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    arguments: &control(action),
                    capability_evidence_id: &capability.evidence_id,
                    evidence_ids: &active_ids,
                    expected_evidence_set_digest: None,
                    user_goal_explicitly_requests_stop: false,
                    now: NOW,
                })
                .is_ok());
        }
        let stop_without_intent = active_ledger
            .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                run_id: RUN,
                target_digest: TARGET,
                arguments: &control(ServiceControlActionV2::Stop),
                capability_evidence_id: &capability.evidence_id,
                evidence_ids: &active_ids,
                expected_evidence_set_digest: None,
                user_goal_explicitly_requests_stop: false,
                now: NOW,
            })
            .unwrap_err();
        assert_eq!(
            stop_without_intent.reason,
            AgentPreconditionFailureReasonV2::StopIntentMissing
        );
    }

    #[test]
    fn stale_failed_conflicting_invalid_config_and_digest_drift_are_rejected() {
        let mut stale_ledger = ledger();
        let capability = record_capability(&mut stale_ledger);
        let stale = record_status(&mut stale_ledger, "status-stale", "inactive", NOW - 120_001);
        let config = record_config(&mut stale_ledger, "config-valid", true);
        let ids = vec![stale.evidence_id, config.evidence_id];
        let stale_error = stale_ledger
            .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                run_id: RUN,
                target_digest: TARGET,
                arguments: &control(ServiceControlActionV2::Start),
                capability_evidence_id: &capability.evidence_id,
                evidence_ids: &ids,
                expected_evidence_set_digest: None,
                user_goal_explicitly_requests_stop: false,
                now: NOW,
            })
            .unwrap_err();
        assert_eq!(
            stale_error.category,
            AgentPreconditionErrorCategoryV2::StaleEvidence
        );

        let mut invalid_ledger = ledger();
        let capability = record_capability(&mut invalid_ledger);
        let inactive = record_status(&mut invalid_ledger, "status-inactive", "inactive", NOW);
        let invalid = record_config(&mut invalid_ledger, "config-invalid", false);
        let ids = vec![inactive.evidence_id, invalid.evidence_id];
        assert_eq!(
            invalid_ledger
                .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    arguments: &control(ServiceControlActionV2::Start),
                    capability_evidence_id: &capability.evidence_id,
                    evidence_ids: &ids,
                    expected_evidence_set_digest: None,
                    user_goal_explicitly_requests_stop: false,
                    now: NOW,
                })
                .unwrap_err()
                .reason,
            AgentPreconditionFailureReasonV2::ConfigInvalid
        );

        let mut valid_ledger = ledger();
        let capability = record_capability(&mut valid_ledger);
        let inactive = record_status(&mut valid_ledger, "status", "inactive", NOW);
        let config = record_config(&mut valid_ledger, "config", true);
        let ids = vec![inactive.evidence_id, config.evidence_id];
        assert_eq!(
            valid_ledger
                .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    arguments: &control(ServiceControlActionV2::Start),
                    capability_evidence_id: &capability.evidence_id,
                    evidence_ids: &ids,
                    expected_evidence_set_digest: Some("sha256-v2:drift"),
                    user_goal_explicitly_requests_stop: false,
                    now: NOW,
                })
                .unwrap_err()
                .reason,
            AgentPreconditionFailureReasonV2::EvidenceDigestChanged
        );
    }

    #[test]
    fn failed_truncated_conflicting_and_stale_config_or_listener_evidence_fail_closed() {
        let mut failed_ledger = ledger();
        let capability = record_capability(&mut failed_ledger);
        let truncated = failed_ledger
            .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
                run_id: RUN,
                target_digest: TARGET,
                resource: resource("nginx.service"),
                tool_call_id: "status-truncated",
                observed_at: NOW,
                successful: true,
                observation_complete: false,
                claims: AgentStructuredServiceClaimsV2 {
                    load_state: Some("loaded".to_string()),
                    active_state: Some("inactive".to_string()),
                    ..AgentStructuredServiceClaimsV2::default()
                },
                origin: AgentStructuredEvidenceOriginV2::ServiceStatus,
                observation_digest: "sha256-v1:truncated",
            })
            .unwrap();
        let config = record_config(&mut failed_ledger, "config", true);
        let ids = vec![truncated.evidence_id, config.evidence_id];
        assert_eq!(
            failed_ledger
                .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    arguments: &control(ServiceControlActionV2::Start),
                    capability_evidence_id: &capability.evidence_id,
                    evidence_ids: &ids,
                    expected_evidence_set_digest: None,
                    user_goal_explicitly_requests_stop: false,
                    now: NOW,
                })
                .unwrap_err()
                .reason,
            AgentPreconditionFailureReasonV2::EvidenceFailed
        );

        let mut conflict_ledger = ledger();
        let capability = record_capability(&mut conflict_ledger);
        let inactive = record_status(&mut conflict_ledger, "status-1", "inactive", NOW);
        let active = record_status(&mut conflict_ledger, "status-2", "active", NOW);
        let config = record_config(&mut conflict_ledger, "config", true);
        let ids = vec![inactive.evidence_id, active.evidence_id, config.evidence_id];
        assert_eq!(
            conflict_ledger
                .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    arguments: &control(ServiceControlActionV2::Start),
                    capability_evidence_id: &capability.evidence_id,
                    evidence_ids: &ids,
                    expected_evidence_set_digest: None,
                    user_goal_explicitly_requests_stop: false,
                    now: NOW,
                })
                .unwrap_err()
                .reason,
            AgentPreconditionFailureReasonV2::ConflictingClaims
        );

        for (origin, claims, age) in [
            (
                AgentStructuredEvidenceOriginV2::ConfigValidation(ServiceValidatorV2::Nginx),
                AgentStructuredServiceClaimsV2 {
                    config_valid: Some(true),
                    ..AgentStructuredServiceClaimsV2::default()
                },
                120_001,
            ),
            (
                AgentStructuredEvidenceOriginV2::Listener,
                AgentStructuredServiceClaimsV2 {
                    listening_ports: Some(vec![80]),
                    ..AgentStructuredServiceClaimsV2::default()
                },
                60_001,
            ),
        ] {
            let mut stale_ledger = ledger();
            let capability = record_capability(&mut stale_ledger);
            let status = record_status(&mut stale_ledger, "status", "inactive", NOW);
            let stale = stale_ledger
                .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
                    run_id: RUN,
                    target_digest: TARGET,
                    resource: resource("nginx.service"),
                    tool_call_id: "stale-tool",
                    observed_at: NOW - age,
                    successful: true,
                    observation_complete: true,
                    claims,
                    origin,
                    observation_digest: "sha256-v1:stale",
                })
                .unwrap();
            let ids = vec![status.evidence_id, stale.evidence_id];
            assert_eq!(
                stale_ledger
                    .validate_service_control_preconditions(
                        AgentServiceControlPreconditionRequestV2 {
                            run_id: RUN,
                            target_digest: TARGET,
                            arguments: &control(ServiceControlActionV2::Start),
                            capability_evidence_id: &capability.evidence_id,
                            evidence_ids: &ids,
                            expected_evidence_set_digest: None,
                            user_goal_explicitly_requests_stop: false,
                            now: NOW,
                        }
                    )
                    .unwrap_err()
                    .category,
                AgentPreconditionErrorCategoryV2::StaleEvidence
            );
        }
    }
}
