use serde_json::Value;

pub(crate) const REDACTED_VALUE: &str = "[REDACTED]";
const REDACTED_PRIVATE_KEY: &str = "[REDACTED PRIVATE KEY]";

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn is_sensitive_key(key: &str) -> bool {
    matches!(
        normalized_key(key).as_str(),
        "apikey"
            | "accesstoken"
            | "authtoken"
            | "authorization"
            | "clientsecret"
            | "credential"
            | "credentials"
            | "passphrase"
            | "password"
            | "passwd"
            | "privatekey"
            | "privatekeydata"
            | "pwd"
            | "secret"
            | "token"
    )
}

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin openssh private key-----")
        || lower.contains("-----begin rsa private key-----")
        || lower.contains("-----begin ec private key-----")
        || lower.contains("-----begin dsa private key-----")
        || lower.contains("-----begin encrypted private key-----")
        || lower.contains("-----begin private key-----")
    {
        return REDACTED_PRIVATE_KEY.to_string();
    }

    let suspicious = [
        "authorization:",
        "api_key=",
        "api-key=",
        "apikey=",
        "access_token=",
        "access-token=",
        "auth_token=",
        "auth-token=",
        "client_secret=",
        "client-secret=",
        "aws_secret_access_key=",
        "aws-secret-access-key=",
        "openai_api_key=",
        "openai-api-key=",
        "anthropic_api_key=",
        "anthropic-api-key=",
        "google_api_key=",
        "google-api-key=",
        "password=",
        "password:",
        "passwd=",
        "passwd:",
        "passphrase=",
        "passphrase:",
        "private_key=",
        "private-key=",
        "secret=",
        "secret:",
        "token=",
        "token:",
        "--api-key",
        "--api_key",
        "--access-token",
        "--access_token",
        "--auth-token",
        "--auth_token",
        "--client-secret",
        "--client_secret",
        "--password",
        "--passwd",
        "--passphrase",
        "--private-key",
        "--secret",
        "--token",
    ];
    if suspicious.iter().any(|marker| lower.contains(marker))
        || contains_well_known_token(value)
        || contains_jwt(value)
        || contains_url_credentials(value)
    {
        REDACTED_VALUE.to_string()
    } else {
        value.to_string()
    }
}

fn contains_well_known_token(value: &str) -> bool {
    value
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .any(|token| {
            (token.starts_with("AKIA")
                && token.len() == 20
                && token
                    .chars()
                    .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit()))
                || (["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
                    .iter()
                    .any(|prefix| token.starts_with(prefix) && token.len() >= prefix.len() + 20))
        })
        || value.split_whitespace().any(|token| {
            let token = token.trim_matches(|character: char| {
                matches!(character, '"' | '\'' | ',' | ';' | ')' | ']' | '}')
            });
            let known_prefix = [
                "sk-", "sk-ant-", "AIza", "glpat-", "npm_", "xoxb-", "xoxa-", "xoxp-", "xoxr-",
                "xoxs-", "sk_live_", "sk_test_",
            ]
            .iter()
            .find(|prefix| token.starts_with(**prefix));
            known_prefix.is_some_and(|prefix| {
                token.len() >= prefix.len() + 20
                    && token.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                    })
            })
        })
}

fn contains_jwt(value: &str) -> bool {
    value.split_whitespace().any(|token| {
        let token = token.trim_matches(|character: char| {
            matches!(character, '"' | '\'' | ',' | ';' | ')' | ']' | '}')
        });
        let mut segments = token.split('.');
        let Some(header) = segments.next() else {
            return false;
        };
        let Some(payload) = segments.next() else {
            return false;
        };
        let Some(signature) = segments.next() else {
            return false;
        };
        segments.next().is_none()
            && header.starts_with("eyJ")
            && payload.len() >= 8
            && signature.len() >= 8
    })
}

fn contains_url_credentials(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        let Some(scheme) = part.find("://") else {
            return false;
        };
        let authority = &part[scheme + 3..];
        let authority = authority.split('/').next().unwrap_or(authority);
        authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
    })
}

pub(crate) fn redact_json_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let redacted = if is_sensitive_key(key) {
                        Value::String(REDACTED_VALUE.to_string())
                    } else {
                        redact_json_value(value)
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_json_value).collect()),
        Value::String(value) => Value::String(redact_sensitive_text(value)),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recursively_redacts_sensitive_keys_and_nested_string_literals() {
        let value = json!({
            "command": "curl --api-key command-secret https://example.test",
            "arguments": {
                "safe": "systemctl status nginx",
                "credentials": { "password": "nested-secret" },
                "items": [{ "output": "Authorization: Bearer bearer-secret" }]
            }
        });

        let redacted = redact_json_value(&value);
        let encoded = serde_json::to_string(&redacted).unwrap();
        assert!(!encoded.contains("command-secret"));
        assert!(!encoded.contains("nested-secret"));
        assert!(!encoded.contains("bearer-secret"));
        assert_eq!(redacted["arguments"]["safe"], "systemctl status nginx");
    }

    #[test]
    fn redacts_common_provider_tokens_and_prefixed_cloud_secret_names() {
        for secret in [
            "AWS_SECRET_ACCESS_KEY=plain-cloud-secret-material",
            "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890",
            "AIzaabcdefghijklmnopqrstuvwxyz1234567890",
            concat!("xoxb", "-1234567890-abcdefghijklmnopqrstuvwxyz"),
        ] {
            assert_eq!(redact_sensitive_text(secret), REDACTED_VALUE);
        }
    }
}
