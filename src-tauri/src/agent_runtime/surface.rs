use serde::{Deserialize, Serialize};

use super::{
    AgentAssistantContentBlock, AgentCompactionStatus, AgentMessageSource, AgentSessionEvent,
    AgentSessionEventPayload, AgentToolResultStatus,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "role",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AgentSurfaceMessage {
    User {
        message_id: String,
        content: String,
        source: AgentMessageSource,
    },
    Assistant {
        message_id: String,
        content: Vec<AgentAssistantContentBlock>,
        interrupted: bool,
    },
    Tool {
        call_id: String,
        name: String,
        status: AgentToolResultStatus,
        content: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentSurfaceSnapshot {
    pub(crate) generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) replaced_through_seq: Option<u64>,
    pub(crate) messages: Vec<AgentSurfaceMessage>,
}

pub(crate) fn derive_surface(events: &[AgentSessionEvent]) -> Result<AgentSurfaceSnapshot, String> {
    let mut generation = 0_u64;
    let mut replaced_through_seq = None;
    let mut replacement = None;
    let mut pending_summary = None;

    for event in events {
        match &event.payload {
            AgentSessionEventPayload::CompactionSummary {
                summary,
                replaced_through_seq: through,
                surface_generation,
            } => {
                if pending_summary.is_some() {
                    return Err("Agent compaction summaries cannot overlap".into());
                }
                if *surface_generation != generation.saturating_add(1) {
                    return Err("Agent Model Surface generation was not consecutive".into());
                }
                if *through >= event.seq
                    || replaced_through_seq.is_some_and(|previous| *through <= previous)
                {
                    return Err("Agent compaction replacement prefix did not advance".into());
                }
                let replaced_event = usize::try_from(*through)
                    .ok()
                    .and_then(|index| events.get(index));
                if !replaced_event.is_some_and(|candidate| {
                    candidate.seq == *through
                        && matches!(candidate.payload, AgentSessionEventPayload::TurnEnd { .. })
                }) {
                    return Err(
                        "Agent compaction must replace through a complete Turn boundary".into(),
                    );
                }
                generation = *surface_generation;
                replaced_through_seq = Some(*through);
                replacement = Some(AgentSurfaceMessage::User {
                    message_id: format!("compaction-{surface_generation}"),
                    content: summary.clone(),
                    source: AgentMessageSource::runtime("Compaction summary".into()),
                });
                pending_summary = Some((*surface_generation, *through));
            }
            AgentSessionEventPayload::CompactionEnd {
                surface_generation,
                replaced_through_seq: through,
                status,
            } => match (*status, pending_summary) {
                (_, Some(summary)) if summary == (*surface_generation, *through) => {
                    pending_summary = None;
                }
                (AgentCompactionStatus::Completed, _) => {
                    return Err("Agent compaction/end did not match its summary".into());
                }
                (AgentCompactionStatus::Failed, None) => {
                    if *surface_generation != generation.saturating_add(1)
                        || *through >= event.seq
                        || replaced_through_seq.is_some_and(|previous| *through <= previous)
                    {
                        return Err("failed Agent compaction described an invalid prefix".into());
                    }
                    let replaced_event = usize::try_from(*through)
                        .ok()
                        .and_then(|index| events.get(index));
                    if !replaced_event.is_some_and(|candidate| {
                        candidate.seq == *through
                            && matches!(candidate.payload, AgentSessionEventPayload::TurnEnd { .. })
                    }) {
                        return Err(
                            "failed Agent compaction did not reference a complete Turn".into()
                        );
                    }
                }
                (AgentCompactionStatus::Failed, Some(_)) => {
                    return Err("Agent compaction/end did not match its summary".into());
                }
            },
            _ => {}
        }
    }

    let mut messages = Vec::new();
    if let (Some(through), Some(summary)) = (replaced_through_seq, replacement) {
        messages.push(summary);
        append_surface_events(
            events.iter().filter(|event| event.seq > through),
            &mut messages,
        );
    } else {
        append_surface_events(events.iter(), &mut messages);
    }

    Ok(AgentSurfaceSnapshot {
        generation,
        replaced_through_seq,
        messages,
    })
}

pub(crate) fn surface_messages_after(
    events: &[AgentSessionEvent],
    replaced_through_seq: u64,
) -> Vec<AgentSurfaceMessage> {
    let mut messages = Vec::new();
    append_surface_events(
        events
            .iter()
            .filter(|event| event.seq > replaced_through_seq),
        &mut messages,
    );
    messages
}

fn append_surface_events<'a>(
    events: impl Iterator<Item = &'a AgentSessionEvent>,
    messages: &mut Vec<AgentSurfaceMessage>,
) {
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::UserMessage { message } => {
                messages.push(AgentSurfaceMessage::User {
                    message_id: message.message_id.clone(),
                    content: message.content.clone(),
                    source: message.source.clone(),
                });
            }
            AgentSessionEventPayload::AssistantMessage {
                message_id,
                content,
                interrupted,
                ..
            } => messages.push(AgentSurfaceMessage::Assistant {
                message_id: message_id.clone(),
                content: content.clone(),
                interrupted: *interrupted,
            }),
            AgentSessionEventPayload::ToolResult {
                call_id,
                name,
                status,
                summary,
                data,
                ..
            } => messages.push(AgentSurfaceMessage::Tool {
                call_id: call_id.clone(),
                name: name.clone(),
                status: *status,
                content: tool_result_content(*status, summary, data.as_ref()),
            }),
            _ => {}
        }
    }
}

fn tool_result_content(
    status: AgentToolResultStatus,
    summary: &str,
    data: Option<&serde_json::Value>,
) -> String {
    serde_json::to_string(&serde_json::json!({
        "status": status,
        "summary": summary,
        "data": data,
    }))
    .unwrap_or_else(|_| summary.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{
        AgentAssistantContentBlock, AgentInboxMessage, AgentMessageSource, AgentStopReason,
        AgentTokenUsage,
    };

    fn event(seq: u64, payload: AgentSessionEventPayload) -> AgentSessionEvent {
        AgentSessionEvent::new("session".into(), seq, 1_000 + seq, None, None, payload)
    }

    fn user(id: &str, content: &str) -> AgentSessionEventPayload {
        AgentSessionEventPayload::UserMessage {
            message: AgentInboxMessage {
                message_id: id.into(),
                client_submission_id: None,
                content: content.into(),
                source: AgentMessageSource::user(),
            },
        }
    }

    #[test]
    fn surface_excludes_chunks_and_control_events() {
        let events = vec![
            event(0, AgentSessionEventPayload::TurnStart),
            event(1, user("user", "inspect")),
            event(
                2,
                AgentSessionEventPayload::AssistantChunk {
                    request_id: "request".into(),
                    text_delta: Some("par".into()),
                    reasoning_delta: None,
                    tool_call_delta: None,
                    usage: None,
                },
            ),
            event(
                3,
                AgentSessionEventPayload::AssistantMessage {
                    message_id: "assistant".into(),
                    content: vec![AgentAssistantContentBlock::Text {
                        text: "partial".into(),
                    }],
                    usage: AgentTokenUsage::default(),
                    stop_reason: AgentStopReason::Stop,
                    interrupted: false,
                },
            ),
        ];

        let surface = derive_surface(&events).unwrap();
        assert_eq!(surface.messages.len(), 2);
        assert!(matches!(
            surface.messages[0],
            AgentSurfaceMessage::User { .. }
        ));
        assert!(matches!(
            surface.messages[1],
            AgentSurfaceMessage::Assistant { .. }
        ));
    }

    #[test]
    fn surface_preserves_structured_tool_data_for_the_next_model_request() {
        let events = vec![event(
            0,
            AgentSessionEventPayload::ToolResult {
                call_id: "call-1".into(),
                name: "run_terminal_command".into(),
                status: AgentToolResultStatus::Completed,
                summary: "Direct command reached Exited.".into(),
                data: Some(serde_json::json!({
                    "exitCode": 0,
                    "stdout": "Mem: 3.6Gi total\n/dev/vda1 72% /\n",
                    "stderr": "",
                    "truncated": false,
                })),
                duration_ms: Some(1251),
                evidence_refs: Vec::new(),
            },
        )];

        let surface = derive_surface(&events).unwrap();
        let AgentSurfaceMessage::Tool {
            status, content, ..
        } = &surface.messages[0]
        else {
            panic!("expected a tool surface message");
        };
        let content: serde_json::Value = serde_json::from_str(content).unwrap();

        assert_eq!(*status, AgentToolResultStatus::Completed);
        assert_eq!(content["status"], "completed");
        assert_eq!(content["summary"], "Direct command reached Exited.");
        assert_eq!(content["data"]["exitCode"], 0);
        assert_eq!(
            content["data"]["stdout"],
            "Mem: 3.6Gi total\n/dev/vda1 72% /\n"
        );
    }

    #[test]
    fn compaction_replaces_only_model_surface_and_requires_a_turn_boundary() {
        let events = vec![
            event(0, user("old", "old context")),
            event(
                1,
                AgentSessionEventPayload::TurnEnd {
                    reason: "completed".into(),
                },
            ),
            event(
                2,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 1,
                    surface_generation: 1,
                },
            ),
            event(3, user("new", "new context")),
        ];

        let surface = derive_surface(&events).unwrap();
        assert_eq!(surface.generation, 1);
        assert_eq!(surface.replaced_through_seq, Some(1));
        assert_eq!(surface.messages.len(), 2);
        assert!(matches!(
            &surface.messages[0],
            AgentSurfaceMessage::User { content, .. } if content == "summary"
        ));
        assert!(matches!(
            &surface.messages[1],
            AgentSurfaceMessage::User { content, .. } if content == "new context"
        ));
        assert_eq!(events.len(), 4, "the original log remains untouched");
    }

    #[test]
    fn compaction_rejects_generation_gaps_and_partial_turn_prefixes() {
        let gap = vec![
            event(
                0,
                AgentSessionEventPayload::TurnEnd {
                    reason: "ok".into(),
                },
            ),
            event(
                1,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 0,
                    surface_generation: 2,
                },
            ),
        ];
        assert!(derive_surface(&gap).is_err());

        let partial = vec![
            event(0, user("old", "old")),
            event(
                1,
                AgentSessionEventPayload::CompactionSummary {
                    summary: "summary".into(),
                    replaced_through_seq: 0,
                    surface_generation: 1,
                },
            ),
        ];
        assert!(derive_surface(&partial).is_err());
    }
}
