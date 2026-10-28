use super::{
    redact_sensitive_text, AgentSessionEvent, AgentSessionEventPayload,
    MAX_AGENT_STREAM_DELTA_BYTES,
};

/// Split only the already-sanitized durable copy. Metadata is emitted once;
/// concatenating each delta field reproduces the sanitized input exactly.
pub(super) fn split_sanitized_event(event: AgentSessionEvent) -> Vec<AgentSessionEvent> {
    let AgentSessionEventPayload::AssistantChunk {
        request_id,
        text_delta,
        reasoning_delta,
        tool_call_delta,
        usage,
    } = &event.payload
    else {
        return vec![event];
    };
    let arguments = tool_call_delta
        .as_ref()
        .and_then(|delta| delta.arguments_delta.as_deref());
    if [text_delta.as_deref(), reasoning_delta.as_deref(), arguments]
        .into_iter()
        .flatten()
        .all(|value| value.len() <= MAX_AGENT_STREAM_DELTA_BYTES)
    {
        return vec![event];
    }

    let text = split_delta(text_delta.as_deref());
    let reasoning = split_delta(reasoning_delta.as_deref());
    let arguments = split_delta(arguments);
    let count = text.len().max(reasoning.len()).max(arguments.len());
    (0..count)
        .map(|position| {
            let tool_delta = tool_call_delta.as_ref().and_then(|delta| {
                if position > 0 && position >= arguments.len() {
                    return None;
                }
                let mut delta = delta.clone();
                if position > 0 {
                    delta.call_id = None;
                    delta.name_delta = None;
                }
                delta.arguments_delta = arguments.get(position).map(|value| (*value).to_owned());
                Some(delta)
            });
            let payload = AgentSessionEventPayload::AssistantChunk {
                request_id: request_id.clone(),
                text_delta: text.get(position).map(|value| (*value).to_owned()),
                reasoning_delta: reasoning.get(position).map(|value| (*value).to_owned()),
                tool_call_delta: tool_delta,
                usage: if position == 0 { usage.clone() } else { None },
            };
            AgentSessionEvent::new(
                event.session_id.clone(),
                event.seq,
                event.time_unix_ms,
                event.turn_id.clone(),
                event.step_id.clone(),
                payload,
            )
        })
        .collect()
}

fn split_delta(value: Option<&str>) -> Vec<&str> {
    fn append<'a>(value: &'a str, chunks: &mut Vec<&'a str>) {
        if value.len() <= MAX_AGENT_STREAM_DELTA_BYTES && redact_sensitive_text(value) == value {
            chunks.push(value);
            return;
        }
        // A cut can turn a preserved secret reference or quoted redaction
        // marker into an incomplete assignment. Subdivide that slice until
        // every persisted piece also passes the restart redaction check.
        let mut boundary = if value.len() > MAX_AGENT_STREAM_DELTA_BYTES {
            MAX_AGENT_STREAM_DELTA_BYTES
        } else {
            value.len() / 2
        };
        while !value.is_char_boundary(boundary) {
            boundary -= 1;
        }
        assert!(boundary > 0 && boundary < value.len());
        append(&value[..boundary], chunks);
        append(&value[boundary..], chunks);
    }

    let mut chunks = Vec::new();
    if let Some(value) = value {
        append(value, &mut chunks);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_split_preserves_redacted_markers_references_and_utf8_at_every_cut() {
        for tail in [
            " token=[REDACTED]; 中文完成",
            " token='[REDACTED]'; 中文完成",
            " token=${{ secrets.ACCESS_TOKEN }}; 中文完成",
            " token='${{ secrets.ACCESS_TOKEN }}'; 中文完成",
        ] {
            let tail = redact_sensitive_text(tail);
            for offset in 1..tail.len() {
                let value = format!(
                    "{}{tail}",
                    "x".repeat(MAX_AGENT_STREAM_DELTA_BYTES - offset)
                );
                assert_eq!(redact_sensitive_text(&value), value);
                let chunks = split_delta(Some(&value));
                assert!(chunks.len() > 1);
                assert_eq!(chunks.concat(), value);
                for chunk in chunks {
                    assert!(!chunk.is_empty());
                    assert!(chunk.len() <= MAX_AGENT_STREAM_DELTA_BYTES);
                    assert_eq!(redact_sensitive_text(chunk), chunk);
                }
            }
        }
        assert!(split_delta(None).is_empty());
        assert_eq!(split_delta(Some("")), [""]);
        assert_eq!(split_delta(Some(" \r\n\t")), [" \r\n\t"]);
    }
}
