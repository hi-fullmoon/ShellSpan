use super::evidence_v2::AgentStructuredEvidenceLedgerV2;
use super::policy_v2::AgentEffectivePolicyV2;
use super::protocol_v2::{
    AgentResourceRefV2, AgentRiskAssessmentV2, AgentRiskConfidenceV2, AgentRiskDimensionsV2,
    AgentRiskFindingV2, AgentRiskSeverityV2, AgentRiskVerdictV2, AgentToolNameV2,
    ServiceControlActionV2, ServiceControlArgsV2,
};
use super::resource_v2::canonical_systemd_service_resource_v2;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const AGENT_LOCAL_RISK_ENGINE_VERSION_V2: &str = "p2-local-risk-v1";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentDeniedOperationClassV2 {
    UnknownToolOrAction,
    Destructive,
    PrivilegeElevation,
    CredentialAccess,
    ExternalDownloadExecute,
    MultiHost,
    ShellInterpretation,
    NetworkChange,
    AmbiguousResource,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentUntrustedModelRiskClaimV2 {
    pub(crate) read_only: bool,
    pub(crate) severity: AgentRiskSeverityV2,
}

pub(crate) enum AgentLocalRiskOperationV2<'a> {
    ReadOnly {
        tool: AgentToolNameV2,
        resource: Option<AgentResourceRefV2>,
    },
    ServiceControl {
        arguments: &'a ServiceControlArgsV2,
        capability_evidence_id: &'a str,
        now: u64,
    },
    Denied {
        class: AgentDeniedOperationClassV2,
    },
}

pub(crate) struct AgentRiskAssessmentRequestV2<'a> {
    pub(crate) operation: AgentLocalRiskOperationV2<'a>,
    pub(crate) untrusted_model_claim: Option<AgentUntrustedModelRiskClaimV2>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRiskEngineV2 {
    run_id: String,
    target_digest: String,
    effective_policy: AgentEffectivePolicyV2,
    next_assessment_sequence: usize,
}

impl AgentRiskEngineV2 {
    pub(crate) fn new(
        run_id: impl Into<String>,
        target_digest: impl Into<String>,
        effective_policy: AgentEffectivePolicyV2,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            target_digest: target_digest.into(),
            effective_policy,
            next_assessment_sequence: 1,
        }
    }

    pub(crate) fn assess(
        &mut self,
        ledger: &AgentStructuredEvidenceLedgerV2,
        request: AgentRiskAssessmentRequestV2<'_>,
    ) -> AgentRiskAssessmentV2 {
        let (severity, confidence, dimensions, findings, affected_resources, verdict) =
            match request.operation {
                AgentLocalRiskOperationV2::ReadOnly { tool, resource } => {
                    if tool == AgentToolNameV2::ServiceControl {
                        let (severity, confidence, dimensions, mut findings, _, verdict) =
                            denied_assessment_v2(AgentDeniedOperationClassV2::UnknownToolOrAction);
                        findings.push(finding(
                            "mutationMisclassifiedReadOnly",
                            "A mutation tool cannot enter the bounded read-only risk path.",
                        ));
                        return self.finish_assessment(
                            severity,
                            confidence,
                            dimensions,
                            findings,
                            resource.into_iter().collect(),
                            verdict,
                            request.untrusted_model_claim,
                        );
                    }
                    let verdict = if self.effective_policy.read_only_requires_approval {
                        AgentRiskVerdictV2::RequiresApproval
                    } else {
                        AgentRiskVerdictV2::AutoReadOnly
                    };
                    (
                        AgentRiskSeverityV2::Low,
                        AgentRiskConfidenceV2::Known,
                        AgentRiskDimensionsV2 {
                            read: true,
                            write: false,
                            delete: false,
                            privilege_elevation: false,
                            service_interruption: false,
                            network_change: false,
                            credential_access: false,
                            external_network: false,
                            multi_host: false,
                        },
                        vec![finding(
                            "boundedReadOnly",
                            format!("{tool:?} is a locally bounded read-only tool."),
                        )],
                        resource.into_iter().collect(),
                        verdict,
                    )
                }
                AgentLocalRiskOperationV2::ServiceControl {
                    arguments,
                    capability_evidence_id,
                    now,
                } => self.assess_service_control(ledger, arguments, capability_evidence_id, now),
                AgentLocalRiskOperationV2::Denied { class } => denied_assessment_v2(class),
            };

        self.finish_assessment(
            severity,
            confidence,
            dimensions,
            findings,
            affected_resources,
            verdict,
            request.untrusted_model_claim,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_assessment(
        &mut self,
        severity: AgentRiskSeverityV2,
        confidence: AgentRiskConfidenceV2,
        dimensions: AgentRiskDimensionsV2,
        mut findings: Vec<AgentRiskFindingV2>,
        affected_resources: Vec<AgentResourceRefV2>,
        verdict: AgentRiskVerdictV2,
        untrusted_model_claim: Option<AgentUntrustedModelRiskClaimV2>,
    ) -> AgentRiskAssessmentV2 {
        if untrusted_model_claim.is_some_and(|claim| {
            claim.read_only
                || risk_severity_rank_v2(claim.severity) < risk_severity_rank_v2(severity)
        }) {
            findings.push(finding(
                "modelRiskClaimIgnored",
                "The untrusted model risk claim cannot lower the local assessment.",
            ));
        }
        let risk_assessment_id = format!(
            "risk-v2-{}-{}",
            short_hash_v2(&self.run_id),
            self.next_assessment_sequence
        );
        self.next_assessment_sequence += 1;
        let policy_version = self.effective_policy.policy_version.clone();
        let assessment_digest = sha256_v2(&(
            AGENT_LOCAL_RISK_ENGINE_VERSION_V2,
            &self.run_id,
            &self.target_digest,
            severity,
            confidence,
            &dimensions,
            &findings,
            &affected_resources,
            verdict,
            &policy_version,
        ));

        AgentRiskAssessmentV2 {
            risk_assessment_id,
            severity,
            confidence,
            dimensions,
            findings,
            affected_resources,
            verdict,
            policy_version,
            assessment_digest,
        }
    }

    fn assess_service_control(
        &self,
        ledger: &AgentStructuredEvidenceLedgerV2,
        arguments: &ServiceControlArgsV2,
        capability_evidence_id: &str,
        now: u64,
    ) -> (
        AgentRiskSeverityV2,
        AgentRiskConfidenceV2,
        AgentRiskDimensionsV2,
        Vec<AgentRiskFindingV2>,
        Vec<AgentResourceRefV2>,
        AgentRiskVerdictV2,
    ) {
        let resource = match canonical_systemd_service_resource_v2(
            &self.target_digest,
            arguments.manager,
            &arguments.unit,
        ) {
            Ok(resource) => resource,
            Err(_) => return denied_assessment_v2(AgentDeniedOperationClassV2::AmbiguousResource),
        };
        let capability = match ledger.validate_service_capability(
            capability_evidence_id,
            &resource,
            arguments.action,
            now,
        ) {
            Ok(capability) => capability,
            Err(_) => {
                let (severity, confidence, mut dimensions, mut findings, _, verdict) =
                    denied_assessment_v2(AgentDeniedOperationClassV2::UnknownToolOrAction);
                dimensions.write = true;
                findings.push(finding(
                    "targetCapabilityUnknown",
                    "Fresh same-run capability evidence did not prove this canonical systemd unit.",
                ));
                return (
                    severity,
                    confidence,
                    dimensions,
                    findings,
                    vec![resource],
                    verdict,
                );
            }
        };

        let (severity, service_interruption, verdict, code, message) = match arguments.action {
            ServiceControlActionV2::Start => (
                AgentRiskSeverityV2::Medium,
                false,
                AgentRiskVerdictV2::RequiresApproval,
                "serviceStart",
                "Starting a service is a state-changing write.",
            ),
            ServiceControlActionV2::Reload if capability.evidence.reload_may_interrupt => (
                AgentRiskSeverityV2::High,
                true,
                AgentRiskVerdictV2::RequiresDoubleConfirmation,
                "serviceReloadInterrupting",
                "Local capability marks reload as potentially service-interrupting.",
            ),
            ServiceControlActionV2::Reload => (
                AgentRiskSeverityV2::Medium,
                false,
                AgentRiskVerdictV2::RequiresApproval,
                "serviceReload",
                "Reloading a service is a state-changing write.",
            ),
            ServiceControlActionV2::Restart => (
                AgentRiskSeverityV2::High,
                true,
                AgentRiskVerdictV2::RequiresDoubleConfirmation,
                "serviceRestart",
                "Restarting a service intentionally interrupts it.",
            ),
            ServiceControlActionV2::Stop => (
                AgentRiskSeverityV2::High,
                true,
                AgentRiskVerdictV2::RequiresDoubleConfirmation,
                "serviceStop",
                "Stopping a service intentionally interrupts it.",
            ),
        };
        (
            severity,
            AgentRiskConfidenceV2::Known,
            AgentRiskDimensionsV2 {
                read: false,
                write: true,
                delete: false,
                privilege_elevation: false,
                service_interruption,
                network_change: false,
                credential_access: false,
                external_network: false,
                multi_host: false,
            },
            vec![finding(code, message)],
            vec![resource],
            verdict,
        )
    }
}

fn denied_assessment_v2(
    class: AgentDeniedOperationClassV2,
) -> (
    AgentRiskSeverityV2,
    AgentRiskConfidenceV2,
    AgentRiskDimensionsV2,
    Vec<AgentRiskFindingV2>,
    Vec<AgentResourceRefV2>,
    AgentRiskVerdictV2,
) {
    let mut dimensions = AgentRiskDimensionsV2 {
        read: false,
        write: false,
        delete: false,
        privilege_elevation: false,
        service_interruption: false,
        network_change: false,
        credential_access: false,
        external_network: false,
        multi_host: false,
    };
    let (confidence, code, message) = match class {
        AgentDeniedOperationClassV2::UnknownToolOrAction => (
            AgentRiskConfidenceV2::Unknown,
            "unknownOperation",
            "Unknown tools, programs, subcommands, and actions are denied.",
        ),
        AgentDeniedOperationClassV2::Destructive => {
            dimensions.write = true;
            dimensions.delete = true;
            (
                AgentRiskConfidenceV2::Known,
                "destructiveOperation",
                "Destructive operations are outside P2 and are denied.",
            )
        }
        AgentDeniedOperationClassV2::PrivilegeElevation => {
            dimensions.write = true;
            dimensions.privilege_elevation = true;
            (
                AgentRiskConfidenceV2::Known,
                "privilegeElevation",
                "Privilege elevation is outside P2 and is denied.",
            )
        }
        AgentDeniedOperationClassV2::CredentialAccess => {
            dimensions.read = true;
            dimensions.credential_access = true;
            (
                AgentRiskConfidenceV2::Known,
                "credentialAccess",
                "Credential access is outside P2 and is denied.",
            )
        }
        AgentDeniedOperationClassV2::ExternalDownloadExecute => {
            dimensions.write = true;
            dimensions.external_network = true;
            (
                AgentRiskConfidenceV2::Known,
                "externalDownloadExecute",
                "External download-and-execute behavior is denied.",
            )
        }
        AgentDeniedOperationClassV2::MultiHost => {
            dimensions.write = true;
            dimensions.multi_host = true;
            (
                AgentRiskConfidenceV2::Known,
                "multiHost",
                "Multi-host mutation is outside P2 and is denied.",
            )
        }
        AgentDeniedOperationClassV2::ShellInterpretation => {
            dimensions.write = true;
            (
                AgentRiskConfidenceV2::Unknown,
                "shellInterpretation",
                "Shell interpretation cannot be normalized to P2 semantic intent.",
            )
        }
        AgentDeniedOperationClassV2::NetworkChange => {
            dimensions.write = true;
            dimensions.network_change = true;
            (
                AgentRiskConfidenceV2::Known,
                "networkChange",
                "Network configuration changes are outside P2 and are denied.",
            )
        }
        AgentDeniedOperationClassV2::AmbiguousResource => (
            AgentRiskConfidenceV2::Unknown,
            "ambiguousResource",
            "The operation cannot be normalized to exactly one resource.",
        ),
    };
    (
        AgentRiskSeverityV2::Critical,
        confidence,
        dimensions,
        vec![finding(code, message)],
        Vec::new(),
        AgentRiskVerdictV2::Deny,
    )
}

fn finding(code: impl Into<String>, message: impl Into<String>) -> AgentRiskFindingV2 {
    AgentRiskFindingV2 {
        code: code.into(),
        message: message.into(),
    }
}

fn risk_severity_rank_v2(severity: AgentRiskSeverityV2) -> u8 {
    match severity {
        AgentRiskSeverityV2::Low => 0,
        AgentRiskSeverityV2::Medium => 1,
        AgentRiskSeverityV2::High => 2,
        AgentRiskSeverityV2::Critical => 3,
    }
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

fn short_hash_v2(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::admission_v2::AgentTargetCapabilityV2;
    use crate::agent::evidence_v2::{
        AgentEvidenceFreshnessPolicyV2, AgentServiceCapabilityCandidateV2,
    };
    use crate::agent::policy_v2::{resolve_effective_policy_v2, AgentEffectivePolicySourcesV2};
    use crate::agent::protocol_v2::{AgentPolicyModeV2, ServiceManagerV2, ServiceValidatorV2};

    const RUN: &str = "run-1";
    const TARGET: &str = "sha256-v1:target-1";
    const NOW: u64 = 1_000_000;

    fn policy(mode: AgentPolicyModeV2) -> AgentEffectivePolicyV2 {
        resolve_effective_policy_v2(AgentEffectivePolicySourcesV2 {
            application: None,
            profile: None,
            requested: mode,
            tool_minimum: AgentPolicyModeV2::Balanced,
        })
    }

    fn ledger(reload_may_interrupt: bool) -> (AgentStructuredEvidenceLedgerV2, String) {
        let mut ledger = AgentStructuredEvidenceLedgerV2::new(
            RUN,
            TARGET,
            AgentEvidenceFreshnessPolicyV2::default(),
        )
        .unwrap();
        let resource = canonical_systemd_service_resource_v2(
            TARGET,
            ServiceManagerV2::Systemd,
            "nginx.service",
        )
        .unwrap();
        let capability = ledger
            .record_service_capability(AgentServiceCapabilityCandidateV2 {
                run_id: RUN,
                target_digest: TARGET,
                resource,
                tool_call_id: "capability-tool",
                observed_at: NOW,
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
                reload_may_interrupt,
            })
            .unwrap();
        (ledger, capability.evidence_id)
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

    #[test]
    fn service_control_matrix_is_entirely_local_and_model_underreporting_is_ignored() {
        let (ledger, capability_id) = ledger(false);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(AgentPolicyModeV2::Balanced));
        let table = [
            (
                ServiceControlActionV2::Start,
                AgentRiskSeverityV2::Medium,
                AgentRiskVerdictV2::RequiresApproval,
                false,
            ),
            (
                ServiceControlActionV2::Reload,
                AgentRiskSeverityV2::Medium,
                AgentRiskVerdictV2::RequiresApproval,
                false,
            ),
            (
                ServiceControlActionV2::Restart,
                AgentRiskSeverityV2::High,
                AgentRiskVerdictV2::RequiresDoubleConfirmation,
                true,
            ),
            (
                ServiceControlActionV2::Stop,
                AgentRiskSeverityV2::High,
                AgentRiskVerdictV2::RequiresDoubleConfirmation,
                true,
            ),
        ];
        for (action, severity, verdict, interruption) in table {
            let arguments = control(action);
            let assessment = engine.assess(
                &ledger,
                AgentRiskAssessmentRequestV2 {
                    operation: AgentLocalRiskOperationV2::ServiceControl {
                        arguments: &arguments,
                        capability_evidence_id: &capability_id,
                        now: NOW,
                    },
                    untrusted_model_claim: Some(AgentUntrustedModelRiskClaimV2 {
                        read_only: true,
                        severity: AgentRiskSeverityV2::Low,
                    }),
                },
            );
            assert_eq!(assessment.severity, severity);
            assert_eq!(assessment.verdict, verdict);
            assert!(assessment.dimensions.write);
            assert_eq!(assessment.dimensions.service_interruption, interruption);
            assert!(assessment
                .findings
                .iter()
                .any(|finding| finding.code == "modelRiskClaimIgnored"));
        }
    }

    #[test]
    fn reload_capability_can_raise_local_risk_to_high() {
        let (ledger, capability_id) = ledger(true);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(AgentPolicyModeV2::Balanced));
        let arguments = control(ServiceControlActionV2::Reload);
        let assessment = engine.assess(
            &ledger,
            AgentRiskAssessmentRequestV2 {
                operation: AgentLocalRiskOperationV2::ServiceControl {
                    arguments: &arguments,
                    capability_evidence_id: &capability_id,
                    now: NOW,
                },
                untrusted_model_claim: None,
            },
        );
        assert_eq!(assessment.severity, AgentRiskSeverityV2::High);
        assert_eq!(
            assessment.verdict,
            AgentRiskVerdictV2::RequiresDoubleConfirmation
        );
        assert!(assessment.dimensions.service_interruption);
    }

    #[test]
    fn strict_and_balanced_only_change_bounded_read_only_approval() {
        let (ledger, _) = ledger(false);
        for (mode, verdict) in [
            (
                AgentPolicyModeV2::Strict,
                AgentRiskVerdictV2::RequiresApproval,
            ),
            (
                AgentPolicyModeV2::Balanced,
                AgentRiskVerdictV2::AutoReadOnly,
            ),
        ] {
            let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(mode));
            let assessment = engine.assess(
                &ledger,
                AgentRiskAssessmentRequestV2 {
                    operation: AgentLocalRiskOperationV2::ReadOnly {
                        tool: AgentToolNameV2::HostInspect,
                        resource: None,
                    },
                    untrusted_model_claim: None,
                },
            );
            assert_eq!(assessment.severity, AgentRiskSeverityV2::Low);
            assert_eq!(assessment.verdict, verdict);
        }
    }

    #[test]
    fn unknown_destructive_privilege_shell_multi_host_and_related_classes_all_deny() {
        let (ledger, _) = ledger(false);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(AgentPolicyModeV2::Balanced));
        for class in [
            AgentDeniedOperationClassV2::UnknownToolOrAction,
            AgentDeniedOperationClassV2::Destructive,
            AgentDeniedOperationClassV2::PrivilegeElevation,
            AgentDeniedOperationClassV2::CredentialAccess,
            AgentDeniedOperationClassV2::ExternalDownloadExecute,
            AgentDeniedOperationClassV2::MultiHost,
            AgentDeniedOperationClassV2::ShellInterpretation,
            AgentDeniedOperationClassV2::NetworkChange,
            AgentDeniedOperationClassV2::AmbiguousResource,
        ] {
            let assessment = engine.assess(
                &ledger,
                AgentRiskAssessmentRequestV2 {
                    operation: AgentLocalRiskOperationV2::Denied { class },
                    untrusted_model_claim: Some(AgentUntrustedModelRiskClaimV2 {
                        read_only: true,
                        severity: AgentRiskSeverityV2::Low,
                    }),
                },
            );
            assert_eq!(assessment.severity, AgentRiskSeverityV2::Critical);
            assert_eq!(assessment.verdict, AgentRiskVerdictV2::Deny);
        }
    }

    #[test]
    fn missing_or_stale_capability_is_unknown_and_denied() {
        let (ledger, _) = ledger(false);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(AgentPolicyModeV2::Balanced));
        let arguments = control(ServiceControlActionV2::Start);
        let assessment = engine.assess(
            &ledger,
            AgentRiskAssessmentRequestV2 {
                operation: AgentLocalRiskOperationV2::ServiceControl {
                    arguments: &arguments,
                    capability_evidence_id: "missing-capability",
                    now: NOW,
                },
                untrusted_model_claim: None,
            },
        );
        assert_eq!(assessment.confidence, AgentRiskConfidenceV2::Unknown);
        assert_eq!(assessment.verdict, AgentRiskVerdictV2::Deny);
        assert!(assessment
            .findings
            .iter()
            .any(|finding| finding.code == "targetCapabilityUnknown"));
    }

    #[test]
    fn mutation_tool_cannot_be_smuggled_through_the_read_only_variant() {
        let (ledger, _) = ledger(false);
        let mut engine = AgentRiskEngineV2::new(RUN, TARGET, policy(AgentPolicyModeV2::Balanced));
        let assessment = engine.assess(
            &ledger,
            AgentRiskAssessmentRequestV2 {
                operation: AgentLocalRiskOperationV2::ReadOnly {
                    tool: AgentToolNameV2::ServiceControl,
                    resource: None,
                },
                untrusted_model_claim: Some(AgentUntrustedModelRiskClaimV2 {
                    read_only: true,
                    severity: AgentRiskSeverityV2::Low,
                }),
            },
        );
        assert_eq!(assessment.severity, AgentRiskSeverityV2::Critical);
        assert_eq!(assessment.verdict, AgentRiskVerdictV2::Deny);
        assert!(assessment
            .findings
            .iter()
            .any(|finding| finding.code == "mutationMisclassifiedReadOnly"));
    }
}
