use super::admission_v2::AgentTargetCapabilityV2;
use super::evidence_v2::{
    AgentEvidenceFreshnessClassV2, AgentEvidenceFreshnessPolicyV2, AgentPreconditionErrorV2,
    AgentPreconditionFailureReasonV2, AgentPreconditionValidationV2,
    AgentServiceCapabilityCandidateV2, AgentServiceCapabilityEvidenceV2,
    AgentServiceControlPreconditionRequestV2, AgentStructuredEvidenceCandidateV2,
    AgentStructuredEvidenceLedgerV2, AgentStructuredEvidenceOriginV2, AgentStructuredEvidenceV2,
    AgentStructuredServiceClaimsV2,
};
use super::policy_v2::{
    resolve_effective_policy_v2, AgentEffectivePolicySourcesV2, AgentEffectivePolicyV2,
};
use super::protocol_v2::{
    AgentPolicyModeV2, AgentRiskAssessmentV2, AgentRiskConfidenceV2, AgentRiskSeverityV2,
    AgentRiskVerdictV2, ServiceControlActionV2, ServiceControlArgsV2, ServiceManagerV2,
    ServiceValidatorV2,
};
use super::resource_v2::canonical_systemd_service_resource_v2;
use super::risk_v2::{
    AgentDeniedOperationClassV2, AgentLocalRiskOperationV2, AgentRiskAssessmentRequestV2,
    AgentRiskEngineV2, AgentUntrustedModelRiskClaimV2,
};
use serde::Deserialize;

const RUN: &str = "run-1";
const TARGET: &str = "sha256-v1:target-1";
const NOW: u64 = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SafetyFixtureV2 {
    schema_version: u8,
    freshness_policy: AgentEvidenceFreshnessPolicyV2,
    freshness_cases: Vec<FreshnessFixtureCaseV2>,
    effective_policy_cases: Vec<EffectivePolicyFixtureCaseV2>,
    structured_evidence_projections: Vec<AgentStructuredEvidenceV2>,
    capability_projection: AgentServiceCapabilityEvidenceV2,
    precondition_validation_projection: AgentPreconditionValidationV2,
    precondition_error_projections: Vec<AgentPreconditionErrorV2>,
    precondition_cases: Vec<PreconditionFixtureCaseV2>,
    ownership_cases: Vec<OwnershipFixtureCaseV2>,
    risk_cases: Vec<RiskFixtureCaseV2>,
    risk_projection: AgentRiskAssessmentV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FreshnessFixtureCaseV2 {
    class: AgentEvidenceFreshnessClassV2,
    age_millis: u64,
    expected_fresh: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EffectivePolicyFixtureCaseV2 {
    name: String,
    sources: AgentEffectivePolicySourcesV2,
    expected: AgentEffectivePolicyV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreconditionFixtureCaseV2 {
    name: String,
    action: ServiceControlActionV2,
    load_state: String,
    active_state: String,
    config_valid: bool,
    status_age_millis: u64,
    capability_age_millis: u64,
    explicit_stop_intent: bool,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipFixtureCaseV2 {
    name: String,
    dimension: String,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RiskFixtureCaseV2 {
    name: String,
    operation: String,
    model_claims_read_only: bool,
    expected_severity: AgentRiskSeverityV2,
    expected_confidence: AgentRiskConfidenceV2,
    expected_verdict: AgentRiskVerdictV2,
    expected_write: bool,
    expected_service_interruption: bool,
}

fn fixture() -> SafetyFixtureV2 {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/agent-protocol/v2/risk-evidence-preconditions.json"
    ))
    .expect("shared P2-A safety fixture must decode strictly")
}

fn resource(unit: &str) -> super::protocol_v2::AgentResourceRefV2 {
    canonical_systemd_service_resource_v2(TARGET, ServiceManagerV2::Systemd, unit).unwrap()
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
    observed_at: u64,
) -> AgentServiceCapabilityEvidenceV2 {
    ledger
        .record_service_capability(AgentServiceCapabilityCandidateV2 {
            run_id: RUN,
            target_digest: TARGET,
            resource: resource("nginx.service"),
            tool_call_id: "capability-tool",
            observed_at,
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
    target_resource: super::protocol_v2::AgentResourceRefV2,
    observed_at: u64,
    load_state: &str,
    active_state: &str,
) -> AgentStructuredEvidenceV2 {
    ledger
        .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
            run_id: RUN,
            target_digest: TARGET,
            resource: target_resource,
            tool_call_id: "status-tool",
            observed_at,
            successful: true,
            observation_complete: true,
            claims: AgentStructuredServiceClaimsV2 {
                load_state: Some(load_state.to_string()),
                active_state: Some(active_state.to_string()),
                sub_state: Some("fixture".to_string()),
                ..AgentStructuredServiceClaimsV2::default()
            },
            origin: AgentStructuredEvidenceOriginV2::ServiceStatus,
            observation_digest: "sha256-v1:status",
        })
        .unwrap()
}

fn record_config(
    ledger: &mut AgentStructuredEvidenceLedgerV2,
    valid: bool,
) -> AgentStructuredEvidenceV2 {
    ledger
        .record_structured_evidence(AgentStructuredEvidenceCandidateV2 {
            run_id: RUN,
            target_digest: TARGET,
            resource: resource("nginx.service"),
            tool_call_id: "config-tool",
            observed_at: NOW - 1_000,
            successful: true,
            observation_complete: true,
            claims: AgentStructuredServiceClaimsV2 {
                config_valid: Some(valid),
                ..AgentStructuredServiceClaimsV2::default()
            },
            origin: AgentStructuredEvidenceOriginV2::ConfigValidation(ServiceValidatorV2::Nginx),
            observation_digest: "sha256-v1:config",
        })
        .unwrap()
}

#[test]
fn shared_fixture_projects_structured_contracts_and_documented_defaults() {
    let fixture = fixture();
    assert_eq!(fixture.schema_version, 2);
    assert_eq!(
        fixture.freshness_policy,
        AgentEvidenceFreshnessPolicyV2::default()
    );
    assert_eq!(fixture.structured_evidence_projections.len(), 3);
    for evidence in fixture.structured_evidence_projections {
        assert_eq!(evidence.run_id, RUN);
        assert_eq!(evidence.target_digest, TARGET);
        assert_eq!(evidence.resource.target_digest, TARGET);
    }
    assert_eq!(fixture.capability_projection.run_id, RUN);
    assert_eq!(fixture.precondition_validation_projection.run_id, RUN);
    assert_eq!(fixture.precondition_error_projections.len(), 8);
    assert_eq!(
        fixture.risk_projection.verdict,
        AgentRiskVerdictV2::RequiresApproval
    );
}

#[test]
fn shared_fixture_checks_every_freshness_default_at_its_exact_boundary() {
    let fixture = fixture();
    for case in fixture.freshness_cases {
        assert_eq!(
            fixture
                .freshness_policy
                .is_fresh(case.class, NOW - case.age_millis, NOW),
            case.expected_fresh,
            "freshness case {:?} age {}",
            case.class,
            case.age_millis
        );
    }
}

#[test]
fn shared_fixture_resolves_effective_policy_without_weakening() {
    for case in fixture().effective_policy_cases {
        assert_eq!(
            resolve_effective_policy_v2(case.sources),
            case.expected,
            "policy case {}",
            case.name
        );
    }
}

#[test]
fn shared_fixture_executes_every_action_freshness_and_stop_precondition_case() {
    let fixture = fixture();
    for case in fixture.precondition_cases {
        let mut ledger =
            AgentStructuredEvidenceLedgerV2::new(RUN, TARGET, fixture.freshness_policy).unwrap();
        let capability = record_capability(&mut ledger, NOW - case.capability_age_millis);
        let status = record_status(
            &mut ledger,
            resource("nginx.service"),
            NOW - case.status_age_millis,
            &case.load_state,
            &case.active_state,
        );
        let config = record_config(&mut ledger, case.config_valid);
        let evidence_ids = vec![status.evidence_id, config.evidence_id];
        let arguments = control(case.action);
        let result = ledger.validate_service_control_preconditions(
            AgentServiceControlPreconditionRequestV2 {
                run_id: RUN,
                target_digest: TARGET,
                arguments: &arguments,
                capability_evidence_id: &capability.evidence_id,
                evidence_ids: &evidence_ids,
                expected_evidence_set_digest: None,
                user_goal_explicitly_requests_stop: case.explicit_stop_intent,
                now: NOW,
            },
        );
        if case.expected == "valid" {
            assert!(result.is_ok(), "precondition case {}", case.name);
        } else {
            let reason = result
                .expect_err(&format!("precondition case {} must fail", case.name))
                .reason;
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::Value::String(case.expected),
                "precondition case {}",
                case.name
            );
        }
    }
}

#[test]
fn shared_fixture_proves_same_run_target_and_resource_ownership() {
    for case in fixture().ownership_cases {
        let mut ledger = AgentStructuredEvidenceLedgerV2::new(
            RUN,
            TARGET,
            AgentEvidenceFreshnessPolicyV2::default(),
        )
        .unwrap();
        let capability = record_capability(&mut ledger, NOW);
        let evidence_resource = if case.dimension == "resource" {
            resource("sshd.service")
        } else {
            resource("nginx.service")
        };
        let status = record_status(&mut ledger, evidence_resource, NOW, "loaded", "inactive");
        let evidence_ids = vec![status.evidence_id];
        let arguments = control(ServiceControlActionV2::Start);
        let error = ledger
            .validate_service_control_preconditions(AgentServiceControlPreconditionRequestV2 {
                run_id: if case.dimension == "run" {
                    "run-2"
                } else {
                    RUN
                },
                target_digest: if case.dimension == "target" {
                    "sha256-v1:target-2"
                } else {
                    TARGET
                },
                arguments: &arguments,
                capability_evidence_id: &capability.evidence_id,
                evidence_ids: &evidence_ids,
                expected_evidence_set_digest: None,
                user_goal_explicitly_requests_stop: false,
                now: NOW,
            })
            .expect_err(&format!("ownership case {} must fail", case.name));
        assert_eq!(
            serde_json::to_value(error.reason).unwrap(),
            serde_json::Value::String(case.expected),
            "ownership case {}",
            case.name
        );
    }
}

#[test]
fn shared_fixture_executes_service_matrix_and_every_deny_class() {
    let fixture = fixture();
    let effective_policy = resolve_effective_policy_v2(AgentEffectivePolicySourcesV2 {
        application: None,
        profile: None,
        requested: AgentPolicyModeV2::Balanced,
        tool_minimum: AgentPolicyModeV2::Balanced,
    });
    for case in fixture.risk_cases {
        let mut ledger =
            AgentStructuredEvidenceLedgerV2::new(RUN, TARGET, fixture.freshness_policy).unwrap();
        let capability = record_capability(&mut ledger, NOW);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, effective_policy.clone());
        let action = match case.operation.as_str() {
            "start" => Some(ServiceControlActionV2::Start),
            "reload" => Some(ServiceControlActionV2::Reload),
            "restart" => Some(ServiceControlActionV2::Restart),
            "stop" => Some(ServiceControlActionV2::Stop),
            _ => None,
        };
        let arguments = action.map(control);
        let operation = if let Some(arguments) = arguments.as_ref() {
            AgentLocalRiskOperationV2::ServiceControl {
                arguments,
                capability_evidence_id: &capability.evidence_id,
                now: NOW,
            }
        } else {
            AgentLocalRiskOperationV2::Denied {
                class: match case.operation.as_str() {
                    "unknownToolOrAction" => AgentDeniedOperationClassV2::UnknownToolOrAction,
                    "destructive" => AgentDeniedOperationClassV2::Destructive,
                    "privilegeElevation" => AgentDeniedOperationClassV2::PrivilegeElevation,
                    "shellInterpretation" => AgentDeniedOperationClassV2::ShellInterpretation,
                    "multiHost" => AgentDeniedOperationClassV2::MultiHost,
                    "credentialAccess" => AgentDeniedOperationClassV2::CredentialAccess,
                    "externalDownloadExecute" => {
                        AgentDeniedOperationClassV2::ExternalDownloadExecute
                    }
                    "networkChange" => AgentDeniedOperationClassV2::NetworkChange,
                    "ambiguousResource" => AgentDeniedOperationClassV2::AmbiguousResource,
                    other => panic!("unknown shared risk operation {other}"),
                },
            }
        };
        let assessment = engine.assess(
            &ledger,
            AgentRiskAssessmentRequestV2 {
                operation,
                untrusted_model_claim: Some(AgentUntrustedModelRiskClaimV2 {
                    read_only: case.model_claims_read_only,
                    severity: AgentRiskSeverityV2::Low,
                }),
            },
        );
        assert_eq!(assessment.severity, case.expected_severity, "{}", case.name);
        assert_eq!(
            assessment.confidence, case.expected_confidence,
            "{}",
            case.name
        );
        assert_eq!(assessment.verdict, case.expected_verdict, "{}", case.name);
        assert_eq!(
            assessment.dimensions.write, case.expected_write,
            "{}",
            case.name
        );
        assert_eq!(
            assessment.dimensions.service_interruption, case.expected_service_interruption,
            "{}",
            case.name
        );
        assert!(assessment
            .findings
            .iter()
            .any(|finding| finding.code == "modelRiskClaimIgnored"));
    }
}

#[test]
fn precondition_reason_enum_stays_in_sync_with_the_shared_fixture() {
    let reasons = fixture()
        .precondition_error_projections
        .into_iter()
        .map(|error| error.reason)
        .collect::<Vec<_>>();
    for required in [
        AgentPreconditionFailureReasonV2::RunMismatch,
        AgentPreconditionFailureReasonV2::TargetMismatch,
        AgentPreconditionFailureReasonV2::ResourceMismatch,
        AgentPreconditionFailureReasonV2::EvidenceStale,
        AgentPreconditionFailureReasonV2::ConflictingClaims,
        AgentPreconditionFailureReasonV2::ConfigInvalid,
        AgentPreconditionFailureReasonV2::StopIntentMissing,
        AgentPreconditionFailureReasonV2::EvidenceDigestChanged,
    ] {
        assert!(reasons.contains(&required));
    }
}
