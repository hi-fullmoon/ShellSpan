use super::{
    AgentEntry, AgentRequestReason, AgentRequestSeries, AgentRequestSnapshotReason,
    AgentSessionEvent, AgentSessionEventPayload as Payload, ModelRequest,
};

/// Record full headers only at snapshot boundaries; every dispatch has its own start.
pub(super) fn request_events(
    events: &[AgentSessionEvent],
    entry: &AgentEntry,
    request: &ModelRequest,
    reason: AgentRequestReason,
    attempt: u32,
) -> Vec<Payload> {
    // Surface replacement (compaction) starts a series; append-only Turns do not.
    let series_id = format!("{}-{}", entry.request_series_id, request.surface_generation);
    let previous_series = events.iter().rev().find_map(|event| match &event.payload {
        Payload::RequestStart { series, .. } | Payload::RequestHeader { series, .. } => {
            Some(series)
        }
        _ => None,
    });
    let request_index = previous_series
        .filter(|series| series.series_id == series_id)
        .map_or(0, |series| series.request_index + 1);
    let series = AgentRequestSeries {
        series_id,
        request_index,
        starts_series: request_index == 0,
    };
    let previous_header = events.iter().rev().find_map(|event| match &event.payload {
        header @ Payload::RequestHeader { .. } => Some(header),
        _ => None,
    });
    let reasoning_effort = entry
        .provider
        .reasoning_effort
        .map(|effort| format!("{effort:?}").to_ascii_lowercase());
    let mut header_request_id = request.request_id.clone();
    let snapshot_reason = if let Some(Payload::RequestHeader {
        request_id,
        provider_id,
        model,
        reasoning_effort: previous_effort,
        system_prompt,
        tool_schemas,
        series: previous_series,
        ..
    }) = previous_header
    {
        header_request_id.clone_from(request_id);
        if !previous_series
            .series_id
            .starts_with(&format!("{}-", entry.request_series_id))
        {
            Some(AgentRequestSnapshotReason::Resume)
        } else if series.starts_series {
            Some(AgentRequestSnapshotReason::Series)
        } else if provider_id != &entry.provider.id
            || model != &entry.provider.model
            || previous_effort != &reasoning_effort
            || system_prompt != &request.system_prompt
            || tool_schemas != &request.tools
        {
            Some(AgentRequestSnapshotReason::Change)
        } else {
            None
        }
    } else {
        Some(AgentRequestSnapshotReason::Initial)
    };
    let mut payloads = Vec::new();
    if let Some(snapshot_reason) = snapshot_reason {
        header_request_id.clone_from(&request.request_id);
        payloads.push(Payload::RequestHeader {
            request_id: request.request_id.clone(),
            provider_id: entry.provider.id.clone(),
            model: entry.provider.model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            reason,
            series: series.clone(),
            snapshot_reason: Some(snapshot_reason),
            system_prompt: request.system_prompt.clone(),
            tool_schemas: request.tools.clone(),
            attempt,
        });
    }
    payloads.push(Payload::RequestStart {
        request_id: request.request_id.clone(),
        header_request_id,
        provider_id: entry.provider.id.clone(),
        model: entry.provider.model.clone(),
        reasoning_effort,
        reason,
        series,
        attempt,
    });
    payloads
}
