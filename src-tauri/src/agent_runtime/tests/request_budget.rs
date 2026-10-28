use super::*;
use crate::agent_runtime::{AgentRequestBudget, AgentStopReason, AgentTokenUsage};
use serde_json::{json, Value};

fn captures() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!(
        "../../../../src/test/fixtures/input-usage-anchors.json"
    ))
    .unwrap()["samples"]
        .as_array()
        .unwrap()
        .clone()
}

fn event(seq: u64, payload: Payload) -> AgentSessionEvent {
    AgentSessionEvent::new("accounting".into(), seq, seq, None, None, payload)
}

fn budget(context: &Value) -> ModelSurfaceBudget {
    let context_window = context["contextWindow"].as_u64().unwrap();
    let (safety, usable) =
        crate::llm::catalog::model_input_token_budget(context_window, 16_384).unwrap();
    ModelSurfaceBudget {
        reserved_tokens_per_image: 0,
        context_window,
        output_reserve_tokens: 16_384,
        safety_reserve_tokens: safety,
        usable_input_tokens: usable,
        compaction_threshold_tokens: usable * 85 / 100,
        compaction_target_tokens: usable * 60 / 100,
        system_tokens: context["systemTokens"].as_u64().unwrap(),
        tool_schema_tokens: context["toolSchemaTokens"].as_u64().unwrap(),
        message_tokens: context["messageTokens"].as_u64().unwrap(),
        estimated_input_tokens: context["inputTokens"].as_u64().unwrap(),
        estimated_input_bytes: 0,
        maximum_input_bytes: usable * 4,
        input_measurement: None,
        tool_message_sizes: Default::default(),
        assistant_message_sizes: Default::default(),
    }
}

fn record_context(
    seq: u64,
    request_id: &str,
    budget: &ModelSurfaceBudget,
    generation: u64,
) -> AgentSessionEvent {
    event(
        seq,
        Payload::RequestContext {
            request_id: request_id.into(),
            input_tokens: Some(budget.estimated_input_tokens),
            context_window: Some(budget.context_window),
            request_budget: Some(AgentRequestBudget {
                output_tokens: budget.output_reserve_tokens,
                safety_tokens: budget.safety_reserve_tokens,
                usable_input_tokens: budget.usable_input_tokens,
                compaction_threshold_tokens: budget.compaction_threshold_tokens,
                compaction_target_tokens: budget.compaction_target_tokens,
                input_measurement: budget.input_measurement.clone(),
            }),
            system_tokens: Some(budget.system_tokens),
            tool_schema_tokens: Some(budget.tool_schema_tokens),
            message_tokens: Some(budget.message_tokens),
            surface_generation: generation,
            limited: None,
            omitted_messages: None,
        },
    )
}

fn recorded_events(sample: &Value) -> (ModelSurfaceBudget, Vec<AgentSessionEvent>) {
    let mut initial = budget(&sample["context"]);
    apply_usage_anchor(&mut initial, &[], 0, "route".into());
    let events = vec![
        record_context(
            sample["contextSeq"].as_u64().unwrap(),
            "recorded",
            &initial,
            0,
        ),
        event(
            sample["usageSeq"].as_u64().unwrap(),
            Payload::RequestUsage {
                request_id: "recorded".into(),
                usage: serde_json::from_value(sample["usage"].clone()).unwrap(),
                finish_reason: AgentStopReason::ToolCalls,
            },
        ),
    ];
    (initial, events)
}

#[test]
fn recorded_usage_anchors_track_growth_shrink_and_compaction_pressure() {
    let addition = super::super::measure_model_messages(
        &[super::super::ModelMessage::User {
            content: include_str!("../../../../AGENTS.md").into(),
        }],
        0,
    )
    .0;
    for sample in captures() {
        let (initial, events) = recorded_events(&sample);
        let usage: AgentTokenUsage = serde_json::from_value(sample["usage"].clone()).unwrap();
        let input = usage.uncached_input_tokens.unwrap() + usage.cache_read_tokens.unwrap();
        let adjustment = input - initial.estimated_input_tokens;
        for raw in [
            initial.estimated_input_tokens + addition,
            initial.estimated_input_tokens - 256,
        ] {
            let mut current = initial.clone();
            current.estimated_input_tokens = raw;
            current.compaction_threshold_tokens = raw + adjustment;
            assert!(!current.requires_compaction());
            apply_usage_anchor(&mut current, &events, 0, "route".into());
            assert_eq!(current.estimated_input_tokens, raw + adjustment);
            assert!(current.requires_compaction());
            let evidence = current.input_measurement.unwrap();
            assert_eq!(evidence.heuristic_tokens, raw);
            assert_eq!(evidence.anchor_request_id.as_deref(), Some("recorded"));
            assert_eq!(evidence.usage_adjustment_tokens, adjustment);
        }
        // Size-only evidence is sufficient after persistence/reload.
        let replayed =
            serde_json::from_slice::<Vec<AgentSessionEvent>>(&serde_json::to_vec(&events).unwrap())
                .unwrap();
        let mut current = initial.clone();
        apply_usage_anchor(&mut current, &replayed, 0, "route".into());
        assert_eq!(current.estimated_input_tokens, input);
    }
}

#[test]
fn anchors_require_matching_configuration_generation_and_complete_usage() {
    for sample in captures() {
        let (initial, events) = recorded_events(&sample);
        for (identity, generation) in [("changed-route", 0), ("route", 1)] {
            let mut current = initial.clone();
            apply_usage_anchor(&mut current, &events, generation, identity.into());
            assert_eq!(
                current.estimated_input_tokens,
                initial.estimated_input_tokens
            );
            assert!(current
                .input_measurement
                .unwrap()
                .anchor_request_id
                .is_none());
        }
        let mut incomplete = events.clone();
        if let Payload::RequestUsage { usage, .. } = &mut incomplete[1].payload {
            usage.cache_read_tokens = None;
        }
        let mut current = initial.clone();
        apply_usage_anchor(&mut current, &incomplete, 0, "route".into());
        assert_eq!(
            current.estimated_input_tokens,
            initial.estimated_input_tokens
        );
        let mut legacy = events;
        if let Payload::RequestContext { request_budget, .. } = &mut legacy[0].payload {
            *request_budget = None;
        }
        apply_usage_anchor(&mut current, &legacy, 0, "route".into());
        assert_eq!(
            current.estimated_input_tokens,
            initial.estimated_input_tokens
        );
    }
}

#[test]
fn recalibration_uses_raw_estimates_and_never_counts_output_as_input() {
    let samples = captures();
    let (initial, events) = recorded_events(&samples[1]);
    let mut current = initial.clone();
    apply_usage_anchor(&mut current, &events, 0, "route".into());
    let mut next = vec![record_context(100, "next", &current, 0)];
    let usage: AgentTokenUsage = serde_json::from_value(samples[1]["usage"].clone()).unwrap();
    next.push(event(
        101,
        Payload::RequestUsage {
            request_id: "next".into(),
            usage,
            finish_reason: AgentStopReason::ToolCalls,
        },
    ));
    let once = current.estimated_input_tokens;
    current.estimated_input_tokens = initial.estimated_input_tokens;
    apply_usage_anchor(&mut current, &next, 0, "route".into());
    assert_eq!(current.estimated_input_tokens, once);
    let diagnostics = serde_json::to_value(current.input_measurement.unwrap()).unwrap();
    assert_eq!(
        diagnostics["heuristicTokens"],
        samples[1]["context"]["inputTokens"]
    );
    assert!(diagnostics.get("outputTokens").is_none());
    assert!(diagnostics.get("reasoningTokens").is_none());
    assert_ne!(json!(once), samples[1]["usage"]["totalTokens"]);
}

#[test]
fn smaller_reported_input_keeps_the_heuristic_floor() {
    let capture: Value = serde_json::from_str(include_str!(
        "../../../../src/test/fixtures/context-budget-review.json"
    ))
    .unwrap();
    let sample = json!({
        "contextSeq": capture["events"][0]["seq"],
        "usageSeq": capture["events"][1]["seq"],
        "context": capture["events"][0]["data"],
        "usage": capture["events"][1]["data"]["usage"]
    });
    let (initial, mut events) = recorded_events(&sample);
    // These recorded counters belong to generation 5.
    if let Payload::RequestContext {
        surface_generation, ..
    } = &mut events[0].payload
    {
        *surface_generation = 5;
    }
    let mut current = initial.clone();
    apply_usage_anchor(&mut current, &events, 5, "route".into());
    assert_eq!(
        current.estimated_input_tokens,
        initial.estimated_input_tokens
    );
    assert_eq!(
        current.input_measurement.unwrap().usage_adjustment_tokens,
        0
    );
}

#[test]
fn measurement_identity_changes_with_model_route_and_output_settings() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../protocol/llm/fixtures/resolved-models.json"
    ))
    .unwrap();
    let entry = fixtures
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider"]["model"] == "MiniMax-M3")
        .unwrap();
    let provider: crate::ai::AiProviderConfig =
        serde_json::from_value(entry["provider"].clone()).unwrap();
    let route = crate::llm::runtime::fixture_route(&provider);
    let original = measurement_identity(&provider, &route).unwrap();
    let mut changed_route = route.clone();
    changed_route.revision += 1;
    assert_ne!(
        measurement_identity(&provider, &changed_route).unwrap(),
        original
    );
    changed_route = route.clone();
    changed_route.replay_domain_id.push_str("-new");
    assert_ne!(
        measurement_identity(&provider, &changed_route).unwrap(),
        original
    );
    let mut changed = provider.clone();
    let mut definition = crate::llm::catalog::resolve(&provider).unwrap().definition;
    definition.request_output_tokens = Some(32_768);
    changed.model_definition = Some(definition);
    assert_ne!(measurement_identity(&changed, &route).unwrap(), original);
    changed = provider.clone();
    changed.base_url.push_str("/changed");
    assert_ne!(measurement_identity(&changed, &route).unwrap(), original);
}
