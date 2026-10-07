//! Shared save boundary for ordinary logs and structured diagnostic exports.

use crate::redaction::{redact_json_value, redact_sensitive_text};
use std::path::Path;

pub(super) fn write_redacted_export(path: &Path, content: &str) -> Result<(), String> {
    let sanitized = match serde_json::from_str::<serde_json::Value>(content) {
        Ok(value) => serde_json::to_string_pretty(&redact_json_value(&value))
            .map_err(|error| format!("failed to encode log export: {error}"))?,
        Err(_) => redact_sensitive_text(content),
    };
    std::fs::write(path, sanitized).map_err(|error| format!("failed to write log file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_log_export_redacts_owned_markers_and_preserves_diagnostics_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ordinary.log");
        let content = "backend=macos-seatbelt capability=partial exitCode=1\nsecret=phase5-owned-secret\nAuthorization: Bearer phase5-owned-bearer\nOPENAI_API_KEY=phase5-owned-env\nAWS_SECRET_ACCESS_KEY=phase5-owned-cloud\n";
        write_redacted_export(&path, content).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        for marker in [
            "phase5-owned-secret",
            "phase5-owned-bearer",
            "phase5-owned-env",
            "phase5-owned-cloud",
        ] {
            assert!(!saved.contains(marker), "Owned marker survived export");
        }
        assert!(saved.contains("backend=macos-seatbelt capability=partial exitCode=1"));
        assert!(saved.contains("[REDACTED]"));
        assert!(content.contains("phase5-owned-secret"));
    }

    #[test]
    fn diagnostic_json_export_redacts_structured_fields_and_log_text_on_disk() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("diagnostic.json");
        let content = serde_json::json!({
            "schemaVersion": 1,
            "application": {"name": "ShellSpan", "version": "acceptance"},
            "featureState": {"terminalSessions": 1, "aiConfigured": true},
            "recentFailures": [{"operationId": "phase5-owned-operation", "category": "network"}],
            "selectedLog": {"name": "backend.log", "source": "backend", "content": "exitCode=1\nAuthorization: Bearer phase5-owned-bearer\nOPENAI_API_KEY=phase5-owned-env"},
            "environment": {"OPENAI_API_KEY": "phase5-owned-json-env", "customProviderApiKey": "phase5-owned-custom-env", "AWS_ACCESS_KEY_ID": "phase5-owned-access-id", "AWS_SECRET_ACCESS_KEY": "phase5-owned-cloud-env"},
            "credentialReference": "phase5-credential-reference",
            "secret": "phase5-owned-json-secret"
        });
        write_redacted_export(&path, &content.to_string()).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        for marker in [
            "phase5-owned-bearer",
            "phase5-owned-env",
            "phase5-owned-json-env",
            "phase5-owned-json-secret",
            "phase5-owned-custom-env",
            "phase5-owned-cloud-env",
            "phase5-owned-access-id",
        ] {
            assert!(!saved.contains(marker), "Owned marker survived JSON export");
        }
        let decoded: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(decoded["schemaVersion"], 1);
        assert_eq!(decoded["application"], content["application"]);
        assert_eq!(decoded["featureState"], content["featureState"]);
        assert_eq!(decoded["recentFailures"], content["recentFailures"]);
        assert_eq!(
            decoded["credentialReference"],
            content["credentialReference"]
        );
        assert_eq!(decoded["selectedLog"]["source"], "backend");
        assert!(decoded["selectedLog"]["content"]
            .as_str()
            .unwrap()
            .contains("exitCode=1"));
    }

    #[test]
    fn export_write_failure_is_reported_without_claiming_success() {
        let root = tempfile::tempdir().unwrap();
        assert!(write_redacted_export(root.path(), "exitCode=1").is_err());
    }
}
