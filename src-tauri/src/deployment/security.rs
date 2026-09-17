use super::canonicalization::canonical_json_bytes;
use serde::Serialize;
use serde_json::Value;

pub(crate) const MAX_EVENT_PAYLOAD_BYTES: usize = 16 * 1024;
pub(crate) const MAX_NODE_SUMMARY_BYTES: usize = 16 * 1024;
pub(crate) const MAX_RUN_OUTPUT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_EFFECT_RECEIPT_BYTES: usize = 8 * 1024;
pub(crate) const MAX_APPROVAL_SUMMARY_BYTES: usize = 64 * 1024;
pub(crate) const MAX_IMMUTABLE_PLAN_BYTES: usize = 512 * 1024;
pub(crate) const MAX_AUDIT_EXPORT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_AUDIT_EVENTS: usize = 1_000;

fn forbidden_secret_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "password"
            | "passphrase"
            | "secret"
            | "token"
            | "apikey"
            | "api_key"
            | "privatekey"
            | "private_key"
            | "credentialvalue"
            | "credential_value"
    )
}

fn contains_secret_field(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| forbidden_secret_key(key) || contains_secret_field(value)),
        Value::Array(values) => values.iter().any(contains_secret_field),
        _ => false,
    }
}

pub(crate) fn validate_bounded_safe_json<T: Serialize>(
    value: &T,
    maximum_bytes: usize,
    too_large_code: &str,
) -> Result<String, String> {
    let json_value = serde_json::to_value(value)
        .map_err(|error| format!("failed to encode deployment JSON: {error}"))?;
    if contains_secret_field(&json_value) {
        return Err("DEPLOYMENT_WORKFLOW_SECRET_VALUE_FORBIDDEN".into());
    }
    let bytes = canonical_json_bytes(&json_value).map_err(|error| error.to_string())?;
    if bytes.len() > maximum_bytes {
        return Err(too_large_code.to_string());
    }
    let serialized = String::from_utf8(bytes)
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_UTF8_JSON".to_string())?;
    if crate::runbook::contains_secret_literal(&serialized) {
        return Err("DEPLOYMENT_WORKFLOW_SECRET_LITERAL_FORBIDDEN".into());
    }
    Ok(serialized)
}

pub(crate) fn validate_summary_key(summary_key: &str) -> Result<(), String> {
    if summary_key.is_empty()
        || summary_key.len() > 128
        || !summary_key.starts_with("deployment.")
        || !summary_key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_'))
    {
        return Err("DEPLOYMENT_WORKFLOW_INVALID_SUMMARY_KEY".into());
    }
    Ok(())
}

pub(crate) fn safe_failure_code(value: &str) -> String {
    let code = value
        .split(':')
        .next()
        .unwrap_or("DEPLOYMENT_WORKFLOW_FAILURE");
    if code.len() <= 128
        && code.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
    {
        code.to_string()
    } else {
        "DEPLOYMENT_WORKFLOW_FAILURE".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_json_rejects_secret_fields_literals_and_oversized_values() {
        assert_eq!(
            validate_bounded_safe_json(
                &serde_json::json!({ "password": "not-allowed" }),
                1_024,
                "TOO_LARGE",
            )
            .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_SECRET_VALUE_FORBIDDEN"
        );
        assert_eq!(
            validate_bounded_safe_json(
                &serde_json::json!({ "message": "token=not-allowed" }),
                1_024,
                "TOO_LARGE",
            )
            .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_SECRET_LITERAL_FORBIDDEN"
        );
        assert_eq!(
            validate_bounded_safe_json(
                &serde_json::json!({ "message": "x".repeat(1_024) }),
                32,
                "TOO_LARGE",
            )
            .unwrap_err(),
            "TOO_LARGE"
        );
        assert!(validate_bounded_safe_json(
            &serde_json::json!({ "credentialReference": "keychain://profile/example" }),
            1_024,
            "TOO_LARGE",
        )
        .is_ok());
    }

    #[test]
    fn remote_failures_are_reduced_to_reviewed_codes() {
        assert_eq!(
            safe_failure_code("DEPLOYMENT_WORKFLOW_NODE_FAILED:remote:password=secret"),
            "DEPLOYMENT_WORKFLOW_NODE_FAILED"
        );
        assert_eq!(
            safe_failure_code("remote said hello"),
            "DEPLOYMENT_WORKFLOW_FAILURE"
        );
    }
}
