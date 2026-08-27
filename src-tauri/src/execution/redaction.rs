const REDACTION_MARKER: &str = "[REDACTED]";

/// Replaces exact secret values in one pass over the original input.
///
/// Longest matches win at the same position. A single pass prevents a shorter
/// secret from exposing the suffix of an overlapping longer secret, and keeps
/// replacement text from being processed as input for a later secret.
pub(crate) fn redact_known_secrets(value: &str, secrets: &[String]) -> String {
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
        output.push_str(REDACTION_MARKER);
        offset = match_start + secret.len();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_overlapping_values_without_leaking_a_suffix() {
        let secrets = vec!["short".to_string(), "short-secret".to_string()];
        assert_eq!(
            redact_known_secrets("value=short-secret", &secrets),
            "value=[REDACTED]"
        );
    }

    #[test]
    fn does_not_redact_the_replacement_marker_again() {
        let secrets = vec!["token".to_string(), "REDACTED".to_string()];
        assert_eq!(redact_known_secrets("token", &secrets), "[REDACTED]");
    }
}
