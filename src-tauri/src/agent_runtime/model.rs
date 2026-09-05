//! Agent history projection and image-store ownership; protocol APIs are re-exported during migration.
pub(crate) use super::model_tools::default_model_tools;
use super::{
    AgentAssistantContentBlock, AgentRequestToolSchema, AgentSurfaceMessage, AgentSurfaceSnapshot,
    RecordedToolCall,
};
use crate::ai::AiProviderConfig;
use crate::llm::{
    adapter::{ImageResolvingAdapter, RequestImageResolver},
    registry::HttpModelAdapterFactory,
};
pub(crate) use crate::llm::{
    adapter::{ModelAdapter, ModelAdapterFactory, ModelStreamSink},
    errors::*,
    types::*,
};
use std::sync::Arc;
impl ModelRequest {
    pub(crate) fn from_surface(
        request_id: String,
        surface: &AgentSurfaceSnapshot,
        system_prompt: String,
        tools: Vec<AgentRequestToolSchema>,
    ) -> Self {
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
                                        arguments: call.arguments.clone(),
                                    },
                                }
                            }
                        })
                        .collect();
                    messages.push(ModelMessage::Assistant {
                        content,
                        replay: replay.clone(),
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
pub(crate) struct ModelRegistry {
    factory: Arc<dyn ModelAdapterFactory>,
    runtime: Arc<std::sync::Mutex<Option<crate::llm::runtime::LlmRuntime>>>,
    legacy_configs:
        Arc<std::sync::Mutex<std::collections::HashMap<(String, String), AiProviderConfig>>>,
    #[cfg(test)]
    preferences: Arc<std::sync::Mutex<Option<crate::db::Database>>>,
    pub(crate) images: super::images::ImageStore,
}

impl Default for ModelRegistry {
    fn default() -> Self {
        Self {
            factory: Arc::new(HttpModelAdapterFactory),
            images: Default::default(),
            runtime: Default::default(),
            legacy_configs: Default::default(),
            #[cfg(test)]
            preferences: Default::default(),
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
        Ok(crate::llm::runtime::PreparedModel {
            provider: selected.provider.clone(),
            adapter: selected.adapter.clone(),
            route: None,
            images: Some(Arc::new(self.images.clone())),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_factory(factory: Arc<dyn ModelAdapterFactory>) -> Self {
        Self {
            factory,
            images: Default::default(),
            runtime: Default::default(),
            legacy_configs: Default::default(),
            #[cfg(test)]
            preferences: Default::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn configure_preferences(
        &self,
        database: crate::db::Database,
    ) -> Result<(), String> {
        *self
            .preferences
            .lock()
            .map_err(|_| "model preferences unavailable")? = Some(database);
        Ok(())
    }

    pub(crate) fn restore_selection(
        &self,
        selected: &super::AgentSubagentModel,
    ) -> Result<AiProviderConfig, String> {
        let Some(runtime) = self
            .runtime
            .lock()
            .map_err(|_| "LLM_RUNTIME_UNAVAILABLE")?
            .clone()
        else {
            #[cfg(test)]
            if let Some(database) = self
                .preferences
                .lock()
                .map_err(|_| "model preferences unavailable")?
                .as_ref()
            {
                if let Some((_, encoded)) = database
                    .load_preferences()?
                    .into_iter()
                    .find(|(key, _)| key == "ai.providers")
                {
                    let providers: Vec<AiProviderConfig> =
                        serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
                    if let Some(provider) = providers.into_iter().find(|provider| {
                        provider.id == selected.route_id && provider.model == selected.model_id
                    }) {
                        return Ok(AiProviderConfig {
                            reasoning_effort: selected.reasoning_effort.clone(),
                            ..provider
                        });
                    }
                }
            }
            return self
                .legacy_configs
                .lock()
                .map_err(|_| "MODEL_CONFIG_UNAVAILABLE")?
                .get(&(selected.route_id.clone(), selected.model_id.clone()))
                .cloned()
                .ok_or("UNKNOWN_ROUTE".into());
        };
        let snapshot = runtime.routes.snapshot()?;
        snapshot
            .route(&selected.route_id)?
            .provider(&crate::llm::routes::ModelSelection {
                route_id: selected.route_id.clone(),
                model_id: selected.model_id.clone(),
                reasoning_effort: selected.reasoning_effort.clone(),
            })
    }

    pub(crate) fn resolve(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String> {
        self.legacy_configs
            .lock()
            .map_err(|_| "MODEL_CONFIG_UNAVAILABLE")?
            .insert(
                (provider.id.clone(), provider.model.clone()),
                provider.clone(),
            );
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
        if let Some(policy) = provider.retry_policy {
            policy.validate()?;
        }
        Ok(Arc::new(ImageResolvingAdapter {
            inner: self.factory.create(provider.clone(), api_key)?,
            images: Arc::new(self.images.clone()),
            provider,
        }))
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
        name: call.name,
        native_name: None,
        arguments: call.arguments,
        title: None,
        effect: None,
        target: None,
    }
}

#[cfg(test)]
mod stage_c_tests {
    use super::*;
    use crate::llm::routes::{ModelSelection, ProviderRoute, RouteAuth, RouteStore, RouteTimeouts};
    use std::collections::BTreeMap;

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
            preset_id: None,
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
