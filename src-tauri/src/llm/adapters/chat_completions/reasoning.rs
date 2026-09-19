use super::*;
use crate::llm::replay::{object_with_allowed_keys, replay_error, MAX_REPLAY_METADATA_BYTES};

// Payloads are not identifiers: empty text and nullable provider fields are
// valid, and long reasoning must fit the replay blob budget, not an ID budget.
pub(super) fn validate_details(value: &Value) -> Result<(), NormalizedModelError> {
    let details = value.as_array().ok_or_else(|| {
        replay_error(
            "REPLAY_METADATA_INVALID",
            "reasoningDetails must be an array",
        )
    })?;
    for (index, value) in details.iter().enumerate() {
        let label = format!("reasoningDetails[{index}]");
        let detail = object_with_allowed_keys(
            value,
            &[
                "type",
                "text",
                "summary",
                "data",
                "signature",
                "index",
                "id",
                "format",
            ],
            &label,
        )?;
        for key in [
            "type",
            "text",
            "summary",
            "data",
            "signature",
            "id",
            "format",
        ] {
            let Some(value) = detail.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            let text = value.as_str().ok_or_else(|| {
                replay_error(
                    "REPLAY_METADATA_INVALID",
                    format!("{label}.{key} must be a string or null"),
                )
            })?;
            let limit = match key {
                "type" | "id" | "format" => 64 * 1024,
                _ => MAX_REPLAY_METADATA_BYTES,
            };
            if text.len() > limit {
                return Err(replay_error(
                    "REPLAY_METADATA_TOO_LARGE",
                    format!(
                        "{label}.{key} has {} bytes; limit is {limit} bytes",
                        text.len()
                    ),
                ));
            }
        }
        if detail
            .get("index")
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return Err(replay_error(
                "REPLAY_METADATA_INVALID",
                format!("{label}.index must be an unsigned integer or null"),
            ));
        }
    }
    Ok(())
}

fn identity<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value
        .get(key)
        .filter(|value| !value.is_null() && value.as_str() != Some(""))
}

fn compatible_identity(previous: &Value, next: &Value) -> bool {
    ["index", "id", "type"]
        .iter()
        .all(|key| match (identity(previous, key), identity(next, key)) {
            (Some(previous), Some(next)) => previous == next,
            _ => true,
        })
}

pub(super) fn accumulate_details(
    accumulated: &mut Vec<Value>,
    value: &Value,
    cumulative: bool,
) -> Result<(), NormalizedModelError> {
    validate_details(value)?;
    let details = value.as_array().expect("validated reasoning details array");
    if !cumulative {
        // Delta providers return an ordered sequence of fragments. Repeated
        // text is meaningful; never use prefix deduplication on these arrays.
        accumulated.extend(details.iter().cloned());
        return Ok(());
    }
    for (position, detail) in details.iter().enumerate() {
        let target = accumulated
            .iter()
            .position(|previous| {
                compatible_identity(previous, detail)
                    && ["index", "id"].iter().any(|key| {
                        identity(detail, key).is_some()
                            && identity(detail, key) == identity(previous, key)
                    })
            })
            .or_else(|| {
                accumulated.get(position).and_then(|previous| {
                    (compatible_identity(previous, detail)
                        && ["index", "id"].iter().all(|key| {
                            identity(detail, key).is_none() || identity(previous, key).is_none()
                        }))
                    .then_some(position)
                })
            });
        let Some(target) = target else {
            accumulated.push(detail.clone());
            continue;
        };
        let previous = accumulated[target]
            .as_object_mut()
            .expect("validated reasoning detail");
        for (key, value) in detail.as_object().expect("validated reasoning detail") {
            // A terminal placeholder must not erase text or a signature that
            // arrived earlier in the stream.
            if (value.is_null() || value.as_str() == Some(""))
                && previous
                    .get(key)
                    .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
            {
                continue;
            }
            if matches!(key.as_str(), "text" | "summary") {
                if let (Some(Value::String(prior)), Some(fragment)) =
                    (previous.get_mut(key), value.as_str())
                {
                    append_fragment(prior, fragment, true);
                    continue;
                }
            }
            // Opaque signatures/encrypted state in a cumulative response are
            // snapshots, not prose. Concatenating different values corrupts them.
            previous.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}
