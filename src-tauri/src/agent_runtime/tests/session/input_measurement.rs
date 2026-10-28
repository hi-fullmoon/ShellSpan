#[test]
fn input_measurement_requires_bounded_identity_and_consistent_totals() {
    let capture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../src/test/fixtures/input-usage-anchors.json"
    ))
    .unwrap();
    let sample = &capture["samples"][0];
    let mut context = sample["context"].clone();
    context["requestId"] = serde_json::json!("recorded");
    context["requestBudget"] = serde_json::json!({
        "outputTokens": 16384, "safetyTokens": 25600, "usableInputTokens": 470016,
        "compactionThresholdTokens": 399513, "compactionTargetTokens": 282009,
        "inputMeasurement": {
            "identity": crate::llm::runtime::digest(b"recorded-route"),
            "heuristicTokens": sample["context"]["inputTokens"],
            "usageAdjustmentTokens": 0
        }
    });
    let validate = |data: serde_json::Value| {
        let payload: AgentSessionEventPayload = serde_json::from_value(serde_json::json!({
            "type": "request/context", "data": data
        }))
        .unwrap();
        validate_event_payload(&AgentSessionEvent::new(
            "session".into(),
            17,
            17,
            Some("turn".into()),
            Some("step".into()),
            payload,
        ))
    };
    assert!(validate(context.clone()).is_ok());
    let mut changed = context.clone();
    changed["requestBudget"]["inputMeasurement"]["identity"] = serde_json::json!("invalid");
    assert!(validate(changed).is_err());
    changed = context.clone();
    changed["inputTokens"] = serde_json::json!(0);
    assert!(validate(changed).is_err());
    changed = context;
    changed["requestBudget"]["inputMeasurement"]["usageAdjustmentTokens"] =
        serde_json::json!(u64::MAX);
    assert!(validate(changed).is_err());
}
