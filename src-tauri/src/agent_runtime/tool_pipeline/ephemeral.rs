use std::collections::VecDeque;

use serde_json::Value;

use crate::agent_runtime::{
    AgentSessionEvent, AgentSessionEventPayload, AgentToolResultStatus, ModelContentBlock,
    ModelMessage, ModelRequest, ModelToolCall,
};

const MAX_EPHEMERAL_TERMINAL_RESULTS: usize = 16;
const MAX_EPHEMERAL_TERMINAL_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn has_ephemeral_input_rejection(events: &[AgentSessionEvent], turn_id: &str) -> bool {
    events.iter().any(|event| {
        event.turn_id.as_deref() == Some(turn_id)
            && matches!(
                &event.payload,
                AgentSessionEventPayload::ToolResult {
                    status: AgentToolResultStatus::Rejected,
                    summary,
                    ..
                } if summary.starts_with("ephemeralInputUnavailable:")
            )
    })
}

#[derive(Debug, Clone)]
pub(super) struct EphemeralTerminalResult {
    pub(super) session_id: String,
    pub(super) turn_id: String,
    pub(super) call_id: String,
    pub(super) content: Option<String>,
    pub(super) input: Option<ModelToolCall>,
}

impl EphemeralTerminalResult {
    fn byte_length(&self) -> usize {
        self.content.as_ref().map_or(0, String::len)
            + self
                .input
                .as_ref()
                .map_or(0, |call| call.arguments.to_string().len())
    }
}

#[derive(Debug, Default)]
pub(super) struct EphemeralTerminalResultStore {
    pub(super) entries: VecDeque<EphemeralTerminalResult>,
    pub(super) total_bytes: usize,
}

impl EphemeralTerminalResultStore {
    pub(super) fn record(&mut self, entry: EphemeralTerminalResult) -> Result<(), String> {
        if entry.byte_length() > MAX_EPHEMERAL_TERMINAL_BYTES {
            return Err("TERMINAL_OBSERVATION_TOO_LARGE".into());
        }
        if let Some(index) = self.entries.iter().position(|candidate| {
            candidate.session_id == entry.session_id && candidate.call_id == entry.call_id
        }) {
            if let Some(replaced) = self.entries.remove(index) {
                self.total_bytes = self.total_bytes.saturating_sub(replaced.byte_length());
            }
        }
        self.total_bytes = self.total_bytes.saturating_add(entry.byte_length());
        self.entries.push_back(entry);
        while self.entries.len() > MAX_EPHEMERAL_TERMINAL_RESULTS
            || self.total_bytes > MAX_EPHEMERAL_TERMINAL_BYTES
        {
            let Some(removed) = self.entries.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(removed.byte_length());
        }
        Ok(())
    }

    pub(super) fn apply(&self, session_id: &str, turn_id: &str, request: &mut ModelRequest) {
        for message in &mut request.messages {
            if let ModelMessage::Assistant {
                content,
                replay,
                native_replay,
            } = message
            {
                for block in content {
                    if let ModelContentBlock::ToolCall { call } = block {
                        if let Some(input) = self
                            .entries
                            .iter()
                            .rev()
                            .find(|entry| {
                                entry.session_id == session_id
                                    && entry.turn_id == turn_id
                                    && entry.call_id == call.call_id
                            })
                            .and_then(|entry| entry.input.as_ref())
                            .filter(|input| input.name == call.name)
                        {
                            call.arguments = input.arguments.clone();
                            *replay = None;
                            *native_replay = None;
                        }
                    }
                }
                continue;
            }
            let ModelMessage::Tool {
                call_id, content, ..
            } = message
            else {
                continue;
            };
            if let Some(entry) = self.entries.iter().rev().find(|entry| {
                entry.session_id == session_id
                    && entry.turn_id == turn_id
                    && entry.call_id == *call_id
            }) {
                if let Some(observation) = &entry.content {
                    *content = observation.clone();
                }
            }
        }
    }

    pub(super) fn clear_session(&mut self, session_id: &str) {
        self.entries.retain(|entry| {
            if entry.session_id == session_id {
                self.total_bytes = self.total_bytes.saturating_sub(entry.byte_length());
                false
            } else {
                true
            }
        });
    }
}

pub(super) fn split_terminal_observation_for_persistence(
    tool_name: &str,
    status: AgentToolResultStatus,
    summary: &str,
    data: &mut Option<Value>,
) -> Result<Option<String>, String> {
    if !matches!(tool_name, "read_terminal" | "wait_terminal")
        || status != AgentToolResultStatus::Completed
    {
        return Ok(None);
    }
    let Some(observation) = data.as_ref() else {
        return Ok(None);
    };
    let content = serde_json::to_string(&serde_json::json!({
        "status": status,
        "summary": summary,
        "data": observation,
    }))
    .map_err(|error| format!("Failed to encode ephemeral terminal observation: {error}"))?;
    *data = Some(terminal_observation_metadata(observation));
    Ok(Some(content))
}

fn terminal_observation_metadata(observation: &Value) -> Value {
    let mut durable = serde_json::Map::new();
    for field in [
        "contractVersion",
        "reason",
        "lifecycleSequence",
        "open",
        "credentialLikePrompt",
    ] {
        if let Some(value) = observation.get(field) {
            durable.insert(field.into(), value.clone());
        }
    }
    if let Some(snapshot) = observation.get("snapshot").and_then(Value::as_object) {
        let mut metadata = serde_json::Map::new();
        for field in [
            "protocolVersion",
            "terminalSessionId",
            "terminalGeneration",
            "type",
            "screenVersion",
            "throughOutputSequence",
            "rows",
            "columns",
            "activeBuffer",
        ] {
            if let Some(value) = snapshot.get(field) {
                metadata.insert(field.into(), value.clone());
            }
        }
        if let Some(cursor) = snapshot.get("cursor").and_then(Value::as_object) {
            let mut cursor_metadata = serde_json::Map::new();
            for field in ["row", "column", "visible"] {
                if let Some(value) = cursor.get(field) {
                    cursor_metadata.insert(field.into(), value.clone());
                }
            }
            metadata.insert("cursor".into(), Value::Object(cursor_metadata));
        }
        durable.insert("snapshot".into(), Value::Object(metadata));
    }
    durable.insert("transientObservation".into(), true.into());
    durable.insert("contentPersisted".into(), false.into());
    Value::Object(durable)
}
