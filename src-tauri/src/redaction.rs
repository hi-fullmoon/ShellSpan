use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;

pub(crate) const REDACTED_VALUE: &str = "[REDACTED]";
const REDACTED_PRIVATE_KEY: &str = "[REDACTED PRIVATE KEY]";

fn normalized_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn is_sensitive_key(key: &str) -> bool {
    let normalized = normalized_key(key);
    matches!(normalized.as_str(), "credential" | "credentials")
        || [
            "apikey",
            "accesskey",
            "accesskeyid",
            "accesstoken",
            "authtoken",
            "authorization",
            "clientsecret",
            "passphrase",
            "password",
            "passwd",
            "privatekey",
            "privatekeydata",
            "pwd",
            "secret",
            "token",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

// These patterns locate values in prose and code examples, not entire messages.
// Keep replacement markers stable: persisted events are sanitized again on load.
static PRIVATE_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----.*?(?:-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\z)").unwrap()
});
static TERMINAL_PRIVATE_KEYS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&PRIVATE_KEYS.as_str().replace(' ', "")).unwrap());
static TERMINAL_PRIVATE_KEY_BOUNDARY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)-----(BEGIN|END)(?:OPENSSH|RSA|EC|DSA|ENCRYPTED)?PRIVATEKEY-----$").unwrap()
});

pub(crate) enum PrivateKeyBoundary {
    Begin,
    End,
}

pub(crate) fn terminal_private_key_boundary(value: &str) -> Option<PrivateKeyBoundary> {
    let captures = TERMINAL_PRIVATE_KEY_BOUNDARY.captures(value)?;
    Some(if captures[1].eq_ignore_ascii_case("BEGIN") {
        PrivateKeyBoundary::Begin
    } else {
        PrivateKeyBoundary::End
    })
}
static SENSITIVE_VALUES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?i)(?P<prefix>\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|passphrase|private[_-]?key|secret|token|authorization)["']?[ \t]*[:=][ \t]*|--(?:api[_-]key|access[_-]token|auth[_-]token|client[_-]secret|password|passwd|passphrase|private[_-]key|secret|token)(?:[ \t]*=[ \t]*|[ \t]+))"#,
        r#"(?P<value>\[REDACTED(?:[ ]PRIVATE[ ]KEY)?\]|\$\{\{[^\r\n]*?\}\}|"(?:\\.|[^"\\])*(?:"|\z)|'(?:''|[^'])*(?:'|\z)|[|>][+-]?[ \t]*\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|\z))*|(?:Bearer|Basic)[ \t]+[^\s"'`,;<>]+|[^\s"'`,;<>\[\]{}]+)"#,
    )).unwrap()
});
static SECRET_REFERENCES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\$\{\{[ \t]*secrets\.[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}$").unwrap()
});
static URL_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?P<prefix>\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+:)[^\s/@]+@"#).unwrap()
});
static TOKEN_CANDIDATES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_][A-Za-z0-9_.-]*").unwrap());

pub(crate) fn redact_terminal_rows(rows: &mut [String]) -> bool {
    // Screen rows can split even the PEM delimiters. Match across their visual
    // boundaries, then hide affected rows without shifting screen coordinates.
    // The terminal renderer trims trailing spaces, including delimiter spaces
    // at wrap boundaries. Normalize spaces in both the input and the pattern.
    let joined = rows.concat().replace(' ', "");
    let private_keys = TERMINAL_PRIVATE_KEYS.find_iter(&joined).collect::<Vec<_>>();
    let unclosed_private_key = private_keys.iter().any(|key| {
        !matches!(
            terminal_private_key_boundary(key.as_str()),
            Some(PrivateKeyBoundary::End)
        )
    });
    let mut offset = 0;
    for row in rows {
        let end = offset + row.len() - row.bytes().filter(|byte| *byte == b' ').count();
        if private_keys
            .iter()
            .any(|key| key.start() < end && offset < key.end())
        {
            *row = REDACTED_PRIVATE_KEY.to_string();
        } else {
            *row = redact_sensitive_text(row);
        }
        offset = end;
    }
    unclosed_private_key
}

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    let redacted = PRIVATE_KEYS.replace_all(value, REDACTED_PRIVATE_KEY);
    let redacted = URL_CREDENTIALS.replace_all(&redacted, "${prefix}[REDACTED]@");
    let redacted = SENSITIVE_VALUES.replace_all(&redacted, |captures: &Captures<'_>| {
        let value = &captures["value"];
        let unquoted = value.trim_matches(['\'', '"']);
        // A GitHub Actions secret reference names a credential without exposing it.
        if SECRET_REFERENCES.is_match(unquoted) {
            captures[0].to_string()
        } else {
            let newline = if value.ends_with('\n') { "\n" } else { "" };
            format!("{}{}{}", &captures["prefix"], REDACTED_VALUE, newline)
        }
    });
    TOKEN_CANDIDATES
        .replace_all(&redacted, |captures: &Captures<'_>| {
            let token = captures[0].trim_end_matches('.');
            if contains_well_known_token(token) || contains_jwt(token) {
                format!("{}{}", REDACTED_VALUE, &captures[0][token.len()..])
            } else {
                captures[0].to_string()
            }
        })
        .into_owned()
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
            "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890",
            "AIzaabcdefghijklmnopqrstuvwxyz1234567890",
            concat!("xoxb", "-1234567890-abcdefghijklmnopqrstuvwxyz"),
        ] {
            assert_eq!(redact_sensitive_text(secret), REDACTED_VALUE);
        }
        assert_eq!(
            redact_sensitive_text("AWS_SECRET_ACCESS_KEY=plain-cloud-secret-material"),
            "AWS_SECRET_ACCESS_KEY=[REDACTED]"
        );
    }

    #[test]
    fn deployment_example_retains_markdown_and_secret_references() {
        let answer = "部署示例：\n```yaml\nsteps:\n  - uses: appleboy/ssh-action@v1\n    with:\n      password: ${{ secrets.SSH_PASSWORD }}\n      token: '${{ secrets.GITHUB_TOKEN }}'\n      script: npm ci && npm start\n```\n完成后检查服务。";
        assert_eq!(redact_sensitive_text(answer), answer);
        assert_eq!(
            redact_sensitive_text("说明 `password:` 和 `--token` 参数。"),
            "说明 `password:` 和 `--token` 参数。"
        );
        assert_eq!(
            redact_sensitive_text("Done. example.test..."),
            "Done. example.test..."
        );
    }

    #[test]
    fn sensitive_values_do_not_remove_surrounding_answer() {
        let answer = "配置：\npassword: deployment-password\ncurl --api-key 'credential with spaces' https://example.test\nAuthorization: Bearer bearer-secret\n连接 https://user:login-password@example.test/path\n继续部署。";
        let expected = "配置：\npassword: [REDACTED]\ncurl --api-key [REDACTED] https://example.test\nAuthorization: [REDACTED]\n连接 https://user:[REDACTED]@example.test/path\n继续部署。";
        assert_eq!(redact_sensitive_text(answer), expected);
        assert_eq!(redact_sensitive_text(expected), expected);
    }

    #[test]
    fn private_key_blocks_and_provider_tokens_preserve_other_text() {
        let answer = "之前\n-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\n之后 sk-ant-abcdefghijklmnopqrstuvwxyz1234567890 完成";
        assert_eq!(
            redact_sensitive_text(answer),
            "之前\n[REDACTED PRIVATE KEY]\n之后 [REDACTED] 完成"
        );
        assert_eq!(
            redact_sensitive_text("之前\n-----BEGIN RSA PRIVATE KEY-----\nunfinished"),
            "之前\n[REDACTED PRIVATE KEY]"
        );
    }

    #[test]
    fn multiline_and_punctuated_credentials_remain_redacted() {
        for (input, expected) in [
            (
                "password: |\n  first line\n  second line\n完成",
                "password: [REDACTED]\n完成",
            ),
            (
                "password=\"multiple\nlines\"\n完成",
                "password=[REDACTED]\n完成",
            ),
            ("password=\"unfinished secret", "password=[REDACTED]"),
            (
                "token: sk-ant-abcdefghijklmnopqrstuvwxyz1234567890\n完成",
                "token: [REDACTED]\n完成",
            ),
            (
                "值 sk-ant-abcdefghijklmnopqrstuvwxyz1234567890. 完成",
                "值 [REDACTED]. 完成",
            ),
            (
                "{\"password\":\"secret value\",\"port\":22}",
                "{\"password\":[REDACTED],\"port\":22}",
            ),
        ] {
            assert_eq!(redact_sensitive_text(input), expected);
            assert_eq!(redact_sensitive_text(expected), expected);
        }
    }
}
