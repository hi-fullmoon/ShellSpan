#[allow(
    dead_code,
    reason = "M3 Runbook integration is intentionally outside M2"
)]
pub(crate) fn contains_secret_literal(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let compact = lower
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    [
        "password=",
        "password:",
        "passphrase=",
        "passphrase:",
        "api_key=",
        "api-key=",
        "secret=",
        "token=",
        "authorization:bearer",
        "-----beginprivatekey-----",
        "-----beginopensshprivatekey-----",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
        || lower
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|word| {
                (word.starts_with("akia") && word.len() >= 16)
                    || (["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
                        .iter()
                        .any(|prefix| word.starts_with(prefix))
                        && word.len() >= 24)
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_literal_secret_markers() {
        assert!(contains_secret_literal("token=abc"));
        assert!(contains_secret_literal(
            "-----BEGIN OPENSSH PRIVATE KEY-----"
        ));
        assert!(!contains_secret_literal("keychain://credentials/example"));
    }
}
