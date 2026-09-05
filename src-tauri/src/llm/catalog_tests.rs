use super::{catalog::*, config::*};
use serde_json::{json, Value};

fn provider(model: &str) -> AiProviderConfig {
    serde_json::from_value(json!({"id":"route","kind":"openAiCompatible","profile":"qwen","baseUrl":"https://proxy.example/v1","model":model,"requiresApiKey":false})).unwrap()
}

#[test]
fn ipc_fixtures_are_exact_rust_resolutions_without_credentials() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../protocol/llm/fixtures/resolved-models.json"
    ))
    .unwrap();
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
    d.max_output_tokens = 16384;
    d.tool_calling = Support::Unknown;
    d.image_input = Support::Unknown;
    p.model_definition = Some(d);
    let model = resolve(&p).unwrap();
    assert_eq!(model.model_id, "Qwen/Private-Model:Case");
    assert_eq!(model.source, "userDeclaration");
    assert_eq!(model.max_output_tokens, 16384);
    assert_eq!(model.tool_calling, Support::Unknown);
    p.model = "qwen3-vl-plus".into();
    assert_eq!(resolve(&p).unwrap().image_input, Support::Unknown);
    assert!(resolve(&p).unwrap().vision.is_none());
}

#[test]
fn custom_capacity_is_not_inferred_or_clamped_to_legacy_hint_bounds() {
    let mut p = provider("custom-small");
    p.model_definition = Some(fixture_definition(p.kind, 4096));
    assert_eq!(resolve(&p).unwrap().context_window, 4096);
    p.model_definition.as_mut().unwrap().context_window = 4_000_000;
    assert_eq!(resolve(&p).unwrap().context_window, 4_000_000);
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

#[test]
fn v4_restoration_matches_existing_settings_exactly_and_rejects_missing_declarations() {
    let p = provider("Private/CaseSensitive");
    let declaration = fixture_definition(p.kind, 32768);
    let saved = json!({"id":p.id,"kind":p.kind,"profile":p.profile,"baseUrl":p.base_url,"model":p.model,"modelDefinition":declaration});
    let entries = vec![("ai.providers".into(), json!([saved]).to_string())];
    let mut restored = p.clone();
    restore_model_definition(&mut restored, &entries).unwrap();
    assert_eq!(resolve(&restored).unwrap().source, "userDeclaration");
    for field in ["id", "kind", "baseUrl", "model", "profile"] {
        let mut different = saved.clone();
        different[field] = json!("different");
        let mut restored = p.clone();
        restore_model_definition(
            &mut restored,
            &[("ai.providers".into(), json!([different]).to_string())],
        )
        .unwrap();
        assert!(restored.model_definition.is_none(), "{field}");
        assert!(resolve(&restored).unwrap_err().contains("UNKNOWN_MODEL"));
    }
    let mut explicit = p.clone();
    explicit.model_definition = Some(fixture_definition(p.kind, 65536));
    restore_model_definition(&mut explicit, &entries).unwrap();
    assert_eq!(resolve(&explicit).unwrap().context_window, 65536);
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
