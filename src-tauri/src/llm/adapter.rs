use super::{config::AiProviderConfig, errors::*, types::*};
use async_trait::async_trait;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) trait ReplayCodec: Send + Sync {
    fn adapter_id(&self) -> &'static str;
    fn replay_format_version(&self) -> u32;
    fn validate_response_metadata(
        &self,
        value: &serde_json::Value,
    ) -> Result<(), NormalizedModelError>;
    fn validate_block_metadata(
        &self,
        kind: super::replay::ReplayBlockKind,
        value: &serde_json::Value,
    ) -> Result<(), NormalizedModelError>;
    fn restore_private_metadata(
        &self,
        content: &mut [ModelContentBlock],
        envelope: &super::replay::ReplayEnvelopeV5,
    ) -> Result<serde_json::Value, NormalizedModelError>;
}

pub(crate) trait ModelStreamSink: Send + Sync {
    fn emit(&self, delta: StreamDelta) -> Result<(), NormalizedModelError>;
}

#[async_trait]
pub(crate) trait ModelAdapter: Send + Sync {
    fn replay_codec(&self) -> &'static dyn ReplayCodec;

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError>;
}

pub(crate) trait ModelAdapterFactory: Send + Sync {
    fn create(
        &self,
        provider: AiProviderConfig,
        api_key: Option<String>,
    ) -> Result<Arc<dyn ModelAdapter>, String>;
}

/// The Agent owns image storage and policy. Protocols only consume resolved data URLs.
pub(crate) trait RequestImageResolver: Send + Sync {
    fn resolve_request(
        &self,
        provider: &AiProviderConfig,
        request: &mut ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<(), String>;
}
pub(crate) struct ImageResolvingAdapter {
    pub(crate) inner: Arc<dyn ModelAdapter>,
    pub(crate) images: Arc<dyn RequestImageResolver>,
    pub(crate) provider: AiProviderConfig,
}
#[async_trait]
impl ModelAdapter for ImageResolvingAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        self.inner.replay_codec()
    }

    async fn stream(
        &self,
        mut request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        if !request
            .messages
            .iter()
            .any(|m| matches!(m, ModelMessage::UserImages { .. }))
        {
            return self.inner.stream(request, cancellation, sink).await;
        }
        let images = self.images.clone();
        let provider = self.provider.clone();
        let token = cancellation.clone();
        request = tokio::task::spawn_blocking(move || {
            images.resolve_request(&provider, &mut request, &token)?;
            Ok::<_, String>(request)
        })
        .await
        .map_err(|e| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, e.to_string()))?
        .map_err(|e| NormalizedModelError::new(NormalizedModelErrorKind::Terminal, e))?;
        self.inner.stream(request, cancellation, sink).await
    }
}
