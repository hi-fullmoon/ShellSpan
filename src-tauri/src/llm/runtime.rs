use super::{adapter::*, catalog, config::AiProviderConfig, routes::*, types::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum RequestSnapshot {
    LegacyUnknown,
    Prepared {
        route_id: String,
        route_revision: u64,
        adapter_id: String,
        model_id: String,
        catalog_version: u32,
        capabilities: catalog::ModelDefinition,
        endpoint_identity: String,
        replay_domain_id: String,
        reasoning_effort: Option<String>,
        output_tokens: u64,
        retry_policy: crate::agent_runtime::RetryPolicy,
        timeouts: RouteTimeouts,
        purpose: String,
        preparation_version: u32,
        projection_policy: String,
        content_hash: String,
        images: Vec<crate::agent_runtime::images::ImageRef>,
    },
}
impl RequestSnapshot {
    pub fn digest(&self) -> String {
        digest(&serde_json::to_vec(self).expect("snapshot serialization"))
    }
}
pub(crate) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn try_digest(bytes: &[u8]) -> Result<String, super::errors::NormalizedModelError> {
    Ok(digest(bytes))
}

/// The only step preparation object. Never Debug/Serialize: the adapter retains credentials.
#[derive(Clone)]
pub(crate) struct PreparedModel {
    pub provider: AiProviderConfig,
    pub adapter: Arc<dyn ModelAdapter>,
    pub route: Option<ProviderRoute>,
    pub images: Option<Arc<dyn RequestImageResolver>>,
}
impl PreparedModel {
    pub fn prepare_request(
        &self,
        mut request: ModelRequest,
        purpose: &str,
        cancellation: &CancellationToken,
    ) -> Result<PreparedCall, String> {
        let replay_domain_id = self
            .route
            .as_ref()
            .map_or("unversioned", |route| route.replay_domain_id.as_str());
        super::replay::project_history(
            self.adapter.replay_codec(),
            &mut request.messages,
            super::replay::ReplayTarget {
                route_id: &self.provider.id,
                model_id: &self.provider.model,
                replay_domain_id,
            },
        )
        .map_err(super::replay::replay_error_string)?;
        if let Some(images) = &self.images {
            images.resolve_request(&self.provider, &mut request, cancellation)?;
        }
        let model = catalog::resolve(&self.provider)?;
        if !request.tools.is_empty() && model.tool_calling != catalog::Support::Supported {
            return Err("UNSUPPORTED_OPTION: tool calling".into());
        }
        let mut content = request.clone();
        content.request_id.clear();
        let images = content
            .messages
            .iter()
            .flat_map(|m| match m {
                ModelMessage::UserImages { images, .. } => images.clone(),
                _ => vec![],
            })
            .collect();
        let snapshot = RequestSnapshot::Prepared {
            route_id: self.provider.id.clone(),
            route_revision: self.route.as_ref().map_or(0, |r| r.revision),
            adapter_id: adapter_id(self.provider.kind).into(),
            model_id: self.provider.model.clone(),
            catalog_version: model.catalog_version,
            capabilities: model.definition.clone(),
            endpoint_identity: model.endpoint.to_string(),
            replay_domain_id: self
                .route
                .as_ref()
                .map_or_else(|| "unversioned".into(), |r| r.replay_domain_id.clone()),
            reasoning_effort: self.provider.reasoning_effort.clone(),
            output_tokens: model.max_output_tokens,
            retry_policy: self.provider.retry_policy.unwrap_or_default(),
            timeouts: self
                .route
                .as_ref()
                .map(|r| r.timeouts.clone())
                .unwrap_or_default(),
            purpose: purpose.into(),
            preparation_version: 1,
            projection_policy: "immutable-png-v1-strict".into(),
            content_hash: digest(&serde_json::to_vec(&content).map_err(|e| e.to_string())?),
            images,
        };
        Ok(PreparedCall {
            model: self.clone(),
            request,
            snapshot,
        })
    }
}
#[derive(Clone)]
pub(crate) struct PreparedCall {
    model: PreparedModel,
    request: ModelRequest,
    pub snapshot: RequestSnapshot,
}
impl PreparedCall {
    pub fn request(&self, request_id: String) -> ModelRequest {
        ModelRequest {
            request_id,
            ..self.request.clone()
        }
    }
    pub async fn stream(
        &self,
        request_id: String,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, super::errors::NormalizedModelError> {
        let mut response = self
            .model
            .adapter
            .stream(self.request(request_id.clone()), cancellation, sink)
            .await?;
        let mut capture = response.replay.take().ok_or_else(|| {
            super::replay::replay_error(
                "REPLAY_CAPTURE_MISSING",
                "adapter did not return replay metadata for a successful response",
            )
        })?;
        if capture.blocks.len() != response.content.len() {
            return Err(super::replay::replay_error(
                "REPLAY_BLOCK_MISMATCH",
                "adapter replay block count does not match response content",
            ));
        }
        let mut normalized_content = Vec::with_capacity(response.content.len());
        let mut normalized_metadata = Vec::with_capacity(capture.blocks.len());
        for (block, metadata) in response.content.into_iter().zip(capture.blocks) {
            if super::replay::model_block_has_output(&block) {
                normalized_content.push(block);
                normalized_metadata.push(metadata);
            }
        }
        response.content = normalized_content;
        capture.blocks = normalized_metadata;
        canonicalize_tool_call_ids(&mut response.content, &self.request.messages, &request_id);
        for block in &mut response.content {
            if let ModelContentBlock::Reasoning { provider_item, .. } = block {
                *provider_item = None;
            }
        }
        // Bind the envelope to the exact redacted value the event store will
        // commit, while retaining raw tool arguments for policy validation.
        let committed_content = super::replay::committed_model_content(&response.content)?;
        response.replay_envelope = Some(super::replay::prepare_envelope(
            self.model.adapter.replay_codec(),
            &request_id,
            &self.snapshot,
            &committed_content,
            capture,
        )?);
        Ok(response)
    }
}

fn canonicalize_tool_call_ids(
    content: &mut [ModelContentBlock],
    history: &[ModelMessage],
    request_id: &str,
) {
    let mut assigned = history
        .iter()
        .filter_map(|message| match message {
            ModelMessage::Assistant { content, .. } => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|block| match block {
            ModelContentBlock::ToolCall { call } => Some(call.call_id.clone()),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    let request_digest = digest(request_id.as_bytes());
    let mut ordinal = 0_usize;
    for block in content {
        if let ModelContentBlock::ToolCall { call } = block {
            ordinal += 1;
            if assigned.insert(call.call_id.clone()) {
                continue;
            }
            // Some adapters use response-local ordinals. Preserve an adapter ID when
            // it is already unique, and bind only collisions to this request.
            loop {
                let candidate = format!("call-{request_digest}-{ordinal}");
                if assigned.insert(candidate.clone()) {
                    call.call_id = candidate;
                    break;
                }
                ordinal += 1;
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct LlmRuntime {
    pub routes: RouteStore,
}
impl LlmRuntime {
    pub fn prepare_model(
        &self,
        selection: &ModelSelection,
        images: Arc<dyn RequestImageResolver>,
    ) -> Result<PreparedModel, String> {
        loop {
            let snapshot = self.routes.snapshot()?;
            let route = snapshot.route(&selection.route_id)?.clone();
            let provider = route.provider(selection)?;
            let secret = self.routes.credential(&route)?;
            let latest = self.routes.snapshot()?;
            if latest.revision != snapshot.revision {
                continue;
            }
            let adapter = super::registry::create_adapter(super::transport::HttpConfig {
                client: super::transport::build_streaming_client()?,
                provider: provider.clone(),
                api_key: secret,
                timeouts: super::transport::ModelTimeoutPolicy {
                    request_headers: std::time::Duration::from_millis(
                        route.timeouts.request_headers_ms,
                    ),
                    first_byte: std::time::Duration::from_millis(route.timeouts.first_byte_ms),
                    stream_idle: std::time::Duration::from_millis(route.timeouts.stream_idle_ms),
                },
            });
            return Ok(PreparedModel {
                provider,
                adapter,
                route: Some(route),
                images: Some(images),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct NoopAdapter;
    #[async_trait::async_trait]
    impl ModelAdapter for NoopAdapter {
        fn replay_codec(&self) -> &'static dyn ReplayCodec {
            super::super::registry::replay_codec("chat-completions").unwrap()
        }

        async fn stream(
            &self,
            _: ModelRequest,
            _: CancellationToken,
            _: Arc<dyn ModelStreamSink>,
        ) -> Result<ModelResponse, super::super::errors::NormalizedModelError> {
            Err(super::super::errors::NormalizedModelError::new(
                super::super::errors::NormalizedModelErrorKind::Terminal,
                "unused",
            ))
        }
    }
    struct CountingResolver(AtomicUsize);
    impl RequestImageResolver for CountingResolver {
        fn resolve_request(
            &self,
            _: &AiProviderConfig,
            request: &mut ModelRequest,
            _: &CancellationToken,
        ) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            request.system_prompt.push_str("|projected");
            Ok(())
        }
    }
    #[test]
    fn prepared_call_projects_once_and_retries_only_change_request_id() {
        let provider = AiProviderConfig {
            id: "route".into(),
            kind: super::super::config::AiProviderKind::OpenAiCompatible,
            base_url: "https://example.com".into(),
            model: "fixture".into(),
            requires_api_key: true,
            api_key: None,
            reasoning_effort: None,
            profile: Some("generic".into()),
            model_definition: Some(catalog::fixture_definition(
                super::super::config::AiProviderKind::OpenAiCompatible,
                8192,
            )),
            retry_policy: None,
        };
        let resolver = Arc::new(CountingResolver(AtomicUsize::new(0)));
        let model = PreparedModel {
            provider,
            adapter: Arc::new(NoopAdapter),
            route: None,
            images: Some(resolver.clone()),
        };
        let request = ModelRequest {
            request_id: "one".into(),
            surface_generation: 4,
            system_prompt: "system".into(),
            messages: vec![ModelMessage::User {
                content: "hello".into(),
            }],
            tools: vec![],
        };
        let call = model
            .prepare_request(request, "step", &CancellationToken::new())
            .unwrap();
        let digest = call.snapshot.digest();
        let first = call.request("attempt-1".into());
        let second = call.request("attempt-2".into());
        assert_eq!(resolver.0.load(Ordering::SeqCst), 1);
        assert_eq!(first.system_prompt, "system|projected");
        assert_eq!(first.messages, second.messages);
        assert_ne!(first.request_id, second.request_id);
        assert_eq!(digest, call.snapshot.digest());
        let serialized = serde_json::to_string(&call.snapshot).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("data:image"));
    }

    #[test]
    fn durable_tool_call_ids_are_unique_across_requests() {
        let content = || {
            vec![
                ModelContentBlock::ToolCall {
                    call: ModelToolCall {
                        call_id: "call-1".into(),
                        provider_call_id: Some("provider-1".into()),
                        name: "read_file".into(),
                        arguments: serde_json::json!({}),
                    },
                },
                ModelContentBlock::ToolCall {
                    call: ModelToolCall {
                        call_id: "call-2".into(),
                        provider_call_id: Some("provider-2".into()),
                        name: "read_file".into(),
                        arguments: serde_json::json!({}),
                    },
                },
            ]
        };
        let mut first = content();
        let mut second = content();
        canonicalize_tool_call_ids(&mut first, &[], "request-a");
        let history = vec![ModelMessage::Assistant {
            content: first.clone(),
            replay: None,
            native_replay: None,
        }];
        canonicalize_tool_call_ids(&mut second, &history, "request-b");

        let ids = |blocks: &[ModelContentBlock]| {
            blocks
                .iter()
                .filter_map(|block| match block {
                    ModelContentBlock::ToolCall { call } => Some(call.call_id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&first), vec!["call-1", "call-2"]);
        assert_ne!(ids(&first), ids(&second));
        assert_ne!(ids(&first)[0], ids(&first)[1]);
        assert!(ids(&second).iter().all(|id| id.len() <= 128));
    }
}
