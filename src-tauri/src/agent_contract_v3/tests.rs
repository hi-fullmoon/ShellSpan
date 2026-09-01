use serde::Deserialize;
use serde_json::{json, Value};

use super::*;
use crate::agent_contract::{
    AgentPermissionMode, AgentRequest, AgentTargetKind, AgentTargetSnapshot, AgentTaskKind,
    AgentToolCall, AgentToolName, AgentToolResult, AgentToolResultStatus,
};

const FIXTURES: &str = include_str!("../../../protocol/agent/v3/agent-contract-fixtures.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContractFixtures {
    contract_version: u8,
    examples: ContractExamples,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContractExamples {
    request: AgentRequestV3,
    verified_capability: CapabilityClaimsFixture,
    tool_calls: Vec<AgentToolCallV3>,
    tool_results: Vec<AgentToolResultV3>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityClaimsFixture {
    capability_id: String,
    request_id: String,
    user_session_id: String,
    allowed_tools: Vec<String>,
    allowed_effects: Vec<AgentEffectKindV3>,
    target_ids: Vec<String>,
    not_before_unix_ms: u64,
    expires_at_unix_ms: u64,
    revoked: bool,
}

fn load_fixture() -> ContractFixtures {
    serde_json::from_str(FIXTURES).expect("v3 fixtures must decode with strict Rust types")
}

fn verified_capability(claims: CapabilityClaimsFixture) -> VerifiedAgentCapabilityV3 {
    VerifiedAgentCapabilityV3::from_verified_claims(
        claims.capability_id,
        claims.request_id,
        claims.user_session_id,
        claims.allowed_tools,
        claims.allowed_effects,
        claims.target_ids,
        claims.not_before_unix_ms,
        claims.expires_at_unix_ms,
        claims.revoked,
    )
}

fn assessed_effect(call: &AgentToolCallV3) -> AgentObservedEffectV3 {
    let descriptor = find_builtin_tool_v3(&call.tool_name).expect("fixture tool is registered");
    AgentObservedEffectV3 {
        kind: descriptor.allowed_effects[0],
        target_id: call.target.target_id().to_string(),
        summary: "native test classification".into(),
        paths: Vec::new(),
        network_destinations: Vec::new(),
    }
}

#[test]
fn fixtures_cover_all_twelve_tools_and_correlate_results() {
    let fixture = load_fixture();
    assert_eq!(fixture.contract_version, AGENT_CONTRACT_V3_VERSION);
    assert_eq!(fixture.examples.request.contract_version, 3);
    assert_eq!(fixture.examples.tool_calls.len(), 12);
    assert_eq!(fixture.examples.tool_results.len(), 12);
    let registered = BUILTIN_TOOL_DESCRIPTORS_V3
        .iter()
        .map(|descriptor| descriptor.name)
        .collect::<Vec<_>>();
    let fixture_names = fixture
        .examples
        .tool_calls
        .iter()
        .map(|call| call.tool_name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(fixture_names, registered);
    for (call, result) in fixture
        .examples
        .tool_calls
        .iter()
        .zip(&fixture.examples.tool_results)
    {
        validate_tool_arguments_v3(&call.tool_name, &call.arguments).unwrap();
        validate_result_correlation_v3(&fixture.examples.request, call, result).unwrap();
    }
}

#[test]
fn policy_allows_only_correlated_registered_and_capability_scoped_calls() {
    let fixture = load_fixture();
    let capability = verified_capability(fixture.examples.verified_capability);
    let engine = M0ContractPolicyEngineV3;
    for call in &fixture.examples.tool_calls {
        let effect = assessed_effect(call);
        assert_eq!(
            engine.evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call,
                assessed_effect: Some(&effect),
                capability: Some(&capability),
                now_unix_ms: 1_788_193_000_000,
            }),
            AgentPolicyDecisionV3 {
                outcome: AgentPolicyOutcomeV3::Allow,
                reason: AgentPolicyReasonV3::Authorized,
            },
            "{}",
            call.tool_name
        );
    }
}

#[test]
fn policy_fails_closed_for_unregistered_tool_invalid_target_and_missing_capability() {
    let fixture = load_fixture();
    let capability = verified_capability(fixture.examples.verified_capability);
    let engine = M0ContractPolicyEngineV3;
    let call = fixture.examples.tool_calls[0].clone();
    let effect = assessed_effect(&call);

    let mut unknown = call.clone();
    unknown.tool_name = "future_tool".into();
    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call: &unknown,
                assessed_effect: Some(&effect),
                capability: Some(&capability),
                now_unix_ms: 1_788_193_000_000,
            })
            .reason,
        AgentPolicyReasonV3::UnregisteredTool
    );

    let mut drifted = call.clone();
    if let AgentToolTargetV3::Remote { host, .. } = &mut drifted.target {
        *host = "other.example.com".into();
    }
    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call: &drifted,
                assessed_effect: Some(&effect),
                capability: Some(&capability),
                now_unix_ms: 1_788_193_000_000,
            })
            .reason,
        AgentPolicyReasonV3::InvalidTarget
    );

    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call: &call,
                assessed_effect: Some(&effect),
                capability: None,
                now_unix_ms: 1_788_193_000_000,
            })
            .reason,
        AgentPolicyReasonV3::MissingCapability
    );
}

#[test]
fn policy_rejects_unknown_argument_fields_and_unclassified_effects() {
    let fixture = load_fixture();
    let capability = verified_capability(fixture.examples.verified_capability);
    let engine = M0ContractPolicyEngineV3;
    let mut call = fixture.examples.tool_calls[0].clone();
    call.arguments
        .as_object_mut()
        .unwrap()
        .insert("unexpected".into(), json!(true));
    let effect = assessed_effect(&call);
    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call: &call,
                assessed_effect: Some(&effect),
                capability: Some(&capability),
                now_unix_ms: 1_788_193_000_000,
            })
            .reason,
        AgentPolicyReasonV3::InvalidArguments
    );

    let valid_call = &fixture.examples.tool_calls[0];
    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call: valid_call,
                assessed_effect: None,
                capability: Some(&capability),
                now_unix_ms: 1_788_193_000_000,
            })
            .reason,
        AgentPolicyReasonV3::UnclassifiedEffect
    );
}

#[test]
fn opaque_capability_scope_checks_ttl_request_user_tool_effect_and_target() {
    let fixture = load_fixture();
    let engine = M0ContractPolicyEngineV3;
    let call = &fixture.examples.tool_calls[0];
    let effect = assessed_effect(call);
    let expired = VerifiedAgentCapabilityV3::from_verified_claims(
        "cap-1".into(),
        fixture.examples.request.request_id.clone(),
        fixture.examples.request.user_session_id.clone(),
        vec![call.tool_name.clone()],
        vec![effect.kind],
        vec![call.target.target_id().into()],
        1,
        2,
        false,
    );
    assert_eq!(
        engine
            .evaluate(AgentPolicyEvaluationV3 {
                request: &fixture.examples.request,
                call,
                assessed_effect: Some(&effect),
                capability: Some(&expired),
                now_unix_ms: 2,
            })
            .reason,
        AgentPolicyReasonV3::CapabilityExpired
    );
}

#[test]
fn result_correlation_rejects_cross_call_and_cross_target_results() {
    let fixture = load_fixture();
    let call = &fixture.examples.tool_calls[0];
    let mut result = fixture.examples.tool_results[0].clone();
    result.call_id = "other-call".into();
    assert_eq!(
        validate_result_correlation_v3(&fixture.examples.request, call, &result),
        Err(AgentResultCorrelationErrorV3::CallMismatch)
    );
    result.call_id = call.call_id.clone();
    result.target_id = "local-1".into();
    assert_eq!(
        validate_result_correlation_v3(&fixture.examples.request, call, &result),
        Err(AgentResultCorrelationErrorV3::TargetMismatch)
    );
}

#[test]
fn v2_adapter_preserves_v2_and_never_fabricates_a_capability() {
    let target = AgentTargetSnapshot {
        kind: AgentTargetKind::Remote,
        session_id: "session-v2".into(),
        profile_id: Some("profile-v2".into()),
        host: "v2.example.com".into(),
        port: 22,
        username: "operator".into(),
    };
    let request = AgentRequest {
        request_id: "req-v2".into(),
        task: AgentTaskKind::Agent,
        target: target.clone(),
        permission_mode: AgentPermissionMode::AutoApproveReadOnly,
    };
    let request_v3 = adapt_v2_request_to_v3(
        &request,
        "user-session-v2",
        "Inspect the v2 target",
        vec!["Return a correlated terminal result.".into()],
    )
    .unwrap();
    assert_eq!(
        request_v3.source_contract,
        AgentRequestSourceV3::V2Compatibility
    );
    assert_eq!(
        request_v3.permission_mode,
        AgentPermissionModeV3::ScopedAutopilot
    );

    let call_v2 = AgentToolCall {
        request_id: "req-v2".into(),
        call_id: "call-v2".into(),
        name: AgentToolName::RunTerminalCommand,
        command: "uname -a".into(),
        explanation: "Inspect the kernel.".into(),
        target,
    };
    let call_v3 = adapt_v2_tool_call_to_v3(&call_v2, "cap-issued-by-rust");
    assert_eq!(call_v3.tool_name, "exec_command");
    assert_eq!(call_v3.capability_id, "cap-issued-by-rust");
    assert_eq!(call_v3.arguments["channel"], "pty");

    let result_v2 = AgentToolResult {
        request_id: "req-v2".into(),
        call_id: "call-v2".into(),
        status: AgentToolResultStatus::Completed,
        exit_code: Some(0),
        output: "Linux\n".into(),
    };
    let result_v3 = adapt_v2_tool_result_to_v3(&result_v2, &call_v3).unwrap();
    assert_eq!(
        result_v3.data.as_ref().unwrap()["compatibility"]["sourceContract"],
        "v2"
    );
    validate_result_correlation_v3(&request_v3, &call_v3, &result_v3).unwrap();
}

#[test]
fn serde_rejects_unknown_call_fields() {
    let fixture: Value = serde_json::from_str(FIXTURES).unwrap();
    let mut call = fixture["examples"]["toolCalls"][0].clone();
    call.as_object_mut()
        .unwrap()
        .insert("unexpected".into(), json!(true));
    assert!(serde_json::from_value::<AgentToolCallV3>(call).is_err());
}

#[test]
fn rollout_is_contract_only_and_rolls_back_to_v2() {
    use super::rollout::{parse_agent_v3_rollout_stage, resolve_agent_v3_rollout_policy};

    let disabled = resolve_agent_v3_rollout_policy(parse_agent_v3_rollout_stage(None));
    assert_eq!(disabled.stage, AgentV3RolloutStage::Disabled);
    assert!(!disabled.contract_available);
    assert_eq!(disabled.execution_contract_version, 2);
    assert_eq!(disabled.rollback_contract_version, 2);

    let preview =
        resolve_agent_v3_rollout_policy(parse_agent_v3_rollout_stage(Some("contractOnly")));
    assert!(preview.contract_available);
    assert_eq!(preview.execution_contract_version, 2);

    let runtime = resolve_agent_v3_rollout_policy(parse_agent_v3_rollout_stage(Some("runtime")));
    assert_eq!(runtime.stage, AgentV3RolloutStage::Runtime);
    assert!(runtime.contract_available);
    assert_eq!(runtime.execution_contract_version, 3);

    let unknown = resolve_agent_v3_rollout_policy(parse_agent_v3_rollout_stage(Some("future")));
    assert_eq!(unknown.stage, AgentV3RolloutStage::Disabled);
}

#[test]
fn embedded_schemas_and_manifest_are_valid_json_and_synchronized() {
    let _: Value = serde_json::from_str(AGENT_CONTRACT_V3_SCHEMA).unwrap();
    let _: Value = serde_json::from_str(AGENT_TOOL_CONTRACT_V3_SCHEMA).unwrap();
    let _: Value = serde_json::from_str(AGENT_TOOL_MANIFEST_V3_SCHEMA).unwrap();
    let manifest: Value = serde_json::from_str(AGENT_TOOL_MANIFEST_V3).unwrap();
    let manifest_names = manifest["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    let rust_names = BUILTIN_TOOL_DESCRIPTORS_V3
        .iter()
        .map(|descriptor| descriptor.name)
        .collect::<Vec<_>>();
    assert_eq!(manifest_names, rust_names);
}
