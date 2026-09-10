use super::{catalog::*, config::*};
use serde_json::{json, Value};

fn provider(model: &str) -> AiProviderConfig {
    serde_json::from_value(json!({"id":"route","kind":"openAiCompatible","profile":"qwen","baseUrl":"https://proxy.example/v1","model":model,"requiresApiKey":false})).unwrap()
}

#[test]
fn ipc_fixtures_are_exact_rust_resolutions_without_credentials() {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../protocol/llm/catalog.json")).unwrap();
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../protocol/llm/fixtures/resolved-models.json"
    ))
    .unwrap();
    let catalog_models = catalog["presets"]
        .as_object()
        .unwrap()
        .iter()
        .flat_map(|(profile, preset)| {
            preset["models"]
                .as_object()
                .unwrap()
                .keys()
                .map(move |model| (profile.clone(), model.clone()))
        })
        .collect::<std::collections::BTreeSet<_>>();
    let fixture_models = fixtures
        .iter()
        .map(|fixture| {
            (
                fixture["provider"]["profile"].as_str().unwrap().to_owned(),
                fixture["provider"]["model"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(fixture_models, catalog_models);

    for fixture in fixtures {
        let mut config: AiProviderConfig =
            serde_json::from_value(fixture["provider"].clone()).unwrap();
        config.api_key = Some("never-in-the-dto".into());
        let actual = serde_json::to_value(resolve(&config).unwrap()).unwrap();
        assert_eq!(actual, fixture["resolved"]);
        assert!(!actual.to_string().contains("never-in-the-dto"));
        assert!(actual.get("apiKey").is_none());
        assert!(actual.get("baseUrl").is_none());
    }
}

#[test]
fn reasoning_wire_value_distinguishes_missing_null_and_provider_spelling() {
    let missing: ReasoningOption =
        serde_json::from_value(json!({"id":"low","displayName":"Low"})).unwrap();
    let omitted: ReasoningOption =
        serde_json::from_value(json!({"id":"off","displayName":"Off","wireValue":null})).unwrap();
    let mapped: ReasoningOption =
        serde_json::from_value(json!({"id":"max","displayName":"Max","wireValue":"high"})).unwrap();
    assert_eq!(missing.wire_value, None);
    assert_eq!(omitted.wire_value, Some(None));
    assert_eq!(mapped.wire_value, Some(Some(Value::String("high".into()))));
    assert_eq!(
        serde_json::to_value(&omitted).unwrap()["wireValue"],
        Value::Null
    );

    let mut p = provider("private-reasoning");
    let mut definition = fixture_definition(p.kind, 32768);
    definition.compat.reasoning_encoding = ReasoningEncoding::Effort;
    definition.reasoning = vec![missing, omitted, mapped];
    p.model_definition = Some(definition);
    let model = resolve(&p).unwrap();

    let mut body = json!({});
    apply_reasoning(&mut body, &model, Some("off".into()));
    assert!(body.get("reasoning_effort").is_none());
    apply_reasoning(&mut body, &model, Some("max".into()));
    assert_eq!(body["reasoning_effort"], "high");
    apply_reasoning(&mut body, &model, Some("low".into()));
    assert_eq!(body["reasoning_effort"], "low");
}

#[test]
fn exact_ids_unknown_models_and_user_overrides() {
    assert!(resolve(&provider("qwen3-vl-plus"))
        .unwrap()
        .vision
        .is_some());
    for id in [
        "QWEN3-VL-PLUS",
        "qwen3-vl-plus-new",
        " qwen3-vl-plus",
        "qwen3-ctx-8192",
        "unlisted",
    ] {
        assert!(resolve(&provider(id))
            .unwrap_err()
            .contains("UNKNOWN_MODEL"));
    }
    let mut p = provider("Qwen/Private-Model:Case");
    let mut d = fixture_definition(p.kind, 32768);
    d.display_name = Some("Private model".into());
    d.max_output_tokens = 16384;
    d.tool_calling = Support::Unknown;
    d.image_input = Support::Unknown;
    p.model_definition = Some(d);
    let model = resolve(&p).unwrap();
    assert_eq!(model.model_id, "Qwen/Private-Model:Case");
    assert_eq!(model.display_name.as_deref(), Some("Private model"));
    assert_eq!(model.source, "userDeclaration");
    assert_eq!(model.max_output_tokens, 16384);
    assert_eq!(model.tool_calling, Support::Unknown);
    p.model = "qwen3-vl-plus".into();
    assert_eq!(resolve(&p).unwrap().image_input, Support::Unknown);
    assert!(resolve(&p).unwrap().vision.is_none());
    p.model_definition.as_mut().unwrap().display_name = Some("   ".into());
    assert!(resolve(&p).unwrap_err().contains("display name"));
}

#[test]
fn built_in_models_inherit_preset_compat_and_apply_local_differences() {
    let inherited = resolve(&provider("qwen3-thinking-2507")).unwrap();
    assert_eq!(inherited.compat.protocol, AiProviderKind::OpenAiCompatible);
    assert_eq!(inherited.compat.reasoning_encoding, ReasoningEncoding::None);
    assert!(inherited.compat.replay_reasoning_content);

    let overridden = resolve(&provider("qwen3")).unwrap();
    assert_eq!(overridden.compat.protocol, inherited.compat.protocol);
    assert_eq!(
        overridden.compat.reasoning_encoding,
        ReasoningEncoding::EnableThinking
    );
    assert_eq!(
        overridden.compat.replay_reasoning_content,
        inherited.compat.replay_reasoning_content
    );
}

#[test]
fn custom_capacity_is_not_inferred_or_clamped_to_obsolete_hint_bounds() {
    let mut p = provider("custom-small");
    p.model_definition = Some(fixture_definition(p.kind, 4096));
    assert_eq!(resolve(&p).unwrap().context_window, 4096);
    p.model_definition.as_mut().unwrap().context_window = 4_000_000;
    assert_eq!(resolve(&p).unwrap().context_window, 4_000_000);
}

#[test]
fn unknown_model_template_is_conservative_and_immediately_resolvable() {
    let mut p = provider("deepseek-preview");
    let definition = declaration_template(&p).unwrap();
    assert_eq!(definition.context_window, DEFAULT_CONTEXT_WINDOW);
    assert_eq!(definition.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
    assert_eq!(definition.tool_calling, Support::Unknown);
    assert_eq!(definition.text_input, Support::Supported);
    assert_eq!(definition.image_input, Support::Unsupported);
    assert!(definition.reasoning.is_empty());

    p.model_definition = Some(definition);
    assert_eq!(resolve(&p).unwrap().source, "userDeclaration");
}

#[test]
fn deepseek_retired_names_remain_routable_but_are_not_discoverable() {
    let mut p = provider("deepseek-v4-flash");
    p.profile = "deepseek".into();
    let resolved = resolve(&p).unwrap();
    assert_eq!(resolved.model_id, "deepseek-v4-flash");
    assert_eq!(
        resolved.compat.reasoning_encoding,
        ReasoningEncoding::ThinkingEffort
    );

    p.model = "deepseek-v4-flash-vision-exp".into();
    assert_eq!(resolve(&p).unwrap().image_input, Support::Unsupported);
    assert!(!preset_models("deepseek", p.kind)
        .unwrap()
        .contains_key("deepseek-v4-flash"));
    assert_eq!(
        alias_target("deepseek", "deepseek-v4-flash"),
        Some("deepseek-flash")
    );
}

#[test]
fn invalid_capacity_and_protocol_fail_while_string_reasoning_is_allowed() {
    let mut p = provider("custom");
    p.model_definition = Some(fixture_definition(p.kind, 32768));
    p.model_definition.as_mut().unwrap().max_output_tokens = 32769;
    assert!(resolve(&p).is_err());
    p.model_definition.as_mut().unwrap().max_output_tokens = 16384;
    p.model_definition.as_mut().unwrap().compat.protocol = AiProviderKind::Ollama;
    assert!(resolve(&p).unwrap_err().contains("protocol"));
    p.model_definition.as_mut().unwrap().compat.protocol = p.kind;
    p.model_definition.as_mut().unwrap().reasoning[0].id = "ultra".into();
    assert_eq!(resolve(&p).unwrap().reasoning[0].id, "ultra");
    let mut raw = serde_json::to_value(fixture_definition(p.kind, 32768)).unwrap();
    raw["compat"]["arbitraryPatch"] = json!({"temperature": 42});
    assert!(serde_json::from_value::<ModelDefinition>(raw).is_err());
    assert!(serde_json::from_value::<AiProviderConfig>(json!({"id":"x","kind":"ollama","model":"qwen3","baseUrl":"http://localhost","requiresApiKey":false,"temperature":0})).is_err());
}

#[test]
fn budgets_use_exact_same_output_context_and_per_model_image_estimate() {
    let mut p = provider("qwen3-vl-plus");
    let mut definition = resolve(&p).unwrap().definition;
    definition.max_output_tokens = 64000;
    definition
        .vision
        .as_mut()
        .unwrap()
        .reserved_tokens_per_image = 1234;
    p.model_definition = Some(definition);
    let request = super::types::ModelRequest {
        request_id: "budget".into(),
        surface_generation: 0,
        system_prompt: String::new(),
        tools: vec![],
        messages: vec![super::types::ModelMessage::UserImages {
            content: String::new(),
            images: vec![crate::agent_runtime::images::ImageRef {
                version: 1,
                sha256: "a".repeat(64),
                media_type: "image/png".into(),
                bytes: 1,
                width: 1,
                height: 1,
                name: "x.png".into(),
            }],
            data_urls: vec![],
        }],
    };
    let budget = crate::agent_runtime::estimate_model_surface_budget(&p, &request).unwrap();
    assert_eq!(budget.context_window, 128000);
    assert_eq!(budget.output_reserve_tokens, 64000);
    assert!(budget.message_tokens >= 1234 && budget.message_tokens < 1500);
}

#[tokio::test]
async fn unknown_tool_capability_is_rejected_before_connecting() {
    use super::adapter::ModelAdapterFactory;
    let mut p = provider("private");
    p.base_url = "http://127.0.0.1:1".into(); // No server; a transport error would prove late rejection.
    p.model_definition = Some(fixture_definition(p.kind, 32768));
    p.model_definition.as_mut().unwrap().tool_calling = Support::Unknown;
    let adapter = super::registry::HttpModelAdapterFactory
        .create(p, None)
        .unwrap();
    struct Sink;
    impl super::adapter::ModelStreamSink for Sink {
        fn emit(
            &self,
            _: super::types::StreamDelta,
        ) -> Result<(), super::errors::NormalizedModelError> {
            panic!("no stream before validation");
        }
    }
    let request = super::types::ModelRequest {
        request_id: "unsupported".into(),
        surface_generation: 0,
        system_prompt: String::new(),
        messages: vec![],
        tools: crate::agent_runtime::default_model_tools(),
    };
    let error = adapter
        .stream(
            request,
            tokio_util::sync::CancellationToken::new(),
            std::sync::Arc::new(Sink),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.kind,
        super::errors::NormalizedModelErrorKind::Terminal
    );
    assert!(error.message.contains("tool calling"));
    assert_eq!(error.code.as_deref(), Some("UNSUPPORTED_OPTION"));
}
