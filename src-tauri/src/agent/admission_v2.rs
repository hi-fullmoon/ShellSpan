use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentFoundationStatusV2 {
    Verified,
    Implemented,
    Blocked,
    Planned,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentTargetCapabilityV2 {
    PosixSystemd,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentControlledMutationPolicyV2 {
    Allowed,
    Denied,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentOperationHistoryCapabilityV2 {
    Writable,
    ReadOnly,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentP2AdmissionInputV2 {
    pub(crate) p0_status: AgentFoundationStatusV2,
    pub(crate) p1_status: AgentFoundationStatusV2,
    pub(crate) feature_enabled: bool,
    pub(crate) provider_strict_schema_compatible: bool,
    pub(crate) target_capability: AgentTargetCapabilityV2,
    pub(crate) controlled_mutation_policy: AgentControlledMutationPolicyV2,
    pub(crate) operation_history: AgentOperationHistoryCapabilityV2,
}

/// The repository's checked-in gate state at P2-0.
///
/// This is intentionally denied before any provider, target, or executor work:
/// P0 still lacks the external Windows verification evidence and P1 remains
/// blocked without its real read-only adapter/fixtures.
pub(crate) const CURRENT_P2_ADMISSION_BASELINE: AgentP2AdmissionInputV2 = AgentP2AdmissionInputV2 {
    p0_status: AgentFoundationStatusV2::Implemented,
    p1_status: AgentFoundationStatusV2::Blocked,
    feature_enabled: false,
    provider_strict_schema_compatible: false,
    target_capability: AgentTargetCapabilityV2::Unknown,
    controlled_mutation_policy: AgentControlledMutationPolicyV2::Unavailable,
    operation_history: AgentOperationHistoryCapabilityV2::Unavailable,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentP2AdmissionErrorCategoryV2 {
    P2Blocked,
    PolicyUnavailable,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentP2AdmissionReasonV2 {
    P0NotVerified,
    P1NotVerified,
    FeatureDisabled,
    ProviderIncompatible,
    TargetUnsupported,
    TargetCapabilityUnknown,
    ControlledMutationDenied,
    ControlledMutationPolicyUnavailable,
    OperationHistoryNotWritable,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentP2AdmissionErrorV2 {
    pub(crate) category: AgentP2AdmissionErrorCategoryV2,
    pub(crate) reason: AgentP2AdmissionReasonV2,
}

fn blocked(reason: AgentP2AdmissionReasonV2) -> AgentP2AdmissionErrorV2 {
    AgentP2AdmissionErrorV2 {
        category: AgentP2AdmissionErrorCategoryV2::P2Blocked,
        reason,
    }
}

fn policy_unavailable(reason: AgentP2AdmissionReasonV2) -> AgentP2AdmissionErrorV2 {
    AgentP2AdmissionErrorV2 {
        category: AgentP2AdmissionErrorCategoryV2::PolicyUnavailable,
        reason,
    }
}

/// Evaluates every P2 start prerequisite before a v2 run can be created.
///
/// This function only decides admission. It cannot construct a run, tool,
/// approval, command, operation, or executor request.
pub(crate) fn evaluate_agent_p2_admission(
    input: AgentP2AdmissionInputV2,
) -> Result<(), AgentP2AdmissionErrorV2> {
    if input.p0_status != AgentFoundationStatusV2::Verified {
        return Err(blocked(AgentP2AdmissionReasonV2::P0NotVerified));
    }
    if input.p1_status != AgentFoundationStatusV2::Verified {
        return Err(blocked(AgentP2AdmissionReasonV2::P1NotVerified));
    }
    if !input.feature_enabled {
        return Err(blocked(AgentP2AdmissionReasonV2::FeatureDisabled));
    }
    if !input.provider_strict_schema_compatible {
        return Err(blocked(AgentP2AdmissionReasonV2::ProviderIncompatible));
    }
    match input.target_capability {
        AgentTargetCapabilityV2::PosixSystemd => {}
        AgentTargetCapabilityV2::Unsupported => {
            return Err(blocked(AgentP2AdmissionReasonV2::TargetUnsupported));
        }
        AgentTargetCapabilityV2::Unknown => {
            return Err(blocked(AgentP2AdmissionReasonV2::TargetCapabilityUnknown));
        }
    }
    match input.controlled_mutation_policy {
        AgentControlledMutationPolicyV2::Allowed => {}
        AgentControlledMutationPolicyV2::Denied => {
            return Err(policy_unavailable(
                AgentP2AdmissionReasonV2::ControlledMutationDenied,
            ));
        }
        AgentControlledMutationPolicyV2::Unavailable => {
            return Err(policy_unavailable(
                AgentP2AdmissionReasonV2::ControlledMutationPolicyUnavailable,
            ));
        }
    }
    if input.operation_history != AgentOperationHistoryCapabilityV2::Writable {
        return Err(policy_unavailable(
            AgentP2AdmissionReasonV2::OperationHistoryNotWritable,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AdmissionFixtureV2 {
        schema_version: u8,
        cases: Vec<AdmissionFixtureCaseV2>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AdmissionFixtureCaseV2 {
        name: String,
        input: AgentP2AdmissionInputV2,
        admitted: bool,
        #[serde(default)]
        category: Option<AgentP2AdmissionErrorCategoryV2>,
        #[serde(default)]
        reason: Option<AgentP2AdmissionReasonV2>,
    }

    #[test]
    fn shared_admission_fixture_fails_closed_at_each_gate() {
        let fixture: AdmissionFixtureV2 = serde_json::from_str(include_str!(
            "../../../tests/fixtures/agent-protocol/v2/admission.json"
        ))
        .expect("shared v2 admission fixture must decode");
        assert_eq!(fixture.schema_version, 2);

        for case in fixture.cases {
            let result = evaluate_agent_p2_admission(case.input);
            assert_eq!(
                result.is_ok(),
                case.admitted,
                "admission case {}",
                case.name
            );
            if let Err(error) = result {
                assert_eq!(Some(error.category), case.category, "case {}", case.name);
                assert_eq!(Some(error.reason), case.reason, "case {}", case.name);
            }
        }
    }

    #[test]
    fn current_repository_baseline_blocks_before_any_executor_can_exist() {
        assert_eq!(
            evaluate_agent_p2_admission(CURRENT_P2_ADMISSION_BASELINE),
            Err(AgentP2AdmissionErrorV2 {
                category: AgentP2AdmissionErrorCategoryV2::P2Blocked,
                reason: AgentP2AdmissionReasonV2::P0NotVerified,
            })
        );
    }

    #[test]
    fn unknown_admission_fields_and_enums_fail_closed() {
        let valid = serde_json::json!({
            "p0Status": "verified",
            "p1Status": "verified",
            "featureEnabled": true,
            "providerStrictSchemaCompatible": true,
            "targetCapability": "posixSystemd",
            "controlledMutationPolicy": "allowed",
            "operationHistory": "writable"
        });
        assert!(serde_json::from_value::<AgentP2AdmissionInputV2>(valid.clone()).is_ok());

        let mut unknown_field = valid.clone();
        unknown_field["executor"] = serde_json::json!("ssh");
        assert!(serde_json::from_value::<AgentP2AdmissionInputV2>(unknown_field).is_err());

        let mut unknown_status = valid;
        unknown_status["p0Status"] = serde_json::json!("almostVerified");
        assert!(serde_json::from_value::<AgentP2AdmissionInputV2>(unknown_status).is_err());
    }
}
