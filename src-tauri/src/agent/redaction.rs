use regex::Regex;
use std::sync::OnceLock;

pub(crate) const AGENT_REDACTION_MARKER_V1: &str = "[REDACTED]";

#[derive(Clone, Default)]
pub(crate) struct AgentGenericRedactorV1 {
    additional_literal_secrets: Vec<String>,
}

impl AgentGenericRedactorV1 {
    pub(crate) fn new(additional_literal_secrets: Vec<String>) -> Self {
        Self {
            additional_literal_secrets,
        }
    }

    pub(crate) fn redact(&self, value: &str) -> String {
        let literal_redacted = redact_literal_secrets_v1(value, &self.additional_literal_secrets);
        let mut redacted = private_key_pattern_v1()
            .replace_all(&literal_redacted, AGENT_REDACTION_MARKER_V1)
            .into_owned();
        redacted = url_userinfo_pattern_v1()
            .replace_all(
                &redacted,
                format!("${{1}}{AGENT_REDACTION_MARKER_V1}:{AGENT_REDACTION_MARKER_V1}@"),
            )
            .into_owned();
        redacted = authorization_pattern_v1()
            .replace_all(&redacted, format!("${{1}}{AGENT_REDACTION_MARKER_V1}"))
            .into_owned();
        redacted = query_secret_pattern_v1()
            .replace_all(&redacted, format!("${{1}}{AGENT_REDACTION_MARKER_V1}"))
            .into_owned();
        redacted = key_value_pattern_v1()
            .replace_all(
                &redacted,
                format!("${{1}}${{2}}{AGENT_REDACTION_MARKER_V1}"),
            )
            .into_owned();
        redacted = high_confidence_token_pattern_v1()
            .replace_all(&redacted, AGENT_REDACTION_MARKER_V1)
            .into_owned();
        redacted
    }

    /// Reassembles bytes before generic matching so a secret split at any
    /// transport boundary cannot evade the Agent layer.
    pub(crate) fn redact_chunks(&self, chunks: &[&[u8]]) -> String {
        let byte_count = chunks.iter().map(|chunk| chunk.len()).sum();
        let mut bytes = Vec::with_capacity(byte_count);
        for chunk in chunks {
            bytes.extend_from_slice(chunk);
        }
        self.redact(&String::from_utf8_lossy(&bytes))
    }
}

fn private_key_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?is)-----BEGIN (?:[A-Z0-9 -]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9 -]+ )?PRIVATE KEY-----",
        )
        .expect("private key redaction regex")
    })
}

fn url_userinfo_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s:]*:[^@/\s]+@")
            .expect("URL userinfo redaction regex")
    })
}

fn authorization_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?\bauthorization\b["']?\s*[:=]\s*["']?(?:bearer|basic)\s+|\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}"#,
        )
        .expect("authorization redaction regex")
    })
}

fn query_secret_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)([?&](?:access[_-]?token|api[_-]?key|token|key|password|secret)=)[^&#\s]+")
            .expect("URL query redaction regex")
    })
}

fn key_value_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key)\b["']?)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)"#,
        )
        .expect("key-value redaction regex")
    })
}

fn high_confidence_token_pattern_v1() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b",
        )
        .expect("high-confidence token redaction regex")
    })
}

fn redact_literal_secrets_v1(value: &str, secrets: &[String]) -> String {
    let mut needles = secrets
        .iter()
        .map(String::as_str)
        .filter(|secret| !secret.is_empty())
        .collect::<Vec<_>>();
    needles
        .sort_unstable_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    needles.dedup();
    if needles.is_empty() {
        return value.to_string();
    }

    let mut output = String::with_capacity(value.len());
    let mut offset = 0;
    while offset < value.len() {
        let next_match = needles
            .iter()
            .filter_map(|secret| value[offset..].find(secret).map(|index| (index, *secret)))
            .min_by(|(left_index, left_secret), (right_index, right_secret)| {
                left_index
                    .cmp(right_index)
                    .then_with(|| right_secret.len().cmp(&left_secret.len()))
            });
        let Some((relative_index, secret)) = next_match else {
            output.push_str(&value[offset..]);
            break;
        };
        let match_start = offset + relative_index;
        output.push_str(&value[offset..match_start]);
        output.push_str(AGENT_REDACTION_MARKER_V1);
        offset = match_start + secret.len();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_chunk_reassembly_redacts_unicode_key_values_and_literal_secrets() {
        let redactor = AgentGenericRedactorV1::new(vec!["额外秘密值".to_string()]);
        let redacted = redactor.redact_chunks(&[
            "日志 password=päss秘".as_bytes(),
            "密 token=abc".as_bytes(),
            "defghijklmnop 额外".as_bytes(),
            "秘密值".as_bytes(),
        ]);
        assert!(redacted.contains("password=[REDACTED]"));
        assert!(redacted.contains("token=[REDACTED]"));
        assert!(!redacted.contains("päss秘密"));
        assert!(!redacted.contains("abcdefgh"));
        assert!(!redacted.contains("额外秘密值"));
    }

    #[test]
    fn url_userinfo_connection_strings_and_query_secrets_are_redacted() {
        let redactor = AgentGenericRedactorV1::default();
        let input = "postgres://dbuser:p%40ss秘密@db.internal/app redis://:redis-pass@cache/0 Server=db;User Id=sa;Password=S3cret! https://api.invalid/x?token=abcdefghijklmnop&ok=1";
        let redacted = redactor.redact(input);
        assert_eq!(
            redacted,
            "postgres://[REDACTED]:[REDACTED]@db.internal/app redis://[REDACTED]:[REDACTED]@cache/0 Server=db;User Id=sa;Password=[REDACTED] https://api.invalid/x?token=[REDACTED]&ok=1"
        );
    }

    #[test]
    fn literal_redaction_is_single_pass_and_does_not_reprocess_the_marker() {
        let redactor = AgentGenericRedactorV1::new(vec![
            "short".to_string(),
            "short-secret".to_string(),
            "REDACTED".to_string(),
        ]);
        assert_eq!(redactor.redact("value=short-secret"), "value=[REDACTED]");
    }

    #[test]
    fn json_yaml_and_header_key_value_forms_share_the_generic_boundary() {
        let redacted = AgentGenericRedactorV1::default().redact(
            r#"{"token":"json-secret","nested":{"apiKey":"another-secret"}}
password: yaml-secret
Authorization: Basic dXNlcjpwYXNz"#,
        );
        assert!(!redacted.contains("json-secret"));
        assert!(!redacted.contains("another-secret"));
        assert!(!redacted.contains("yaml-secret"));
        assert!(!redacted.contains("dXNlcjpwYXNz"));
        assert_eq!(redacted.matches(AGENT_REDACTION_MARKER_V1).count(), 4);
    }

    #[test]
    fn private_keys_and_high_confidence_tokens_are_removed_after_unicode_chunk_splits() {
        let redactor = AgentGenericRedactorV1::default();
        let key = "前缀🙂-----BEGIN OPENSSH PRIVATE KEY-----\nabc秘密xyz\n-----END OPENSSH PRIVATE KEY-----后缀 ghp_abcdefghijklmnopqrstuvwxyz1234";
        let bytes = key.as_bytes();
        let emoji_middle = "前缀".len() + 2;
        let redacted = redactor.redact_chunks(&[
            &bytes[..emoji_middle],
            &bytes[emoji_middle..35],
            &bytes[35..],
        ]);
        assert!(redacted.contains('🙂'));
        assert!(!redacted.contains('\u{fffd}'));
        assert!(!redacted.contains("abc秘密xyz"));
        assert!(!redacted.contains("ghp_"));
        assert_eq!(redacted.matches(AGENT_REDACTION_MARKER_V1).count(), 2);
    }
}
