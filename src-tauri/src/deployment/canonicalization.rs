use super::validation_error::{
    WorkflowValidationCode, WorkflowValidationError, WorkflowValidationErrors,
};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

fn sorted_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(sorted_value).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = Map::new();
            for (key, value) in entries {
                sorted.insert(key, sorted_value(value));
            }
            Value::Object(sorted)
        }
        other => other,
    }
}

pub(crate) fn canonical_json_bytes<T: Serialize>(
    value: &T,
) -> Result<Vec<u8>, WorkflowValidationErrors> {
    let value = serde_json::to_value(value).map_err(|error| {
        WorkflowValidationErrors::one(WorkflowValidationError::new(
            WorkflowValidationCode::InvalidJson,
            format!("failed to serialize canonical JSON: {error}"),
        ))
    })?;
    serde_json::to_vec(&sorted_value(value)).map_err(|error| {
        WorkflowValidationErrors::one(WorkflowValidationError::new(
            WorkflowValidationCode::InvalidJson,
            format!("failed to encode canonical JSON: {error}"),
        ))
    })
}

pub(crate) fn canonical_sha256<T: Serialize>(
    value: &T,
) -> Result<String, WorkflowValidationErrors> {
    let bytes = canonical_json_bytes(value)?;
    let digest = Sha256::digest(bytes);
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("sha256:{hex}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_order_does_not_change_digest() {
        let left: Value = serde_json::from_str(r#"{"a":1,"nested":{"b":2,"a":1}}"#).unwrap();
        let right: Value = serde_json::from_str(r#"{"nested":{"a":1,"b":2},"a":1}"#).unwrap();
        assert_eq!(
            canonical_sha256(&left).unwrap(),
            canonical_sha256(&right).unwrap()
        );
    }
}
