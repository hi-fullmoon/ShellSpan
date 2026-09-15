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
    UserImages {
        message_id: String,
        content: String,
        source: AgentMessageSource,
        images: Vec<super::images::ImageRef>,
    },
    User {
        message_id: String,
        content: String,
        source: AgentMessageSource,
    },
    Assistant {
        message_id: String,
        content: Vec<AgentAssistantContentBlock>,
        interrupted: bool,
        #[serde(skip)]
        replay: Option<Box<crate::llm::replay::ReplayEnvelopeV5>>,
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
        // Summaries cannot stand in for pixels. Retain the immutable image inputs across
        // compaction; request budgets may explicitly refuse a history with too many images.
        messages.extend(
            events
                .iter()
                .filter(|event| event.seq <= through)
                .filter_map(|event| {
                    if let AgentSessionEventPayload::UserMessage { message } = &event.payload {
                        if !message.images.is_empty() {
                            return Some(AgentSurfaceMessage::UserImages {
                                message_id: message.message_id.clone(),
                                content: "Image retained from compacted history".into(),
                                source: message.source.clone(),
                                images: message.images.clone(),
                            });
                        }
                    }
                    None
                }),
        );
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
    let mut synthetic_results = std::collections::HashMap::<String, usize>::new();
    let mut pending_calls: Vec<(String, String)> = Vec::new();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::SessionResumed {}
            | AgentSessionEventPayload::TurnEnd { .. } => {
                // An interrupted session may contain tool calls without outcomes.
                // Close their model protocol pairs without executing or asserting an outcome.
                for (call_id, name) in pending_calls.drain(..) {
                    synthetic_results.insert(call_id.clone(), messages.len());
                    messages.push(AgentSurfaceMessage::Tool {
                        call_id, name, status: AgentToolResultStatus::Cancelled,
                        content: "The previous turn ended without a recorded outcome for this call. Do not automatically repeat it; inspect the current state before deciding whether further work is needed.".into(),
                    });
                }
            }
            AgentSessionEventPayload::SkillCatalogPublished { catalog } => {
                let mut source = AgentMessageSource::runtime("Skills catalog".into());
                source.kind = super::AgentMessageSourceKind::SkillCatalog;
                source.producer_id = "shellspan.skills.v1".into();
                source
                    .metadata
                    .insert("digest".into(), catalog.model_catalog_digest.clone().into());
                messages.push(AgentSurfaceMessage::User {
                    message_id: format!("skills-catalog-{}", event.seq),
                    content: catalog.content.clone(),
                    source,
                });
            }
            AgentSessionEventPayload::SkillStepPrepared { prepared } => {
                if let Some(catalog) = &prepared.catalog {
                    let mut source = AgentMessageSource::runtime("Skills catalog".into());
                    source.kind = super::AgentMessageSourceKind::SkillCatalog;
                    source.producer_id = "shellspan.skills.v1".into();
                    source
                        .metadata
                        .insert("digest".into(), catalog.model_catalog_digest.clone().into());
                    source.metadata.insert(
                        "scope".into(),
                        serde_json::to_value(&catalog.scope).unwrap_or_default(),
                    );
                    messages.push(AgentSurfaceMessage::User {
                        message_id: format!("skills-catalog-{}", event.seq),
                        content: catalog.content.clone(),
                        source,
                    });
                }
                for outcome in &prepared.outcomes {
                    if let Some(loaded) = &outcome.loaded {
                        let mut source =
                            AgentMessageSource::runtime(format!("Skill /{}", loaded.name));
                        source.kind = super::AgentMessageSourceKind::SkillInvocation;
                        source.producer_id = "shellspan.skills.v1".into();
                        source.metadata.insert(
                            "provenance".into(),
                            serde_json::to_value(&loaded.provenance).unwrap_or_default(),
                        );
                        source
                            .metadata
                            .insert("renderedHash".into(), loaded.rendered_hash.clone().into());
                        messages.push(AgentSurfaceMessage::User {
                            message_id: format!("skills-invocation-{}-{}", event.seq, loaded.name),
                            content: loaded.rendered.clone(),
                            source,
                        });
                    }
                }
            }
            AgentSessionEventPayload::UserMessage { message } => {
                if let Some(context) = &message.terminal_context {
                    messages.push(AgentSurfaceMessage::User {
                        message_id: format!("{}-terminal-context", message.message_id),
                        content: context.model_content(),
                        source: AgentMessageSource::terminal_output(
                            &context.session_id,
                            context.version,
                            context.max_lines,
                            context.max_bytes,
                        ),
                    });
                }
                messages.push(if message.images.is_empty() {
                    AgentSurfaceMessage::User {
                        message_id: message.message_id.clone(),
                        content: message.content.clone(),
                        source: message.source.clone(),
                    }
                } else {
                    AgentSurfaceMessage::UserImages {
                        message_id: message.message_id.clone(),
                        content: message.content.clone(),
                        source: message.source.clone(),
                        images: message.images.clone(),
                    }
                });
            }
            AgentSessionEventPayload::AssistantMessage {
                message_id,
                content,
                interrupted,
                replay,
                ..
            } => {
                pending_calls.extend(content.iter().filter_map(|block| {
                    if let AgentAssistantContentBlock::ToolCall { call } = block {
                        Some((call.call_id.clone(), call.name.clone()))
                    } else {
                        None
                    }
                }));
                let mut content = content.clone();
                for block in &mut content {
                    match block {
                        AgentAssistantContentBlock::Reasoning { provider_item, .. } => {
                            *provider_item = None;
                        }
                        AgentAssistantContentBlock::ToolCall { call } => {
                            call.provider_call_id = None;
                        }
                        AgentAssistantContentBlock::Text { .. } => {}
                    }
                }
                messages.push(AgentSurfaceMessage::Assistant {
                    message_id: message_id.clone(),
                    content,
                    interrupted: *interrupted,
                    replay: replay.clone().map(Box::new),
                });
            }
            AgentSessionEventPayload::ToolResult {
                call_id,
                name,
                status,
                summary,
                data,
                ..
            } => {
                pending_calls.retain(|(id, _)| id != call_id);
                let result = AgentSurfaceMessage::Tool {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    status: *status,
                    content: if name == super::skills::SKILL_TOOL
                        && *status == AgentToolResultStatus::Completed
                    {
                        data.clone()
                            .and_then(|d| {
                                serde_json::from_value::<super::skills::LoadedSkill>(d).ok()
                            })
                            .filter(|l| l.validate().is_ok())
                            .map(|l| l.rendered)
                            .unwrap_or_else(|| "invalid complete Skill result".into())
                    } else if name == super::user_questions::TOOL_NAME
                        && *status == AgentToolResultStatus::Completed
                    {
                        serde_json::to_string(data).unwrap_or_default()
                    } else {
                        tool_result_content(*status, summary, data.as_ref())
                    },
                };
                if let Some(index) = synthetic_results.remove(call_id) {
                    // A later committed outcome supersedes the placeholder without
                    // creating a second result for the same model tool call.
                    messages[index] = result;
                } else {
                    messages.push(result);
                }
            }
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
    include!("tests/surface.rs");
}
