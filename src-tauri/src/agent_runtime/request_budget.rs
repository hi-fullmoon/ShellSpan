//! Provider-confirmed input anchors and conservative estimates for subsequent requests.

use super::{
    estimate_model_surface_budget, AgentSessionEvent, AgentSessionEventPayload as Payload,
    AgentSessionStore, InputTokenMeasurement, ModelRequest, ModelSurfaceBudget,
};
use crate::llm::runtime::PreparedModel;

/// All fields are public model/route facts; credentials and request bodies are excluded.
fn measurement_identity(
    provider: &crate::ai::AiProviderConfig,
    route: &crate::llm::routes::ProviderRoute,
) -> Result<String, String> {
    let definition = crate::llm::catalog::resolve(provider)?.definition;
    let bytes = serde_json::to_vec(&(
        &route.id,
        route.revision,
        &route.adapter_id,
        &route.replay_domain_id,
        &provider.id,
        &provider.base_url,
        &provider.model,
        &provider.profile,
        &provider.reasoning_effort,
        definition,
    ))
    .map_err(|error| error.to_string())?;
    Ok(crate::llm::runtime::digest(&bytes))
}

/// Use the latest completed request in the same generation and configuration.
/// The heuristic floor prevents a low provider count from weakening admission.
fn apply_usage_anchor(
    budget: &mut ModelSurfaceBudget,
    events: &[AgentSessionEvent],
    generation: u64,
    identity: String,
) {
    let mut measurement = InputTokenMeasurement {
        identity,
        heuristic_tokens: budget.estimated_input_tokens,
        usage_adjustment_tokens: 0,
        anchor_request_id: None,
    };
    for (index, event) in events.iter().enumerate().rev() {
        let Payload::RequestContext {
            request_id,
            request_budget,
            surface_generation,
            ..
        } = &event.payload
        else {
            continue;
        };
        if *surface_generation != generation {
            break;
        }
        let Some(anchor) = request_budget
            .as_ref()
            .and_then(|value| value.input_measurement.as_ref())
        else {
            break;
        };
        if anchor.identity != measurement.identity {
            break;
        }
        let usage = events[index + 1..]
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                Payload::RequestUsage {
                    request_id: usage_id,
                    usage,
                    ..
                } if usage_id == request_id => Some(usage),
                _ => None,
            });
        let Some(usage) = usage else { continue };
        let input = usage
            .uncached_input_tokens
            .zip(usage.cache_read_tokens)
            .and_then(|(uncached, cached)| uncached.checked_add(cached))
            .and_then(|tokens| tokens.checked_add(usage.cache_write_tokens.unwrap_or(0)));
        if let Some(input) = input {
            measurement.usage_adjustment_tokens = input.saturating_sub(anchor.heuristic_tokens);
            measurement.anchor_request_id = Some(request_id.clone());
        }
        break;
    }
    budget.estimated_input_tokens = measurement
        .heuristic_tokens
        .saturating_add(measurement.usage_adjustment_tokens);
    budget.input_measurement = Some(measurement);
}

/// Account for the exact current request, including prepared replay when present.
/// Replaying size-only evidence also restores anchors after an application restart.
pub(super) fn estimate_request_budget(
    sessions: &AgentSessionStore,
    session_id: &str,
    model: &PreparedModel,
    request: &ModelRequest,
) -> Result<ModelSurfaceBudget, String> {
    let mut budget = estimate_model_surface_budget(&model.provider, request)?;
    let identity = measurement_identity(&model.provider, &model.route)?;
    sessions.read_events(session_id, |events| {
        apply_usage_anchor(&mut budget, events, request.surface_generation, identity);
    })?;
    Ok(budget)
}

#[cfg(test)]
#[path = "tests/request_budget.rs"]
mod tests;
