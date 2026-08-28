use serde::{Deserialize, Serialize};

const MAX_RUNBOOK_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RunbookRisk {
    ReadOnly,
    StateChange,
    Destructive,
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRunbookFile {
    path: String,
    text: String,
}

#[tauri::command]
pub(crate) async fn open_deployment_runbook_file() -> Result<Option<DeploymentRunbookFile>, String>
{
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("打开 Deployment Runbook")
            .add_filter("TermBridge Deployment Runbook", &["json"])
            .pick_file();
        let Some(path) = path else {
            return Ok(None);
        };
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("failed to inspect deployment runbook file: {error}"))?;
        if metadata.len() > MAX_RUNBOOK_BYTES as u64 {
            return Err("deployment runbook file exceeds 512 KiB".to_string());
        }
        let source = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read deployment runbook file: {error}"))?;
        let document = crate::deployment_runbook::parse_deployment_runbook_v2(&source)?;
        let text = crate::deployment_runbook::serialize_deployment_runbook_v2(&document)?;
        Ok(Some(DeploymentRunbookFile {
            path: crate::portable_local_path(&path),
            text,
        }))
    })
    .await
    .map_err(|error| format!("failed to run open deployment runbook dialog: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_deployment_runbook_file(
    text: String,
) -> Result<Option<DeploymentRunbookFile>, String> {
    let document = crate::deployment_runbook::parse_deployment_runbook_v2(&text)?;
    let normalized = crate::deployment_runbook::serialize_deployment_runbook_v2(&document)?;
    let default_name = format!("{}.runbook.json", document.id);
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("保存 Deployment Runbook")
            .add_filter("TermBridge Deployment Runbook", &["json"])
            .set_file_name(&default_name)
            .save_file();
        let Some(path) = path else {
            return Ok(None);
        };
        std::fs::write(&path, &normalized)
            .map_err(|error| format!("failed to write deployment runbook file: {error}"))?;
        Ok(Some(DeploymentRunbookFile {
            path: crate::portable_local_path(&path),
            text: normalized,
        }))
    })
    .await
    .map_err(|error| format!("failed to run save deployment runbook dialog: {error}"))?
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
        assert!(!contains_secret_literal(
            "keychain://deployment/release-token"
        ));
    }
}
