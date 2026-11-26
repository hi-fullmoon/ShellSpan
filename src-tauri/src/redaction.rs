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

// These patterns locate values in prose and code examples, not entire messages.
// Keep replacement markers stable: persisted events are sanitized again on load.
static PRIVATE_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)-----BEGIN (?:(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----.*?(?:-----END (?:(?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\z)").unwrap()
});
static TERMINAL_PRIVATE_KEYS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&PRIVATE_KEYS.as_str().replace(' ', "")).unwrap());
static TERMINAL_PRIVATE_KEY_BOUNDARY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)-----(BEGIN|END)(?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED)?PRIVATEKEY|PGPPRIVATEKEYBLOCK)-----$").unwrap()
});
const PRIVATE_KEY_BEGIN_MARKERS: [&str; 7] = [
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
];

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
macro_rules! credential_prefix {
    () => {
        r#"\b(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|passphrase|private[_-]?key|secret|token|authorization|pwd|set-cookie|cookie)|[a-z0-9_-]*(?:pgpassword|dbpass|mysql_pwd|sshpass))["']?[ \t]*"#
    };
}
macro_rules! flag_prefix {
    () => {
        r"(?:--(?:api[_-]key|access[_-]token|auth[_-]token|client[_-]secret|password|passwd|passphrase|private[_-]key|secret|token)|\bsshpass[ \t]+-p)"
    };
}
macro_rules! credential_assignment {
    () => {
        concat!(
            "(?:",
            credential_prefix!(),
            r"[:=][ \t]*|",
            flag_prefix!(),
            r"(?:[ \t]*=[ \t]*|[ \t]+))"
        )
    };
}

macro_rules! credential_values {
    ($double_quoted:literal) => {
        Regex::new(concat!(
            "(?i)(?P<prefix>", credential_assignment!(), ")",
            r#"(?P<value>\[REDACTED(?:[ ]PRIVATE[ ]KEY)?\]|\$\{\{[^\r\n]*?\}\}|"#,
            $double_quoted,
            r#"|'(?:''|[^'])*(?:'|\z)|[|>][+-]?[ \t]*\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|\z))*|(?:Bearer|Basic)[ \t]+[^\s"'`,;<>]+|[^\s"'`,;<>\[\]{}]+)"#,
        )).unwrap()
    };
}

// Keep the journal validator compatible with existing events. New model
// output also recognizes quoted values that cross an escape boundary.
static SENSITIVE_VALUES: LazyLock<Regex> =
    LazyLock::new(|| credential_values!(r#""(?:\\.|[^"\\])*(?:"|\z)"#));
static MODEL_SENSITIVE_VALUES: LazyLock<Regex> =
    LazyLock::new(|| credential_values!(r#""(?:\\(?s:.)|[^"\\])*(?:"|\\?\z)"#));
static OPEN_PRIVATE_KEY_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    let prefixes = PRIVATE_KEY_BEGIN_MARKERS
        .iter()
        .flat_map(|marker| (5..marker.len()).map(|end| &marker[..end]))
        .collect::<Vec<_>>()
        .join("|");
    Regex::new(&format!(r"(?i)(?:{prefixes})\z")).unwrap()
});
static OPEN_CREDENTIAL: LazyLock<Regex> =
    LazyLock::new(|| {
        Regex::new(concat!(
        "(?i)(?:", credential_prefix!(), "|", flag_prefix!(), r"[ \t]*|",
        r"\bcurl\b[^\r\n]*|",
        credential_assignment!(),
        r"(?:Bearer[ \t]*|Basic[ \t]*|\$\{\{[^}\r\n]*(?:\}[^}\r\n]+)*\}?|[|>][+-]?[ \t]*\r?|))\z"
    )).unwrap()
    });
static SECRET_REFERENCES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\$\{\{[ \t]*secrets\.[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}$").unwrap()
});
static URL_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?P<prefix>\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]*:)[^\s/@]+@"#).unwrap()
});
static CURL_USER_FLAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?P<prefix>\bcurl\b[^\r\n]*?[ \t](?:-u|--user)(?:=|[ \t]+)['"]?[^\s:"'`,;<>]+:)[^\s"'`,;<>]+"#).unwrap()
});
static KNOWN_TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:(?:A[KS]IA[A-Z0-9]{16}\b)|(?:gh[pousr]_[A-Za-z0-9_]{20,}\b)|(?:github_pat_[A-Za-z0-9_]{20,}\b)|(?:(?:sk-ant-|sk_live_|sk_test_|glpat-|xox[baprs]-|sk-|AIza|npm_)[A-Za-z0-9_-]{20,})|(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}))",
    )
    .unwrap()
});

/// A preview can only publish text that no later delta can turn into a
/// credential. Keep the unfinished word and any open multiline value.
#[derive(Default)]
pub(crate) struct StreamingRedactor {
    pending: String,
    preview_suspended: bool,
}

impl StreamingRedactor {
    pub(crate) fn push(&mut self, delta: &str) {
        if !self.preview_suspended {
            self.pending.push_str(delta);
        }
    }

    pub(crate) fn drain(&mut self, finished: bool) -> String {
        if finished {
            return redact_model_output_text(&std::mem::take(&mut self.pending));
        }
        let value = &self.pending;
        let word = value.rfind(char::is_whitespace).map_or(0, |index| index);
        let mut cut = if value[word..]
            .chars()
            .all(|c| !c.is_ascii() || c.is_whitespace())
        {
            value.len()
        } else {
            word
        };
        if let Some(open) = OPEN_CREDENTIAL.find(value) {
            cut = cut.min(open.start());
        }
        if let Some(open) = OPEN_PRIVATE_KEY_MARKER.find(value) {
            cut = cut.min(open.start());
        }
        let mut protected = PRIVATE_KEYS.find_iter(value).collect::<Vec<_>>();
        protected.extend(
            MODEL_SENSITIVE_VALUES
                .captures_iter(value)
                .filter_map(|captures| {
                    let matched = captures.get(0)?;
                    let field = captures.name("value")?.as_str();
                    // A YAML block can acquire another indented line in the next delta.
                    let tail = &value[matched.end()..];
                    if field.starts_with(['|', '>'])
                        && field.contains('\n')
                        && (tail.starts_with([' ', '\t']) || matches!(tail, "" | "\r"))
                    {
                        cut = cut.min(matched.start());
                    }
                    Some(matched)
                }),
        );
        protected.sort_unstable_by_key(|matched| std::cmp::Reverse(matched.start()));
        for matched in protected {
            if matched.start() < cut && (cut < matched.end() || matched.end() == value.len()) {
                cut = matched.start();
            }
        }
        let safe = redact_model_output_text(&value[..cut]);
        self.pending.drain(..cut);
        // Do not release a truncated secret when a provider sends an unusually
        // long open value. The final message is sanitized from the full response.
        if self.pending.len() > 128 * 1024 {
            self.pending.clear();
            self.preview_suspended = true;
        }
        safe
    }
}

pub(crate) fn redact_terminal_rows(rows: &mut [String]) {
    // Screen rows can split even the PEM delimiters. Match across their visual
    // boundaries, then hide affected rows without shifting screen coordinates.
    // The terminal renderer trims trailing spaces, including delimiter spaces
    // at wrap boundaries. Normalize spaces in both the input and the pattern.
    let joined = rows.concat().replace(' ', "");
    let private_keys = TERMINAL_PRIVATE_KEYS.find_iter(&joined).collect::<Vec<_>>();
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
}

pub(crate) fn redact_sensitive_text(value: &str) -> String {
    redact_text(value, &SENSITIVE_VALUES)
}

pub(crate) fn redact_model_output_text(value: &str) -> String {
    redact_text(value, &MODEL_SENSITIVE_VALUES)
}

fn redact_text(value: &str, sensitive_values: &Regex) -> String {
    let redacted = PRIVATE_KEYS.replace_all(value, REDACTED_PRIVATE_KEY);
    let redacted = URL_CREDENTIALS.replace_all(&redacted, "${prefix}[REDACTED]@");
    let redacted = CURL_USER_FLAG.replace_all(&redacted, "${prefix}[REDACTED]");
    let redacted = sensitive_values.replace_all(&redacted, |captures: &Captures<'_>| {
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
    KNOWN_TOKENS
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
            ((token.starts_with("AKIA") || token.starts_with("ASIA"))
                && token.len() == 20
                && token
                    .chars()
                    .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit()))
                || (["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]
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
    fn managed_observation_goals_preserve_run_ids_without_exempting_credentials() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../src/lib/ai/__tests__/native-file-observation-goals.json"
        ))
        .unwrap();
        for key in ["referenceGoal", "directGoal"] {
            let goal = fixture[key].as_str().unwrap();
            assert_eq!(redact_sensitive_text(goal), goal);
            assert_eq!(
                redact_json_value(&json!({"goal": goal})),
                json!({"goal": goal})
            );
            let credential_shaped = goal.replacen("runId=", "token=", 1);
            assert_ne!(redact_sensitive_text(&credential_shaped), credential_shaped);
            assert!(redact_sensitive_text(&credential_shaped).contains(REDACTED_VALUE));
        }
        let credential = "token='fixture-credential-value'";
        assert_eq!(redact_sensitive_text(credential), "token=[REDACTED]");
    }

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

    #[test]
    fn preview_is_equivalent_to_full_redaction_at_each_character_boundary() {
        for input in [
            "检查配置。 Authorization: Bearer local-only-value 结束。",
            "Start --password  =  'local-only value' done.",
            "Start password \t= \"local-only\\\"\nvalue\" done.",
            "Start password=\"local-only value \\",
            "Start password: |\r\n  local-only\r\n  value\r\nDone.",
            "连接 https://user:local-only-value@example.test/path 完成。",
            "输出 -----BEGIN OPENSSH PRIVATE KEY-----\nlocal-only value\n-----END OPENSSH PRIVATE KEY-----\n结束。",
            "输出 -----BEGIN OPENſſH PRIVATE KEY-----\nlocal-only value\n-----END OPENſſH PRIVATE KEY-----\n结束。",
            "Start sk-ant-abcdefghijklmnopqrstuvwxyz1234567890. Done.",
            "Start curl -u alice:s3cr3t-password https://example.test Done.",
            "Start token='${{ secrets.ACCESS_TOKEN }}'; Done.",
            "纯中文不需要等到下一行。",
        ] {
            let expected = redact_model_output_text(input);
            let mut stream = StreamingRedactor::default();
            let mut preview = String::new();
            for character in input.chars() {
                stream.push(character.encode_utf8(&mut [0; 4]));
                preview.push_str(&stream.drain(false));
                assert!(expected.starts_with(&preview), "stream published unstable content for {input:?}");
            }
            preview.push_str(&stream.drain(true));
            assert_eq!(preview, expected);
        }
    }

    #[test]
    fn redacts_extended_env_cli_cookie_url_and_token_formats_idempotently() {
        for (input, expected) in [
            ("PGPASSWORD=supersecret psql", "PGPASSWORD=[REDACTED] psql"),
            ("MYSQL_PWD=dbsecret mysql", "MYSQL_PWD=[REDACTED] mysql"),
            ("DBPASS=topsecret ./run", "DBPASS=[REDACTED] ./run"),
            ("Cookie: session_id=abc123", "Cookie: [REDACTED]"),
            (
                "Set-Cookie: sid=xyz789; HttpOnly",
                "Set-Cookie: [REDACTED]; HttpOnly",
            ),
            (
                "curl -u alice:s3cr3t https://example.test",
                "curl -u alice:[REDACTED] https://example.test",
            ),
            (
                "sshpass -p hunter2 ssh host",
                "sshpass -p [REDACTED] ssh host",
            ),
            (
                "git clone https://:ghp_secret123@github.com/org/repo.git",
                "git clone https://:[REDACTED]@github.com/org/repo.git",
            ),
            (
                "aws key ASIA1234567890ABCDEF here",
                "aws key [REDACTED] here",
            ),
            (
                "pat github_pat_11ABCDEFGH012345678901234567890 ok",
                "pat [REDACTED] ok",
            ),
            (
                "-----BEGIN PGP PRIVATE KEY BLOCK-----\nbody\n-----END PGP PRIVATE KEY BLOCK-----",
                "[REDACTED PRIVATE KEY]",
            ),
            // Trailing hyphen on tokens must not leak after redaction.
            (
                "key sk-abcdefghijklmnopqrstuvwxyz- done",
                "key [REDACTED] done",
            ),
            // Non-sensitive words containing `pass` must not be over-redacted.
            ("bypass=true compass=north", "bypass=true compass=north"),
        ] {
            assert_eq!(redact_sensitive_text(input), expected, "{input}");
            assert_eq!(redact_sensitive_text(expected), expected, "{expected}");
        }
    }
}
