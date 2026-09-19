//! Agent history projection and image-store ownership.
pub(crate) use super::model_tools::{default_model_tools, model_tools_with_terminal_interaction};
use super::{
    AgentAssistantContentBlock, AgentRequestToolSchema, AgentSurfaceMessage, AgentSurfaceSnapshot,
    RecordedToolCall,
};
use crate::ai::AiProviderConfig;
#[cfg(test)]
pub(crate) use crate::llm::adapter::ModelAdapterFactory;
use crate::llm::adapter::RequestImageResolver;
#[cfg(test)]
use crate::llm::{adapter::ImageResolvingAdapter, registry::HttpModelAdapterFactory};
pub(crate) use crate::llm::{
    adapter::{ModelAdapter, ModelStreamSink},
    errors::*,
    types::*,
};
use std::sync::Arc;
impl ModelRequest {
    pub(crate) fn from_surface(
        request_id: String,
        surface: &AgentSurfaceSnapshot,
        mut system_prompt: String,
        tools: Vec<AgentRequestToolSchema>,
    ) -> Self {
        system_prompt.push_str("\nHistorical tool arguments containing [ephemeral terminal input omitted], [ephemeral terminal match text omitted], or [ephemeral process input omitted] are privacy receipts, not commands or literal input. Only historical content was omitted; new tool input is passed unchanged. Never copy these markers into tool calls. Read current terminal/process state and reconstruct the intended command from the task; if the original input is required and unavailable, report that limitation instead of guessing.");
        let mut messages = Vec::with_capacity(surface.messages.len());
        for message in &surface.messages {
            match message {
                AgentSurfaceMessage::UserImages {
                    content, images, ..
                } => {
                    messages.push(ModelMessage::UserImages {
                        content: content.clone(),
                        images: images.clone(),
                        data_urls: Vec::new(),
                    });
                }
                AgentSurfaceMessage::User { content, .. } => {
                    messages.push(ModelMessage::User {
                        content: content.clone(),
                    });
                }
                AgentSurfaceMessage::Assistant {
                    content, replay, ..
                } => {
                    let content = content
                        .iter()
                        .map(|block| match block {
                            AgentAssistantContentBlock::Text { text } => {
                                ModelContentBlock::Text { text: text.clone() }
                            }
                            AgentAssistantContentBlock::Reasoning { text, .. } => {
                                ModelContentBlock::Reasoning {
                                    text: text.clone(),
                                    provider_item: None,
                                }
                            }
                            AgentAssistantContentBlock::ToolCall { call } => {
                                ModelContentBlock::ToolCall {
                                    call: ModelToolCall {
                                        call_id: call.call_id.clone(),
                                        provider_call_id: None,
                                        name: call.name.clone(),
                                        arguments: model_history_tool_arguments(call),
                                    },
                                }
                            }
                        })
                        .collect();
                    messages.push(ModelMessage::Assistant {
                        content,
                        replay: replay
                            .as_deref()
                            .and_then(super::AgentStoredReplay::inline_envelope)
                            .cloned()
                            .map(Box::new),
                        native_replay: None,
                    });
                }
                AgentSurfaceMessage::Tool {
                    call_id,
                    name,
                    content,
                    ..
                } => messages.push(ModelMessage::Tool {
                    call_id: call_id.clone(),
                    provider_call_id: None,
                    name: name.clone(),
                    content: content.clone(),
                }),
            }
        }
        Self {
            request_id,
            surface_generation: surface.generation,
            system_prompt,
            messages,
            tools,
        }
    }
}

#[derive(Clone)]
#[cfg_attr(not(test), derive(Default))]
pub(crate) struct ModelRegistry {
    #[cfg(test)]
    factory: Arc<dyn ModelAdapterFactory>,
    runtime: Arc<std::sync::Mutex<Option<crate::llm::runtime::LlmRuntime>>>,
    #[cfg(test)]
    test_configs:
        Arc<std::sync::Mutex<std::collections::HashMap<(String, String), AiProviderConfig>>>,
    pub(crate) images: super::images::ImageStore,
}

#[cfg(test)]
impl Default for ModelRegistry {
    fn default() -> Self {
        Self {
            #[cfg(test)]
            factory: Arc::new(HttpModelAdapterFactory),
            images: Default::default(),
            runtime: Default::default(),
            #[cfg(test)]
            test_configs: Default::default(),
        }
    }
}

impl ModelRegistry {
    #[cfg(test)]
    pub(crate) fn uses_route_store(&self) -> bool {
        self.runtime.lock().is_ok_and(|runtime| runtime.is_some())
    }
    pub(crate) fn configure_llm(
        &self,
        runtime: crate::llm::runtime::LlmRuntime,
    ) -> Result<(), String> {
        *self.runtime.lock().map_err(|_| "LLM_RUNTIME_UNAVAILABLE")? = Some(runtime);
        Ok(())
    }
    pub(crate) fn prepare(
        &self,
        selected: &super::registry::AgentModelSelection,
    ) -> Result<crate::llm::runtime::PreparedModel, String> {
        if let Some(runtime) = self
            .runtime
            .lock()
            .map_err(|_| "LLM_RUNTIME_UNAVAILABLE")?
            .clone()
        {
            return runtime.prepare_model(
                &crate::llm::routes::ModelSelection {
                    route_id: selected.provider.id.clone(),
                    model_id: selected.provider.model.clone(),
                    reasoning_effort: selected.provider.reasoning_effort.clone(),
                },
                Arc::new(self.images.clone()),
            );
        }
        #[cfg(test)]
        return Ok(crate::llm::runtime::PreparedModel {
            provider: selected.provider.clone(),
            adapter: selected.adapter.clone(),
            route: crate::llm::runtime::fixture_route(&selected.provider),
            images: Some(Arc::new(self.images.clone())),
        });
        #[cfg(not(test))]
        Err("LLM_RUNTIME_UNAVAILABLE".into())
    }

    #[cfg(test)]
    pub(crate) fn with_factory(factory: Arc<dyn ModelAdapterFactory>) -> Self {
        Self {
            factory,
            images: Default::default(),
            runtime: Default::default(),
            test_configs: Default::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn register_test_config(&self, provider: AiProviderConfig) -> Result<(), String> {
        self.test_configs
            .lock()
            .map_err(|_| "MODEL_CONFIG_UNAVAILABLE".to_string())?
            .insert((provider.id.clone(), provider.model.clone()), provider);
        Ok(())
    }

    pub(crate) fn restore_selection(
        &self,
        selected: &super::AgentSubagentModel,
    ) -> Result<AiProviderConfig, String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "LLM_RUNTIME_UNAVAILABLE")?
            .clone();
        if let Some(runtime) = runtime {
            let snapshot = runtime.routes.snapshot()?;
            return snapshot.route(&selected.route_id)?.provider(
                &crate::llm::routes::ModelSelection {
                    route_id: selected.route_id.clone(),
                    model_id: selected.model_id.clone(),
                    reasoning_effort: selected.reasoning_effort.clone(),
                },
            );
        }
        #[cfg(test)]
        {
            return self
                .test_configs
                .lock()
                .map_err(|_| "MODEL_CONFIG_UNAVAILABLE")?
                .get(&(selected.route_id.clone(), selected.model_id.clone()))
                .cloned()
                .ok_or("UNKNOWN_ROUTE".into());
        }
        #[cfg(not(test))]
        Err("LLM_RUNTIME_UNAVAILABLE".into())
    }

    pub(crate) fn resolve(
        &self,
        provider: AiProviderConfig,
        _api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        if let Some(runtime) = self
            .runtime
            .lock()
            .map_err(|_| "LLM_RUNTIME_UNAVAILABLE")?
            .clone()
        {
            return Ok(runtime
                .prepare_model(
                    &crate::llm::routes::ModelSelection {
                        route_id: provider.id.clone(),
                        model_id: provider.model.clone(),
                        reasoning_effort: provider.reasoning_effort.clone(),
                    },
                    Arc::new(self.images.clone()),
                )?
                .adapter);
        }
        #[cfg(test)]
        self.test_configs
            .lock()
            .map_err(|_| "MODEL_CONFIG_UNAVAILABLE")?
            .insert(
                (provider.id.clone(), provider.model.clone()),
                provider.clone(),
            );
        #[cfg(not(test))]
        return Err("LLM_RUNTIME_UNAVAILABLE".into());
        #[cfg(test)]
        {
            if let Some(policy) = provider.retry_policy {
                policy.validate()?;
            }
            Ok(Arc::new(ImageResolvingAdapter {
                inner: self.factory.create(provider.clone(), _api_key)?,
                images: Arc::new(self.images.clone()),
                provider,
            }))
        }
    }
}

impl RequestImageResolver for super::images::ImageStore {
    fn resolve_request(
        &self,
        provider: &AiProviderConfig,
        request: &mut ModelRequest,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        super::images::ImageStore::resolve_request(self, provider, request, cancellation)
    }
}
pub(crate) fn recorded_tool_call(call: ModelToolCall) -> RecordedToolCall {
    RecordedToolCall {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        arguments: recorded_tool_arguments(&call.name, &call.arguments),
        name: call.name,
        native_name: None,
        title: None,
        effect: None,
        target: None,
    }
}

pub(crate) fn recorded_tool_arguments(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> serde_json::Value {
    if tool_name == "write_terminal_input" {
        let input_kind = arguments
            .get("inputKind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let byte_length = arguments
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::len);
        return serde_json::json!({
            "inputKind": input_kind,
            "key": arguments.get("key").and_then(serde_json::Value::as_str),
            "byteLength": byte_length,
            "contentPersisted": false,
        });
    }
    if tool_name == "write_process_input" {
        return serde_json::json!({
            "processHandle": arguments.get("processHandle").and_then(serde_json::Value::as_str),
            "close": arguments.get("close").and_then(serde_json::Value::as_bool),
            "byteLength": arguments.get("input").and_then(serde_json::Value::as_str).map(str::len),
            "contentPersisted": false,
        });
    }
    if tool_name == "wait_terminal" {
        if let Some(text) = arguments.get("text").and_then(serde_json::Value::as_str) {
            let mut recorded = arguments.as_object().cloned().unwrap_or_default();
            recorded.remove("text");
            recorded.insert("textProvided".into(), true.into());
            recorded.insert("textByteLength".into(), text.len().into());
            recorded.insert("contentPersisted".into(), false.into());
            return serde_json::Value::Object(recorded);
        }
    }
    arguments.clone()
}

pub(crate) fn tool_call_arguments_are_ephemeral(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> bool {
    tool_name == "write_terminal_input"
        || tool_name == "write_process_input"
        || (tool_name == "wait_terminal" && arguments.get("text").is_some())
}

pub(crate) fn recorded_tool_call_omits_replay(call: &RecordedToolCall) -> bool {
    let Some(arguments) = call.arguments.as_object() else {
        return false;
    };
    if arguments.contains_key("text")
        || arguments.contains_key("input")
        || arguments
            .get("contentPersisted")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
    {
        return false;
    }
    match call.name.as_str() {
        "write_terminal_input" => {
            arguments.len() == 4
                && arguments
                    .get("inputKind")
                    .is_some_and(serde_json::Value::is_string)
                && arguments
                    .get("key")
                    .is_some_and(|value| value.is_null() || value.is_string())
                && arguments
                    .get("byteLength")
                    .is_some_and(|value| value.is_null() || value.as_u64().is_some())
        }
        "wait_terminal" => {
            arguments
                .get("textProvided")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
                && arguments
                    .get("textByteLength")
                    .and_then(serde_json::Value::as_u64)
                    .is_some()
        }
        "write_process_input" => {
            arguments.len() == 4
                && arguments
                    .get("processHandle")
                    .is_some_and(serde_json::Value::is_string)
                && arguments
                    .get("close")
                    .is_some_and(|value| value.is_null() || value.is_boolean())
                && arguments
                    .get("byteLength")
                    .is_some_and(|value| value.is_null() || value.as_u64().is_some())
        }
        _ => false,
    }
}

const OMITTED_TERMINAL_INPUT: &str = "[ephemeral terminal input omitted]";
const OMITTED_TERMINAL_MATCH: &str = "[ephemeral terminal match text omitted]";
const OMITTED_PROCESS_INPUT: &str = "[ephemeral process input omitted]";

pub(crate) fn reject_omitted_input_replay(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), String> {
    let field = match tool_name {
        "write_terminal_input" | "wait_terminal" => "text",
        "write_process_input" => "input",
        "run_terminal_command" | "exec_command" => "command",
        _ => return Ok(()),
    };
    if arguments
        .get(field)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|text| {
            [
                OMITTED_TERMINAL_INPUT,
                OMITTED_TERMINAL_MATCH,
                OMITTED_PROCESS_INPUT,
            ]
            .iter()
            .any(|placeholder| text.contains(placeholder))
        })
    {
        return Err("ephemeralInputUnavailable: omitted history text is not executable input; do not replay it. Read the current terminal state and supply the actual intended input, or report that the input is unavailable.".into());
    }
    Ok(())
}

fn model_history_tool_arguments(call: &RecordedToolCall) -> serde_json::Value {
    if !recorded_tool_call_omits_replay(call) {
        return call.arguments.clone();
    }
    match call.name.as_str() {
        "write_terminal_input" => {
            let fallback = serde_json::json!({
                "inputKind": "text",
                "text": OMITTED_TERMINAL_INPUT,
            });
            let projected = match call
                .arguments
                .get("inputKind")
                .and_then(serde_json::Value::as_str)
            {
                Some("key") => call
                    .arguments
                    .get("key")
                    .and_then(serde_json::Value::as_str)
                    .map(|key| serde_json::json!({ "inputKind": "key", "key": key }))
                    .unwrap_or_else(|| fallback.clone()),
                Some("interrupt") => serde_json::json!({ "inputKind": "interrupt" }),
                Some("paste") => serde_json::json!({
                    "inputKind": "paste",
                    "text": OMITTED_TERMINAL_INPUT,
                }),
                Some("text") | Some(_) | None => fallback.clone(),
            };
            validated_terminal_history_arguments("write_terminal_input", projected, fallback)
        }
        "wait_terminal" => {
            let mut projected = serde_json::Map::new();
            if let Some(arguments) = call.arguments.as_object() {
                for key in [
                    "afterScreenVersion",
                    "afterOutputSequence",
                    "afterLifecycleSequence",
                    "caseSensitive",
                    "idleMs",
                    "timeoutMs",
                ] {
                    if let Some(value) = arguments.get(key) {
                        projected.insert(key.into(), value.clone());
                    }
                }
            }
            projected.insert("text".into(), OMITTED_TERMINAL_MATCH.into());
            let fallback = serde_json::json!({ "text": OMITTED_TERMINAL_MATCH });
            validated_terminal_history_arguments(
                "wait_terminal",
                serde_json::Value::Object(projected),
                fallback,
            )
        }
        "write_process_input" => {
            let mut projected = serde_json::Map::new();
            if let Some(handle) = call.arguments.get("processHandle") {
                projected.insert("processHandle".into(), handle.clone());
            }
            projected.insert("input".into(), OMITTED_PROCESS_INPUT.into());
            if let Some(close) = call
                .arguments
                .get("close")
                .and_then(serde_json::Value::as_bool)
            {
                projected.insert("close".into(), close.into());
            }
            serde_json::Value::Object(projected)
        }
        _ => call.arguments.clone(),
    }
}

fn validated_terminal_history_arguments(
    tool_name: &str,
    arguments: serde_json::Value,
    fallback: serde_json::Value,
) -> serde_json::Value {
    if super::validate_tool_arguments_native(tool_name, &arguments).is_ok() {
        arguments
    } else {
        fallback
    }
}

#[cfg(test)]
mod stage_c_tests {
    use super::*;
    use crate::llm::routes::{ModelSelection, ProviderRoute, RouteAuth, RouteStore, RouteTimeouts};
    use std::collections::BTreeMap;

    #[test]
    fn terminal_input_and_wait_text_are_not_retained_in_recorded_tool_calls() {
        let write = recorded_tool_call(ModelToolCall {
            call_id: "write".into(),
            provider_call_id: None,
            name: "write_terminal_input".into(),
            arguments: serde_json::json!({
                "inputKind": "paste",
                "text": "ephemeral-terminal-value",
            }),
        });
        let wait = recorded_tool_call(ModelToolCall {
            call_id: "wait".into(),
            provider_call_id: None,
            name: "wait_terminal".into(),
            arguments: serde_json::json!({
                "text": "ephemeral-terminal-value",
                "timeoutMs": 1000,
            }),
        });
        let recorded = serde_json::to_string(&(&write, &wait)).unwrap();
        assert!(!recorded.contains("ephemeral-terminal-value"));
        assert!(recorded.contains("contentPersisted"));
        assert!(recorded.contains("textByteLength"));
        assert!(recorded_tool_call_omits_replay(&write));
        assert!(recorded_tool_call_omits_replay(&wait));

        let ordinary_wait = recorded_tool_call(ModelToolCall {
            call_id: "wait-without-text".into(),
            provider_call_id: None,
            name: "wait_terminal".into(),
            arguments: serde_json::json!({
                "afterScreenVersion": 1,
                "timeoutMs": 1000,
            }),
        });
        assert!(!recorded_tool_call_omits_replay(&ordinary_wait));

        let mut unredacted_write = write;
        unredacted_write.arguments["text"] = "must-not-be-durable".into();
        assert!(!recorded_tool_call_omits_replay(&unredacted_write));
    }

    #[test]
    fn process_input_is_ephemeral_but_keeps_its_handle_in_model_history() {
        let call = recorded_tool_call(ModelToolCall {
            call_id: "process-input".into(),
            provider_call_id: None,
            name: "write_process_input".into(),
            arguments: serde_json::json!({
                "processHandle": "proc-0123456789abcdef0123456789abcdef",
                "input": "private-process-input",
                "close": true,
            }),
        });
        let encoded = serde_json::to_string(&call).unwrap();
        assert!(!encoded.contains("private-process-input"));
        assert!(recorded_tool_call_omits_replay(&call));
        assert!(tool_call_arguments_are_ephemeral(
            "write_process_input",
            &serde_json::json!({ "input": "private-process-input" }),
        ));
        assert_eq!(
            model_history_tool_arguments(&call),
            serde_json::json!({
                "processHandle": "proc-0123456789abcdef0123456789abcdef",
                "input": OMITTED_PROCESS_INPUT,
                "close": true,
            })
        );
    }

    #[test]
    fn ephemeral_terminal_receipts_project_as_schema_safe_model_history() {
        let write = recorded_tool_call(ModelToolCall {
            call_id: "write".into(),
            provider_call_id: None,
            name: "write_terminal_input".into(),
            arguments: serde_json::json!({
                "inputKind": "paste",
                "text": "private-terminal-input",
            }),
        });
        let wait = recorded_tool_call(ModelToolCall {
            call_id: "wait".into(),
            provider_call_id: None,
            name: "wait_terminal".into(),
            arguments: serde_json::json!({
                "text": "private-terminal-match",
                "caseSensitive": true,
                "timeoutMs": 1000,
            }),
        });
        let invalid_key = recorded_tool_call(ModelToolCall {
            call_id: "invalid-key".into(),
            provider_call_id: None,
            name: "write_terminal_input".into(),
            arguments: serde_json::json!({
                "inputKind": "key",
                "key": "return",
            }),
        });
        let polluted_wait = recorded_tool_call(ModelToolCall {
            call_id: "polluted-wait".into(),
            provider_call_id: None,
            name: "wait_terminal".into(),
            arguments: serde_json::json!({
                "text": "private-polluted-match",
                "byteLength": 24,
                "timeoutMs": 70000,
            }),
        });
        let surface = AgentSurfaceSnapshot {
            generation: 1,
            replaced_through_seq: None,
            messages: vec![
                AgentSurfaceMessage::Assistant {
                    message_id: "assistant".into(),
                    content: vec![
                        AgentAssistantContentBlock::ToolCall {
                            call: Box::new(write),
                        },
                        AgentAssistantContentBlock::ToolCall {
                            call: Box::new(wait),
                        },
                        AgentAssistantContentBlock::ToolCall {
                            call: Box::new(invalid_key),
                        },
                        AgentAssistantContentBlock::ToolCall {
                            call: Box::new(polluted_wait),
                        },
                    ],
                    interrupted: false,
                    replay: None,
                },
                AgentSurfaceMessage::Tool {
                    call_id: "write".into(),
                    name: "write_terminal_input".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Completed,
                    content: "accepted".into(),
                },
                AgentSurfaceMessage::Tool {
                    call_id: "wait".into(),
                    name: "wait_terminal".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Completed,
                    content: "observed".into(),
                },
                AgentSurfaceMessage::Tool {
                    call_id: "invalid-key".into(),
                    name: "write_terminal_input".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Rejected,
                    content: "rejected".into(),
                },
                AgentSurfaceMessage::Tool {
                    call_id: "polluted-wait".into(),
                    name: "wait_terminal".into(),
                    status: crate::agent_runtime::AgentToolResultStatus::Rejected,
                    content: "rejected".into(),
                },
            ],
        };

        let request =
            ModelRequest::from_surface("request".into(), &surface, "system".into(), Vec::new());
        assert!(request
            .system_prompt
            .contains("Only historical content was omitted"));
        assert!(request.system_prompt.contains("Never copy these markers"));
        let ModelMessage::Assistant { content, .. } = &request.messages[0] else {
            panic!("expected assistant history")
        };
        assert!(matches!(
            &content[0],
            ModelContentBlock::ToolCall { call }
                if call.arguments == serde_json::json!({
                    "inputKind": "paste",
                    "text": OMITTED_TERMINAL_INPUT,
                })
        ));
        assert!(matches!(
            &content[1],
            ModelContentBlock::ToolCall { call }
                if call.arguments == serde_json::json!({
                    "text": OMITTED_TERMINAL_MATCH,
                    "caseSensitive": true,
                    "timeoutMs": 1000,
                })
        ));
        assert!(matches!(
            &content[2],
            ModelContentBlock::ToolCall { call }
                if call.arguments == serde_json::json!({
                    "inputKind": "text",
                    "text": OMITTED_TERMINAL_INPUT,
                })
        ));
        assert!(matches!(
            &content[3],
            ModelContentBlock::ToolCall { call }
                if call.arguments == serde_json::json!({
                    "text": OMITTED_TERMINAL_MATCH,
                })
        ));
        let encoded = serde_json::to_string(&request.messages).unwrap();
        assert!(!encoded.contains("private-terminal-input"));
        assert!(!encoded.contains("private-terminal-match"));
        assert!(!encoded.contains("private-polluted-match"));
        assert!(!encoded.contains("\"return\""));
        assert!(!encoded.contains("byteLength"));
        assert!(!encoded.contains("contentPersisted"));
        assert!(!encoded.contains("textProvided"));
        assert!(!encoded.contains("textByteLength"));
    }

    #[test]
    fn cold_subagent_resolves_only_its_versioned_route_credential() {
        let dir = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open(&dir.path().join("routes.db")).unwrap();
        let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
        let routes = RouteStore::open(database, credentials.clone()).unwrap();
        let definition = crate::llm::catalog::fixture_definition(
            crate::ai::AiProviderKind::OpenAiCompatible,
            8192,
        );
        let selection = ModelSelection {
            route_id: "child-route".into(),
            model_id: "child-model".into(),
            reasoning_effort: None,
        };
        let route = ProviderRoute {
            id: "child-route".into(),
            revision: 1,
            display_name: "Child".into(),
            adapter_id: "chat-completions".into(),
            base_url: "https://example.com".into(),
            auth: RouteAuth::Keychain {
                reference: "pending".into(),
            },
            replay_domain_id: "pending".into(),
            preset_id: "generic".into(),
            models: Some(BTreeMap::from([("child-model".into(), definition)])),
            model_overrides: None,
            defaults: Some(selection.clone()),
            retry_policy: Default::default(),
            timeouts: RouteTimeouts::default(),
        };
        let published = routes
            .save(
                vec![route],
                Some(selection.clone()),
                1,
                BTreeMap::from([("child-route".into(), "child-secret".into())]),
            )
            .unwrap();
        let reference = match &published.route("child-route").unwrap().auth {
            RouteAuth::Keychain { reference } => reference.clone(),
            _ => panic!(),
        };
        let registry = ModelRegistry::default();
        registry
            .configure_llm(crate::llm::runtime::LlmRuntime { routes })
            .unwrap();
        let descriptor = super::super::AgentSubagentModel {
            route_id: selection.route_id,
            model_id: selection.model_id,
            reasoning_effort: None,
            route_revision: Some(published.revision),
        };
        let restored = registry.restore_selection(&descriptor).unwrap();
        assert!(registry.resolve(restored.clone(), None).is_ok());
        credentials
            .delete_credential(crate::keychain::AI_KEY_SERVICE, &reference)
            .unwrap();
        assert!(
            matches!(registry.resolve(restored,None),Err(error) if error=="MISSING_CREDENTIAL")
        );
    }
}
