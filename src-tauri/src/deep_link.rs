//! Controlled `shellspan://` deep-link parsing, redaction checks, and
//! cold-start queue for external application invocations.
//!
//! Security invariant: external deep links may navigate, open standard
//! credential-prompted connections, or prefill an AI composer draft for human
//! review, but never auto-execute commands or auto-submit prompts.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;
use uuid::Uuid;

pub(crate) const DEEP_LINK_EVENT: &str = "shellspan-deep-link";
const MAX_URL_BYTES: usize = 4096;
const MAX_PATH_BYTES: usize = 1024;
const MAX_PROMPT_BYTES: usize = 4096;
const MAX_PENDING_LINKS: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DeepLinkAction {
    NavigateSection {
        section: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workbench_tab: Option<String>,
    },
    NavigateSettings {
        settings_section: String,
    },
    ConnectTerminalProfile {
        profile_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_directory: Option<String>,
    },
    OpenLocalTerminal,
    OpenSftpPath {
        profile_id: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        side: Option<String>,
    },
    OpenAgentSession {
        agent_session_id: String,
    },
    PrefillAgentPrompt {
        prompt: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepLinkDispatch {
    pub(crate) action_id: String,
    pub(crate) action: DeepLinkAction,
}

#[derive(Clone, Default)]
pub(crate) struct PendingDeepLinkQueue {
    inner: Arc<Mutex<VecDeque<DeepLinkDispatch>>>,
}

impl PendingDeepLinkQueue {
    pub(crate) fn enqueue(&self, item: DeepLinkDispatch) {
        if let Ok(mut queue) = self.inner.lock() {
            while queue.len() >= MAX_PENDING_LINKS {
                queue.pop_front();
            }
            queue.push_back(item);
        }
    }

    pub(crate) fn drain(&self) -> Vec<DeepLinkDispatch> {
        self.inner
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
    }
}

fn validate_id(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("Invalid deep-link {field}"));
    }
    Ok(trimmed.to_string())
}

fn validate_allowed(value: &str, allowed: &[&str], field: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Invalid deep-link {field}: {value}"))
    }
}

fn ensure_secret_free(field: &str, value: &str) -> Result<(), String> {
    if crate::redaction::redact_sensitive_text(value) != value {
        return Err(format!(
            "DEEP_LINK_REDACTION_REQUIRED: {field} contains sensitive credentials"
        ));
    }
    Ok(())
}

fn query_param<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_str())
}

pub(crate) fn parse_deep_link_url(raw: &str) -> Result<DeepLinkAction, String> {
    if raw.len() > MAX_URL_BYTES {
        return Err("Deep-link URL exceeds maximum length".into());
    }
    let parsed = Url::parse(raw).map_err(|error| format!("Invalid deep-link URL: {error}"))?;
    if !parsed.scheme().eq_ignore_ascii_case("shellspan") {
        return Err(format!("Unsupported deep-link scheme: {}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let path = parsed.path().trim_matches('/').to_ascii_lowercase();
    let route = if path.is_empty() {
        host
    } else {
        format!("{host}/{path}")
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    match route.as_str() {
        "open" => {
            let section = validate_allowed(
                query_param(&pairs, "section").unwrap_or("workbench"),
                &["workbench", "terminal", "sftp"],
                "section",
            )?;
            let workbench_tab = match query_param(&pairs, "tab") {
                Some(tab) => Some(validate_allowed(
                    tab,
                    &["connections", "knownHosts", "keychain", "monitor", "logs"],
                    "tab",
                )?),
                None => None,
            };
            Ok(DeepLinkAction::NavigateSection {
                section,
                workbench_tab,
            })
        }
        "settings" => {
            let settings_section = validate_allowed(
                query_param(&pairs, "section").unwrap_or("general"),
                &[
                    "appearance",
                    "general",
                    "terminal",
                    "sftp",
                    "ai",
                    "shortcuts",
                    "experimental",
                    "feedback",
                ],
                "section",
            )?;
            Ok(DeepLinkAction::NavigateSettings { settings_section })
        }
        "terminal/open" => {
            let profile_id = validate_id(
                query_param(&pairs, "profile")
                    .ok_or("shellspan://terminal/open requires 'profile'")?,
                "profile",
            )?;
            let initial_directory = match query_param(&pairs, "dir") {
                Some(dir) => {
                    let trimmed = dir.trim();
                    if trimmed.is_empty()
                        || trimmed.len() > MAX_PATH_BYTES
                        || trimmed.contains('\0')
                    {
                        return Err("Invalid deep-link directory path".into());
                    }
                    ensure_secret_free("dir", trimmed)?;
                    Some(trimmed.to_string())
                }
                None => None,
            };
            Ok(DeepLinkAction::ConnectTerminalProfile {
                profile_id,
                initial_directory,
            })
        }
        "terminal/local" => Ok(DeepLinkAction::OpenLocalTerminal),
        "sftp/open" => {
            let profile_id = validate_id(
                query_param(&pairs, "profile").ok_or("shellspan://sftp/open requires 'profile'")?,
                "profile",
            )?;
            let remote_path = query_param(&pairs, "path")
                .ok_or("shellspan://sftp/open requires 'path'")?
                .trim();
            if remote_path.is_empty()
                || remote_path.len() > MAX_PATH_BYTES
                || remote_path.contains('\0')
            {
                return Err("Invalid deep-link SFTP path".into());
            }
            ensure_secret_free("path", remote_path)?;
            let side = match query_param(&pairs, "side") {
                Some(side) => Some(validate_allowed(side, &["remote", "local"], "side")?),
                None => Some("remote".into()),
            };
            Ok(DeepLinkAction::OpenSftpPath {
                profile_id,
                path: remote_path.to_string(),
                side,
            })
        }
        "agent/open" => {
            let agent_session_id = validate_id(
                query_param(&pairs, "session")
                    .ok_or("shellspan://agent/open requires 'session'")?,
                "session",
            )?;
            Ok(DeepLinkAction::OpenAgentSession { agent_session_id })
        }
        "agent/draft" => {
            let prompt = query_param(&pairs, "prompt")
                .ok_or("shellspan://agent/draft requires 'prompt'")?
                .trim();
            if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
                return Err("Deep-link prompt must be 1..=4096 bytes".into());
            }
            ensure_secret_free("prompt", prompt)?;
            let profile_id = match query_param(&pairs, "profile") {
                Some(profile) => Some(validate_id(profile, "profile")?),
                None => None,
            };
            Ok(DeepLinkAction::PrefillAgentPrompt {
                prompt: prompt.to_string(),
                profile_id,
            })
        }
        other => Err(format!("Unsupported deep-link route: {other}")),
    }
}

pub(crate) fn handle_incoming_deep_link(app: &AppHandle, raw: &str) {
    match parse_deep_link_url(raw) {
        Ok(action) => {
            let dispatch = DeepLinkDispatch {
                action_id: format!("deeplink-{}", Uuid::new_v4()),
                action,
            };
            if let Some(queue) = app.try_state::<PendingDeepLinkQueue>() {
                queue.enqueue(dispatch.clone());
            }
            if let Err(error) = app.emit(DEEP_LINK_EVENT, &dispatch) {
                log::warn!("Failed to emit deep-link event: {error}");
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Err(error) => {
            log::warn!("Rejected incoming deep-link URL: {error}");
        }
    }
}

pub(crate) fn enqueue_startup_deep_links(app: &AppHandle) {
    for arg in std::env::args().skip(1) {
        if arg.len() >= 12 && arg[..12].eq_ignore_ascii_case("shellspan://") {
            match parse_deep_link_url(&arg) {
                Ok(action) => {
                    if let Some(queue) = app.try_state::<PendingDeepLinkQueue>() {
                        queue.enqueue(DeepLinkDispatch {
                            action_id: format!("deeplink-{}", Uuid::new_v4()),
                            action,
                        });
                    }
                }
                Err(error) => {
                    log::warn!("Rejected startup deep-link argument: {error}");
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) fn drain_pending_deep_links(
    queue: State<'_, PendingDeepLinkQueue>,
) -> Vec<DeepLinkDispatch> {
    queue.drain()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_navigation_terminal_sftp_and_session_deep_links() {
        assert_eq!(
            parse_deep_link_url("shellspan://open?section=workbench&tab=logs").unwrap(),
            DeepLinkAction::NavigateSection {
                section: "workbench".into(),
                workbench_tab: Some("logs".into()),
            }
        );
        assert_eq!(
            parse_deep_link_url("shellspan://settings?section=ai").unwrap(),
            DeepLinkAction::NavigateSettings {
                settings_section: "ai".into(),
            }
        );
        assert_eq!(
            parse_deep_link_url("shellspan://terminal/open?profile=prod-1&dir=%2Fvar%2Flog")
                .unwrap(),
            DeepLinkAction::ConnectTerminalProfile {
                profile_id: "prod-1".into(),
                initial_directory: Some("/var/log".into()),
            }
        );
        assert_eq!(
            parse_deep_link_url("shellspan://terminal/local").unwrap(),
            DeepLinkAction::OpenLocalTerminal
        );
        assert_eq!(
            parse_deep_link_url("shellspan://sftp/open?profile=prod-1&path=%2Fetc%2Fnginx")
                .unwrap(),
            DeepLinkAction::OpenSftpPath {
                profile_id: "prod-1".into(),
                path: "/etc/nginx".into(),
                side: Some("remote".into()),
            }
        );
        assert_eq!(
            parse_deep_link_url("shellspan://agent/open?session=session-42").unwrap(),
            DeepLinkAction::OpenAgentSession {
                agent_session_id: "session-42".into(),
            }
        );
    }

    #[test]
    fn agent_draft_only_prefills_and_rejects_secrets_and_invalid_schemes() {
        assert_eq!(
            parse_deep_link_url(
                "shellspan://agent/draft?prompt=Check%20nginx%20error%20logs&profile=prod-1"
            )
            .unwrap(),
            DeepLinkAction::PrefillAgentPrompt {
                prompt: "Check nginx error logs".into(),
                profile_id: Some("prod-1".into()),
            }
        );

        let secret_err = parse_deep_link_url(
            "shellspan://agent/draft?prompt=Authorization%3A%20Bearer%20sk-1234567890abcdef1234567890",
        )
        .expect_err("secret token in deep link must be rejected");
        assert!(secret_err.contains("DEEP_LINK_REDACTION_REQUIRED"));

        assert!(parse_deep_link_url("https://example.com/open").is_err());
        assert!(parse_deep_link_url("shellspan://agent/execute?cmd=rm").is_err());
    }
}
