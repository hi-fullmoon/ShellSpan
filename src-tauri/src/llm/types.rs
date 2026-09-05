use super::usage::ProviderUsage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdapterReplayCapture {
    pub(crate) response: Value,
    pub(crate) blocks: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelToolDefinition {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ModelContentBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_item: Option<Value>,
    },
    ToolCall {
        call: ModelToolCall,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "role",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ModelMessage {
    UserImages {
        content: String,
        images: Vec<crate::agent_runtime::images::ImageRef>,
        #[serde(skip)]
        data_urls: Vec<String>,
    },
    User {
        content: String,
    },
    Assistant {
        content: Vec<ModelContentBlock>,
        #[serde(skip)]
        replay: Option<super::replay::ReplayEnvelopeV5>,
        #[serde(skip)]
        native_replay: Option<Value>,
    },
    Tool {
        call_id: String,
        provider_call_id: Option<String>,
        name: String,
        content: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelRequest {
    pub(crate) request_id: String,
    pub(crate) surface_generation: u64,
    pub(crate) system_prompt: String,
    pub(crate) messages: Vec<ModelMessage>,
    pub(crate) tools: Vec<ModelToolDefinition>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelToolCall {
    pub(crate) call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider_call_id: Option<String>,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ModelFinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uncached_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cache_write_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) total_tokens: Option<u64>,
}

impl From<ProviderUsage> for ModelUsage {
    fn from(value: ProviderUsage) -> Self {
        Self {
            uncached_input_tokens: value.uncached_input_tokens,
            cache_read_tokens: value.cache_read_tokens,
            cache_write_tokens: value.cache_write_tokens,
            output_tokens: value.output_tokens,
            reasoning_tokens: value.reasoning_tokens,
            total_tokens: value.total_tokens,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelResponse {
    pub(crate) content: Vec<ModelContentBlock>,
    pub(crate) finish_reason: ModelFinishReason,
    pub(crate) usage: ModelUsage,
    pub(crate) replay: Option<AdapterReplayCapture>,
    pub(crate) replay_envelope: Option<super::replay::ReplayEnvelopeV5>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum StreamDelta {
    Text {
        index: u32,
        text: String,
    },
    Reasoning {
        index: u32,
        text: String,
    },
    ToolCall {
        index: u32,
        call_id: Option<String>,
        name_delta: Option<String>,
        arguments_delta: Option<String>,
    },
    Usage {
        usage: ModelUsage,
    },
}
