//! App Control Plane (Phase 1): session-runtime synthetic tools for redacted
//! workspace inspection, root-only UI navigation, and secret-free form draft
//! proposals.
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;
use uuid::Uuid;

use super::{
    AgentCapabilityScope, AgentExecutionSurface, AgentInboxLane, AgentSessionEffect,
    AgentSessionEvent, AgentSessionEventPayload, AgentSessionListRequest,
    AgentSessionPermissionMode, AgentSessionRenameInput, AgentSessionStore, AgentSessionTarget,
    CreateAgentSessionRequest,
};

pub(crate) const APP_INSPECT_TOOL: &str = "app_inspect";
pub(crate) const APP_NAVIGATE_TOOL: &str = "app_navigate";
pub(crate) const APP_PROPOSE_ACTION_TOOL: &str = "app_propose_action";
pub(crate) const APP_TERMINAL_TOOL: &str = "app_terminal";
pub(crate) const APP_SESSION_TOOL: &str = "app_session";

pub(crate) const MAX_APP_SESSIONS_PER_TURN: usize = 3;
const MAX_INSPECT_LIMIT: usize = 50;
const DEFAULT_INSPECT_LIMIT: usize = 20;
const MAX_PATH_BYTES: usize = 1024;
const MAX_SUMMARY_BYTES: usize = 512;
const MAX_NOTES_BYTES: usize = 1024;
const MAX_PROMPT_BYTES: usize = 8192;
const MAX_TITLE_BYTES: usize = 120;
const MAX_TAGS: usize = 16;

pub(crate) fn is_app_control_tool(name: &str) -> bool {
    matches!(
        name,
        APP_INSPECT_TOOL
            | APP_NAVIGATE_TOOL
            | APP_PROPOSE_ACTION_TOOL
            | APP_TERMINAL_TOOL
            | APP_SESSION_TOOL
    )
}

pub(crate) fn is_root_only_app_tool(name: &str) -> bool {
    matches!(
        name,
        APP_NAVIGATE_TOOL | APP_PROPOSE_ACTION_TOOL | APP_TERMINAL_TOOL | APP_SESSION_TOOL
    )
}

pub(crate) fn inspect_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["resource"],
        "properties": {
            "resource": {
                "type": "string",
                "enum": ["profiles", "terminals", "portForwards", "sessions"]
            },
            "query": {
                "type": "string",
                "maxLength": 128
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_INSPECT_LIMIT,
                "default": DEFAULT_INSPECT_LIMIT
            }
        }
    })
}

pub(crate) fn navigate_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["target"],
        "properties": {
            "target": {
                "type": "string",
                "enum": ["section", "workbenchTab", "settings", "terminal", "sftpPath", "hostTool", "agentSession"]
            },
            "section": {
                "type": "string",
                "enum": ["workbench", "terminal", "sftp"]
            },
            "workbenchTab": {
                "type": "string",
                "enum": ["connections", "knownHosts", "keychain", "monitor", "logs"]
            },
            "settingsSection": {
                "type": "string",
                "enum": ["appearance", "general", "terminal", "sftp", "ai", "shortcuts", "experimental", "feedback"]
            },
            "terminalSessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "path": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_PATH_BYTES
            },
            "side": {
                "type": "string",
                "enum": ["remote", "local"],
                "default": "remote"
            },
            "hostTool": {
                "type": "string",
                "enum": ["overview", "quickActions", "portForward"]
            },
            "agentSessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            }
        }
    })
}

pub(crate) fn propose_action_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "summary", "draft"],
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["connectionProfile", "portForward"]
            },
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_SUMMARY_BYTES
            },
            "draft": {
                "type": "object",
                "additionalProperties": true
            }
        }
    })
}

pub(crate) fn terminal_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["action", "explanation"],
        "properties": {
            "action": {
                "type": "string",
                "enum": ["openProfile", "openLocal", "focus"]
            },
            "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "terminalSessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "initialDirectory": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_PATH_BYTES
            },
            "explanation": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_SUMMARY_BYTES
            }
        }
    })
}

pub(crate) fn session_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["action", "explanation"],
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "open", "sendPrompt"]
            },
            "title": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_TITLE_BYTES
            },
            "prompt": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_PROMPT_BYTES
            },
            "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "terminalSessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "targetSessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
            },
            "autoStart": {
                "type": "boolean",
                "default": true
            },
            "focusNewSession": {
                "type": "boolean",
                "default": false
            },
            "explanation": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_SUMMARY_BYTES
            }
        }
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppActionCardKind {
    Navigation,
    Terminal,
    SftpPath,
    HostTool,
    AgentSession,
    ProposalDraft,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppProposalKind {
    ConnectionProfile,
    PortForward,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AppUiAction {
    NavigateSection {
        section: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workbench_tab: Option<String>,
    },
    NavigateSettings {
        settings_section: String,
    },
    FocusTerminal {
        terminal_session_id: String,
    },
    ConnectTerminalProfile {
        profile_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_directory: Option<String>,
    },
    OpenLocalTerminal,
    OpenSftpPath {
        profile_id: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<String>,
    },
    OpenHostTool {
        profile_id: String,
        tool: String,
    },
    OpenAgentSession {
        agent_session_id: String,
    },
    OpenProposalDraft {
        proposal_id: String,
        kind: AppProposalKind,
        draft: Value,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactedProfileSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
    pub(crate) has_jump_host: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) group: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) tags: Vec<String>,
    pub(crate) favorite: bool,
    pub(crate) port_forward_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactedTerminalSummary {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) kind: String,
    pub(crate) status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactedPortForwardSummary {
    pub(crate) operation_id: String,
    pub(crate) profile_id: String,
    pub(crate) config_id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactedAgentSessionSummary {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) ended: bool,
    pub(crate) archived: bool,
    pub(crate) is_root: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_label: Option<String>,
}

pub(crate) trait AppWorkspaceInspector: Send + Sync {
    fn list_profiles(&self) -> Result<Vec<RedactedProfileSummary>, String>;
    fn list_terminals(&self) -> Result<Vec<RedactedTerminalSummary>, String>;
    fn list_port_forwards(&self) -> Result<Vec<RedactedPortForwardSummary>, String>;
}

#[derive(Clone, Default)]
pub(crate) struct AppWorkspaceInspectorSlot {
    inner: Arc<Mutex<Option<Arc<dyn AppWorkspaceInspector>>>>,
}

impl AppWorkspaceInspectorSlot {
    pub(crate) fn install(&self, inspector: Arc<dyn AppWorkspaceInspector>) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "App workspace inspector slot is unavailable".to_string())?;
        *guard = Some(inspector);
        Ok(())
    }

    pub(crate) fn get(&self) -> Option<Arc<dyn AppWorkspaceInspector>> {
        self.inner.lock().ok().and_then(|guard| guard.clone())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AppCreateSessionRequest {
    pub(crate) title: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) terminal_session_id: Option<String>,
    pub(crate) auto_start: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppCreatedSessionOutcome {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) started: bool,
    pub(crate) prompt_queued: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSentPromptOutcome {
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) started: bool,
}

pub(crate) trait AppSessionCoordinator: Send + Sync {
    fn create_root_session(
        &self,
        origin_session_id: &str,
        request: AppCreateSessionRequest,
    ) -> Result<AppCreatedSessionOutcome, String>;

    fn send_prompt_to_root_session(
        &self,
        origin_session_id: &str,
        target_session_id: &str,
        prompt: String,
    ) -> Result<AppSentPromptOutcome, String>;
}

#[derive(Clone, Default)]
pub(crate) struct AppSessionCoordinatorSlot {
    inner: Arc<Mutex<Option<Arc<dyn AppSessionCoordinator>>>>,
}

impl AppSessionCoordinatorSlot {
    pub(crate) fn install(
        &self,
        coordinator: Arc<dyn AppSessionCoordinator>,
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "App session coordinator slot is unavailable".to_string())?;
        *guard = Some(coordinator);
        Ok(())
    }

    pub(crate) fn get(&self) -> Option<Arc<dyn AppSessionCoordinator>> {
        self.inner.lock().ok().and_then(|guard| guard.clone())
    }
}

pub(crate) struct TauriAppSessionCoordinator {
    app: tauri::AppHandle,
}

impl TauriAppSessionCoordinator {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn try_start_with_selection(
        &self,
        runtime: &super::AgentRuntime,
        session_id: &str,
        selection: Option<super::AgentSubagentModel>,
    ) -> bool {
        let Some(selected) = selection else {
            return false;
        };
        let llm = self.app.state::<crate::llm::runtime::LlmRuntime>();
        let Ok(routes) = llm.routes.snapshot() else {
            return false;
        };
        let Ok(route) = routes.route(&selected.route_id) else {
            return false;
        };
        let route_selection = crate::llm::routes::ModelSelection {
            route_id: selected.route_id,
            model_id: selected.model_id,
            reasoning_effort: selected.reasoning_effort,
        };
        let Ok(provider) = route.provider(&route_selection) else {
            return false;
        };
        let Ok(api_key) = llm.routes.credential(route) else {
            return false;
        };
        runtime.start(session_id, provider, api_key).is_ok()
    }
}

impl AppSessionCoordinator for TauriAppSessionCoordinator {
    fn create_root_session(
        &self,
        origin_session_id: &str,
        request: AppCreateSessionRequest,
    ) -> Result<AppCreatedSessionOutcome, String> {
        let runtime = self.app.state::<super::AgentRuntime>();
        let origin_snapshot = runtime.session(origin_session_id)?;
        let inherited_permission = origin_snapshot
            .header
            .permission_mode
            .unwrap_or(AgentSessionPermissionMode::RequestApproval);
        let inherited_model = origin_snapshot.header.model_selection.clone();

        let (target, execution_surface, capability_scope, target_label) =
            if let Some(terminal_id) = request.terminal_session_id.as_deref() {
                let terminals = self.app.state::<crate::models::SessionManager>();
                let found = terminals
                    .list_terminal_snapshots()?
                    .into_iter()
                    .find(|item| item.session_id == terminal_id)
                    .ok_or_else(|| format!("Terminal session '{terminal_id}' was not found"))?;
                let kind = match found.terminal_kind {
                    crate::models::SessionTerminalKind::Local => "local",
                    crate::models::SessionTerminalKind::Remote => "remote",
                };
                let label = found.title.clone();
                (
                    Some(AgentSessionTarget {
                        kind: kind.into(),
                        target_id: format!("terminal-{terminal_id}"),
                        session_id: terminal_id.into(),
                        label: Some(label.clone()),
                        profile_id: request.profile_id.clone(),
                        host: Some(found.host),
                        port: Some(found.port),
                        username: Some(found.username),
                        cwd: None,
                        root_path: None,
                        local_root: None,
                        remote_sandbox_required: None,
                        local_sandbox_required: None,
                    }),
                    AgentExecutionSurface::BoundTerminal,
                    None,
                    Some(label),
                )
            } else if let Some(profile_id) = request.profile_id.as_deref() {
                let db = self.app.state::<crate::db::Database>();
                let row = db
                    .list_profiles()?
                    .into_iter()
                    .find(|item| item.id == profile_id)
                    .ok_or_else(|| format!("Connection profile '{profile_id}' was not found"))?;
                let label = row.name.clone();
                (
                    Some(AgentSessionTarget {
                        kind: "remote".into(),
                        target_id: format!("profile-{profile_id}"),
                        session_id: format!("direct-{profile_id}"),
                        label: Some(label.clone()),
                        profile_id: Some(row.id),
                        host: Some(row.host),
                        port: Some(row.port),
                        username: Some(row.username),
                        cwd: None,
                        root_path: None,
                        local_root: None,
                        remote_sandbox_required: None,
                        local_sandbox_required: None,
                    }),
                    AgentExecutionSurface::Direct,
                    None,
                    Some(label),
                )
            } else {
                const WORKBENCH_TARGET_ID: &str = "workbench-ai";
                (
                    Some(AgentSessionTarget {
                        kind: "local".into(),
                        target_id: WORKBENCH_TARGET_ID.into(),
                        session_id: WORKBENCH_TARGET_ID.into(),
                        label: Some("ShellSpan Workbench".into()),
                        profile_id: None,
                        host: None,
                        port: None,
                        username: None,
                        cwd: None,
                        root_path: None,
                        local_root: None,
                        remote_sandbox_required: None,
                        local_sandbox_required: None,
                    }),
                    AgentExecutionSurface::Direct,
                    Some(AgentCapabilityScope {
                        tool_names: vec![super::user_questions::TOOL_NAME.into()],
                        effects: vec![AgentSessionEffect::None],
                        target_ids: vec![WORKBENCH_TARGET_ID.into()],
                    }),
                    None,
                )
            };

        let session_id = format!("session-{}", Uuid::new_v4());
        let task_id = format!("task-{}", Uuid::new_v4());
        let fallback_goal = request
            .title
            .as_deref()
            .or(request.prompt.as_deref())
            .unwrap_or("New ShellSpan session")
            .chars()
            .take(120)
            .collect::<String>();

        let snapshot = runtime.create_session(CreateAgentSessionRequest {
            session_id: session_id.clone(),
            task_id,
            goal: fallback_goal.clone(),
            parent_session_id: None,
            continued_from_session_id: None,
            target,
            permission_mode: Some(inherited_permission),
            execution_surface,
            success_criteria: Vec::new(),
            capability_scope,
            subagent: None,
        })?;

        let final_title = if let Some(title) = request.title.as_deref() {
            let _ = runtime.rename_session(AgentSessionRenameInput {
                session_id: session_id.clone(),
                expected_revision: snapshot.event_count,
                client_operation_id: format!("app-rename-{}", Uuid::new_v4()),
                title: title.into(),
            });
            title.to_string()
        } else {
            fallback_goal
        };

        let mut prompt_queued = false;
        let mut started = false;
        if let Some(prompt) = request.prompt {
            let message_id = format!("msg-{}", Uuid::new_v4());
            let submission_id = format!("sub-{}", Uuid::new_v4());
            runtime.receive_submission(
                &session_id,
                message_id,
                submission_id,
                prompt,
                None,
                AgentInboxLane::NextTurn,
                false,
                None,
            )?;
            prompt_queued = true;
            if request.auto_start {
                started = self.try_start_with_selection(&runtime, &session_id, inherited_model);
            }
        }

        Ok(AppCreatedSessionOutcome {
            session_id,
            title: final_title,
            started,
            prompt_queued,
            target_label,
        })
    }

    fn send_prompt_to_root_session(
        &self,
        origin_session_id: &str,
        target_session_id: &str,
        prompt: String,
    ) -> Result<AppSentPromptOutcome, String> {
        let runtime = self.app.state::<super::AgentRuntime>();
        let target = runtime.session(target_session_id)?;
        if target.header.parent_session_id.is_some() || target.header.subagent.is_some() {
            return Err(
                "APP_ACTION_INVALID_TARGET: sendPrompt targets only independent root sessions; use send_child_input for subagents"
                    .into(),
            );
        }
        if target.archived {
            return Err("APP_ACTION_INVALID_TARGET: target session is archived".into());
        }
        let selection = target.header.model_selection.clone().or_else(|| {
            runtime
                .session(origin_session_id)
                .ok()
                .and_then(|origin| origin.header.model_selection)
        });
        let message_id = format!("msg-{}", Uuid::new_v4());
        let submission_id = format!("sub-{}", Uuid::new_v4());
        runtime.receive_submission(
            target_session_id,
            message_id,
            submission_id,
            prompt,
            None,
            AgentInboxLane::NextTurn,
            false,
            None,
        )?;
        let started = self.try_start_with_selection(&runtime, target_session_id, selection);
        let title = target.header.title.unwrap_or(target.header.goal);
        Ok(AppSentPromptOutcome {
            session_id: target_session_id.into(),
            title,
            started,
        })
    }
}

pub(crate) struct TauriAppWorkspaceInspector {
    app: tauri::AppHandle,
}

impl TauriAppWorkspaceInspector {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl AppWorkspaceInspector for TauriAppWorkspaceInspector {
    fn list_profiles(&self) -> Result<Vec<RedactedProfileSummary>, String> {
        let db = self.app.state::<crate::db::Database>();
        let rows = db.list_profiles()?;
        Ok(rows.into_iter().map(redact_profile_row).collect())
    }

    fn list_terminals(&self) -> Result<Vec<RedactedTerminalSummary>, String> {
        let sessions = self.app.state::<crate::models::SessionManager>();
        let snapshots = sessions.list_terminal_snapshots()?;
        Ok(snapshots
            .into_iter()
            .map(|item| RedactedTerminalSummary {
                session_id: item.session_id,
                title: item.title,
                host: item.host,
                port: item.port,
                username: item.username,
                kind: match item.terminal_kind {
                    crate::models::SessionTerminalKind::Local => "local".into(),
                    crate::models::SessionTerminalKind::Remote => "remote".into(),
                },
                status: format!("{:?}", item.status).to_lowercase(),
            })
            .collect())
    }

    fn list_port_forwards(&self) -> Result<Vec<RedactedPortForwardSummary>, String> {
        let manager = self.app.state::<crate::port_forward::PortForwardManager>();
        let runtimes = manager.list()?;
        Ok(runtimes
            .into_iter()
            .map(|runtime| RedactedPortForwardSummary {
                operation_id: runtime.operation_id,
                profile_id: runtime.profile_id,
                config_id: runtime.config_id,
                name: runtime.name,
                kind: serde_json::to_value(runtime.kind)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "local".into()),
                status: serde_json::to_value(runtime.status)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "idle".into()),
            })
            .collect())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileOrganizationMeta {
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    port_forwards: Vec<Value>,
}

pub(crate) fn redact_profile_row(row: crate::models::ProfileRow) -> RedactedProfileSummary {
    let org = row
        .organization_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<ProfileOrganizationMeta>(raw).ok())
        .unwrap_or_default();
    RedactedProfileSummary {
        id: row.id,
        name: row.name,
        host: row.host,
        port: row.port,
        username: row.username,
        auth_method: row.auth_method.as_str().into(),
        has_jump_host: row
            .jump_host_config
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        group: org.group.filter(|value| !value.trim().is_empty()),
        tags: org
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .take(MAX_TAGS)
            .collect(),
        favorite: org.favorite,
        port_forward_count: org.port_forwards.len(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppInspectArguments {
    resource: String,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppNavigateArguments {
    target: String,
    #[serde(default)]
    section: Option<String>,
    #[serde(default)]
    workbench_tab: Option<String>,
    #[serde(default)]
    settings_section: Option<String>,
    #[serde(default)]
    terminal_session_id: Option<String>,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    host_tool: Option<String>,
    #[serde(default)]
    agent_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppProposeActionArguments {
    kind: AppProposalKind,
    summary: String,
    draft: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppTerminalArguments {
    action: String,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    terminal_session_id: Option<String>,
    #[serde(default)]
    initial_directory: Option<String>,
    explanation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppSessionArguments {
    action: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    terminal_session_id: Option<String>,
    #[serde(default)]
    target_session_id: Option<String>,
    #[serde(default)]
    auto_start: Option<bool>,
    #[serde(default)]
    focus_new_session: Option<bool>,
    explanation: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionProfileDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortForwardDraft {
    profile_id: String,
    name: String,
    kind: String,
    local_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_port: Option<u16>,
    #[serde(default)]
    auto_start: bool,
}

pub(crate) struct AppControlExecution {
    pub(crate) summary: String,
    pub(crate) data: Value,
    pub(crate) extra_payloads: Vec<AgentSessionEventPayload>,
}

fn ensure_secret_free(field: &str, value: &str) -> Result<(), String> {
    if crate::redaction::redact_sensitive_text(value) != value {
        return Err(format!(
            "APP_ACTION_REDACTION_REQUIRED: field '{field}' contains credentials or secrets; remove all sensitive values and retry"
        ));
    }
    Ok(())
}

fn matches_query(haystack: &str, query: Option<&str>) -> bool {
    let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) else {
        return true;
    };
    haystack.to_lowercase().contains(&query.to_lowercase())
}

pub(crate) struct AppControlCallContext<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) is_subagent: bool,
    pub(crate) permission_mode: AgentSessionPermissionMode,
    pub(crate) call_id: &'a str,
    pub(crate) sessions_created_in_turn: usize,
    pub(crate) sessions: &'a AgentSessionStore,
    pub(crate) inspector: Option<&'a dyn AppWorkspaceInspector>,
    pub(crate) coordinator: Option<&'a dyn AppSessionCoordinator>,
}

pub(crate) fn execute_app_control_tool(
    ctx: AppControlCallContext<'_>,
    tool_name: &str,
    arguments: Value,
) -> Result<AppControlExecution, String> {
    match tool_name {
        APP_INSPECT_TOOL => execute_inspect(arguments, ctx.sessions, ctx.inspector),
        APP_NAVIGATE_TOOL => {
            ensure_root_session(ctx.is_subagent, tool_name)?;
            execute_navigate(ctx.call_id, arguments, ctx.inspector)
        }
        APP_PROPOSE_ACTION_TOOL => {
            ensure_root_session(ctx.is_subagent, tool_name)?;
            execute_propose_action(ctx.call_id, arguments, ctx.inspector)
        }
        APP_TERMINAL_TOOL => {
            ensure_root_session(ctx.is_subagent, tool_name)?;
            execute_terminal(ctx.call_id, arguments, ctx.inspector)
        }
        APP_SESSION_TOOL => {
            ensure_root_session(ctx.is_subagent, tool_name)?;
            execute_session(ctx, arguments)
        }
        _ => Err(format!("unknown app control tool: {tool_name}")),
    }
}

fn ensure_root_session(is_subagent: bool, tool_name: &str) -> Result<(), String> {
    if is_subagent {
        return Err(format!(
            "APP_ACTION_ROOT_ONLY: {tool_name} can only be invoked by a root Session to protect user UI focus"
        ));
    }
    Ok(())
}

fn execute_inspect(
    arguments: Value,
    sessions: &AgentSessionStore,
    inspector: Option<&dyn AppWorkspaceInspector>,
) -> Result<AppControlExecution, String> {
    let args: AppInspectArguments = serde_json::from_value(arguments)
        .map_err(|e| format!("Invalid app_inspect arguments: {e}"))?;
    let limit = args
        .limit
        .unwrap_or(DEFAULT_INSPECT_LIMIT)
        .clamp(1, MAX_INSPECT_LIMIT);
    let query = args.query.as_deref();

    match args.resource.as_str() {
        "profiles" => {
            let Some(inspector) = inspector else {
                return Err(
                    "APP_INSPECT_UNAVAILABLE: workspace inspector is not configured".into(),
                );
            };
            let mut items: Vec<RedactedProfileSummary> = inspector
                .list_profiles()?
                .into_iter()
                .filter(|item| {
                    matches_query(
                        &format!(
                            "{} {} {} {} {}",
                            item.name,
                            item.host,
                            item.username,
                            item.group.as_deref().unwrap_or(""),
                            item.tags.join(" ")
                        ),
                        query,
                    )
                })
                .collect();
            let total = items.len();
            items.truncate(limit);
            Ok(AppControlExecution {
                summary: format!(
                    "Inspected {} of {} saved connection profiles",
                    items.len(),
                    total
                ),
                data: json!({
                    "resource": "profiles",
                    "total": total,
                    "items": items,
                }),
                extra_payloads: Vec::new(),
            })
        }
        "terminals" => {
            let Some(inspector) = inspector else {
                return Err(
                    "APP_INSPECT_UNAVAILABLE: workspace inspector is not configured".into(),
                );
            };
            let mut items: Vec<RedactedTerminalSummary> = inspector
                .list_terminals()?
                .into_iter()
                .filter(|item| {
                    matches_query(
                        &format!(
                            "{} {} {} {}",
                            item.title, item.host, item.username, item.session_id
                        ),
                        query,
                    )
                })
                .collect();
            let total = items.len();
            items.truncate(limit);
            Ok(AppControlExecution {
                summary: format!(
                    "Inspected {} of {} open terminal sessions",
                    items.len(),
                    total
                ),
                data: json!({
                    "resource": "terminals",
                    "total": total,
                    "items": items,
                }),
                extra_payloads: Vec::new(),
            })
        }
        "portForwards" => {
            let Some(inspector) = inspector else {
                return Err(
                    "APP_INSPECT_UNAVAILABLE: workspace inspector is not configured".into(),
                );
            };
            let mut items: Vec<RedactedPortForwardSummary> = inspector
                .list_port_forwards()?
                .into_iter()
                .filter(|item| {
                    matches_query(
                        &format!(
                            "{} {} {} {}",
                            item.name, item.profile_id, item.kind, item.status
                        ),
                        query,
                    )
                })
                .collect();
            let total = items.len();
            items.truncate(limit);
            Ok(AppControlExecution {
                summary: format!(
                    "Inspected {} of {} port-forward runtimes",
                    items.len(),
                    total
                ),
                data: json!({
                    "resource": "portForwards",
                    "total": total,
                    "items": items,
                }),
                extra_payloads: Vec::new(),
            })
        }
        "sessions" => {
            let page = sessions.list_page(AgentSessionListRequest {
                cursor: None,
                limit: MAX_INSPECT_LIMIT,
            })?;
            let mut items: Vec<RedactedAgentSessionSummary> =
                page.sessions
                    .into_iter()
                    .map(|item| {
                        let title = item
                            .header
                            .title
                            .clone()
                            .unwrap_or_else(|| item.header.goal.clone());
                        let target_label = item.header.target.as_ref().and_then(|target| {
                            target.label.clone().or_else(|| target.host.clone())
                        });
                        RedactedAgentSessionSummary {
                            session_id: item.header.session_id,
                            title,
                            status: serde_json::to_value(item.status)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_string))
                                .unwrap_or_else(|| "idle".into()),
                            ended: item.ended,
                            archived: item.archived,
                            is_root: item.header.parent_session_id.is_none()
                                && item.header.subagent.is_none(),
                            target_label,
                        }
                    })
                    .filter(|item| {
                        matches_query(
                            &format!(
                                "{} {} {}",
                                item.title,
                                item.session_id,
                                item.target_label.as_deref().unwrap_or("")
                            ),
                            query,
                        )
                    })
                    .collect();
            let total = items.len();
            items.truncate(limit);
            Ok(AppControlExecution {
                summary: format!("Inspected {} of {} AI sessions", items.len(), total),
                data: json!({
                    "resource": "sessions",
                    "total": total,
                    "items": items,
                }),
                extra_payloads: Vec::new(),
            })
        }
        other => Err(format!("Unsupported app_inspect resource: {other}")),
    }
}

fn validate_allowed(value: &str, allowed: &[&str], field: &str) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("Invalid {field}: {value}"))
    }
}

fn execute_navigate(
    call_id: &str,
    arguments: Value,
    inspector: Option<&dyn AppWorkspaceInspector>,
) -> Result<AppControlExecution, String> {
    let args: AppNavigateArguments = serde_json::from_value(arguments)
        .map_err(|e| format!("Invalid app_navigate arguments: {e}"))?;

    let (action, card_kind, title, subtitle) = match args.target.as_str() {
        "section" => {
            let section = args
                .section
                .ok_or("app_navigate target 'section' requires 'section'")?;
            validate_allowed(&section, &["workbench", "terminal", "sftp"], "section")?;
            if let Some(tab) = args.workbench_tab.as_deref() {
                validate_allowed(
                    tab,
                    &["connections", "knownHosts", "keychain", "monitor", "logs"],
                    "workbenchTab",
                )?;
            }
            let title = format!("Open {section}");
            let subtitle = args.workbench_tab.clone();
            (
                AppUiAction::NavigateSection {
                    section,
                    workbench_tab: args.workbench_tab,
                },
                AppActionCardKind::Navigation,
                title,
                subtitle,
            )
        }
        "workbenchTab" => {
            let tab = args
                .workbench_tab
                .ok_or("app_navigate target 'workbenchTab' requires 'workbenchTab'")?;
            validate_allowed(
                &tab,
                &["connections", "knownHosts", "keychain", "monitor", "logs"],
                "workbenchTab",
            )?;
            let title = format!("Open workbench/{tab}");
            (
                AppUiAction::NavigateSection {
                    section: "workbench".into(),
                    workbench_tab: Some(tab),
                },
                AppActionCardKind::Navigation,
                title,
                None,
            )
        }
        "settings" => {
            let settings_section = args.settings_section.unwrap_or_else(|| "general".into());
            validate_allowed(
                &settings_section,
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
                "settingsSection",
            )?;
            let title = format!("Open settings/{settings_section}");
            (
                AppUiAction::NavigateSettings { settings_section },
                AppActionCardKind::Navigation,
                title,
                None,
            )
        }
        "terminal" => {
            let terminal_session_id = args
                .terminal_session_id
                .ok_or("app_navigate target 'terminal' requires 'terminalSessionId'")?;
            super::session::validate_identifier(&terminal_session_id, "terminalSessionId")?;
            let subtitle = inspector
                .and_then(|i| i.list_terminals().ok())
                .and_then(|list| {
                    list.into_iter()
                        .find(|item| item.session_id == terminal_session_id)
                        .map(|item| item.title)
                });
            (
                AppUiAction::FocusTerminal {
                    terminal_session_id: terminal_session_id.clone(),
                },
                AppActionCardKind::Terminal,
                "Focus terminal".into(),
                subtitle.or(Some(terminal_session_id)),
            )
        }
        "sftpPath" => {
            let profile_id = args
                .profile_id
                .ok_or("app_navigate target 'sftpPath' requires 'profileId'")?;
            super::session::validate_identifier(&profile_id, "profileId")?;
            let path = args
                .path
                .ok_or("app_navigate target 'sftpPath' requires 'path'")?;
            if path.trim().is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
                return Err("Invalid SFTP path".into());
            }
            let side = args.side.unwrap_or_else(|| "remote".into());
            validate_allowed(&side, &["remote", "local"], "side")?;
            let profile_name = inspector
                .and_then(|i| i.list_profiles().ok())
                .and_then(|list| {
                    list.into_iter()
                        .find(|item| item.id == profile_id)
                        .map(|item| item.name)
                });
            (
                AppUiAction::OpenSftpPath {
                    profile_id: profile_id.clone(),
                    path: path.clone(),
                    side: Some(side),
                },
                AppActionCardKind::SftpPath,
                format!("Open SFTP {}", profile_name.unwrap_or(profile_id)),
                Some(path),
            )
        }
        "hostTool" => {
            let profile_id = args
                .profile_id
                .ok_or("app_navigate target 'hostTool' requires 'profileId'")?;
            super::session::validate_identifier(&profile_id, "profileId")?;
            let tool = args
                .host_tool
                .ok_or("app_navigate target 'hostTool' requires 'hostTool'")?;
            validate_allowed(
                &tool,
                &["overview", "quickActions", "portForward"],
                "hostTool",
            )?;
            (
                AppUiAction::OpenHostTool {
                    profile_id: profile_id.clone(),
                    tool: tool.clone(),
                },
                AppActionCardKind::HostTool,
                format!("Open host tool ({tool})"),
                Some(profile_id),
            )
        }
        "agentSession" => {
            let agent_session_id = args
                .agent_session_id
                .ok_or("app_navigate target 'agentSession' requires 'agentSessionId'")?;
            super::session::validate_identifier(&agent_session_id, "agentSessionId")?;
            (
                AppUiAction::OpenAgentSession {
                    agent_session_id: agent_session_id.clone(),
                },
                AppActionCardKind::AgentSession,
                "Open AI session".into(),
                Some(agent_session_id),
            )
        }
        other => return Err(format!("Unsupported app_navigate target: {other}")),
    };

    let action_id = format!("app-act-{}", Uuid::new_v4());
    let card_id = format!("app-card-{}", Uuid::new_v4());
    let summary = match &subtitle {
        Some(sub) => format!("Dispatched UI navigation: {title} ({sub})"),
        None => format!("Dispatched UI navigation: {title}"),
    };
    Ok(AppControlExecution {
        summary,
        data: json!({
            "actionId": action_id,
            "cardId": card_id,
            "cardKind": card_kind,
            "title": title,
            "subtitle": subtitle,
            "action": action,
        }),
        extra_payloads: vec![
            AgentSessionEventPayload::AppActionCard {
                card_id,
                call_id: call_id.into(),
                kind: card_kind,
                title,
                subtitle,
                action: action.clone(),
            },
            AgentSessionEventPayload::AppActionDispatched {
                action_id,
                call_id: call_id.into(),
                action,
                requires_focus: true,
            },
        ],
    })
}

fn execute_propose_action(
    call_id: &str,
    arguments: Value,
    inspector: Option<&dyn AppWorkspaceInspector>,
) -> Result<AppControlExecution, String> {
    let args: AppProposeActionArguments = serde_json::from_value(arguments)
        .map_err(|e| format!("Invalid app_propose_action arguments: {e}"))?;
    let summary = args.summary.trim().to_string();
    if summary.is_empty() || summary.len() > MAX_SUMMARY_BYTES {
        return Err("app_propose_action summary must be 1..=512 bytes".into());
    }
    ensure_secret_free("summary", &summary)?;

    let (normalized_draft, card_title, card_subtitle) = match args.kind {
        AppProposalKind::ConnectionProfile => {
            let mut draft: ConnectionProfileDraft =
                serde_json::from_value(args.draft).map_err(|e| {
                    format!(
                        "Invalid connectionProfile draft (credentials/secrets are forbidden): {e}"
                    )
                })?;
            draft.host = draft.host.trim().to_string();
            if draft.host.is_empty() || draft.host.len() > 255 {
                return Err("connectionProfile draft requires a valid host".into());
            }
            if let Some(port) = draft.port {
                if port == 0 {
                    return Err("connectionProfile draft port must be between 1 and 65535".into());
                }
            }
            if let Some(notes) = draft.notes.as_deref() {
                if notes.len() > MAX_NOTES_BYTES {
                    return Err("connectionProfile draft notes exceed 1024 bytes".into());
                }
                ensure_secret_free("notes", notes)?;
            }
            ensure_secret_free("host", &draft.host)?;
            if let Some(name) = draft.name.as_deref() {
                ensure_secret_free("name", name)?;
            }
            if let Some(username) = draft.username.as_deref() {
                ensure_secret_free("username", username)?;
            }
            if let Some(group) = draft.group.as_deref() {
                ensure_secret_free("group", group)?;
            }
            draft.tags = draft
                .tags
                .into_iter()
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty())
                .take(MAX_TAGS)
                .collect();
            for tag in &draft.tags {
                ensure_secret_free("tags", tag)?;
            }
            let display = draft.name.clone().unwrap_or_else(|| draft.host.clone());
            let subtitle = format!(
                "{}{}:{}",
                draft
                    .username
                    .as_deref()
                    .filter(|u| !u.trim().is_empty())
                    .map(|u| format!("{u}@"))
                    .unwrap_or_default(),
                draft.host,
                draft.port.unwrap_or(22)
            );
            let value = serde_json::to_value(&draft)
                .map_err(|e| format!("Failed to serialize connectionProfile draft: {e}"))?;
            (
                value,
                format!("Connection draft: {display}"),
                Some(subtitle),
            )
        }
        AppProposalKind::PortForward => {
            let mut draft: PortForwardDraft = serde_json::from_value(args.draft)
                .map_err(|e| format!("Invalid portForward draft: {e}"))?;
            super::session::validate_identifier(&draft.profile_id, "profileId")?;
            draft.name = draft.name.trim().to_string();
            if draft.name.is_empty() || draft.name.len() > 128 {
                return Err("portForward draft requires a non-empty name".into());
            }
            ensure_secret_free("name", &draft.name)?;
            validate_allowed(&draft.kind, &["local", "remote", "dynamic"], "kind")?;
            if draft.local_port == 0 {
                return Err("portForward draft localPort must be between 1 and 65535".into());
            }
            if draft.kind != "dynamic" {
                let remote_host = draft
                    .remote_host
                    .as_deref()
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .unwrap_or("127.0.0.1")
                    .to_string();
                ensure_secret_free("remoteHost", &remote_host)?;
                if draft.kind == "remote"
                    && !matches!(remote_host.as_str(), "127.0.0.1" | "localhost" | "::1")
                {
                    return Err(
                        "remote portForward draft remoteHost must be a loopback address (127.0.0.1, localhost, ::1)"
                            .into(),
                    );
                }
                let remote_port = draft
                    .remote_port
                    .filter(|&port| port > 0)
                    .ok_or("portForward draft requires remotePort between 1 and 65535")?;
                draft.remote_host = Some(remote_host);
                draft.remote_port = Some(remote_port);
            }
            if let Some(inspector) = inspector {
                if let Ok(profiles) = inspector.list_profiles() {
                    if !profiles.iter().any(|p| p.id == draft.profile_id) {
                        return Err(format!(
                            "Unknown profileId '{}' for portForward draft",
                            draft.profile_id
                        ));
                    }
                }
            }
            let subtitle = if draft.kind == "dynamic" {
                format!("SOCKS5 :{}", draft.local_port)
            } else {
                format!(
                    "{} :{} -> {}:{}",
                    draft.kind,
                    draft.local_port,
                    draft.remote_host.as_deref().unwrap_or("127.0.0.1"),
                    draft.remote_port.unwrap_or(0)
                )
            };
            let title = format!("Port-forward draft: {}", draft.name);
            let value = serde_json::to_value(&draft)
                .map_err(|e| format!("Failed to serialize portForward draft: {e}"))?;
            (value, title, Some(subtitle))
        }
    };

    let proposal_id = format!("app-prop-{}", Uuid::new_v4());
    let action_id = format!("app-act-{}", Uuid::new_v4());
    let card_id = format!("app-card-{}", Uuid::new_v4());
    let action = AppUiAction::OpenProposalDraft {
        proposal_id: proposal_id.clone(),
        kind: args.kind,
        draft: normalized_draft.clone(),
    };

    Ok(AppControlExecution {
        summary: format!(
            "Prepared draft for explicit user review and opened the confirmation form: {summary}"
        ),
        data: json!({
            "proposalId": proposal_id,
            "actionId": action_id,
            "cardId": card_id,
            "kind": args.kind,
            "summary": summary,
            "title": card_title,
            "subtitle": card_subtitle,
            "action": action,
        }),
        extra_payloads: vec![
            AgentSessionEventPayload::AppActionProposalRequested {
                proposal_id,
                call_id: call_id.into(),
                kind: args.kind,
                summary,
                draft: normalized_draft,
            },
            AgentSessionEventPayload::AppActionCard {
                card_id,
                call_id: call_id.into(),
                kind: AppActionCardKind::ProposalDraft,
                title: card_title,
                subtitle: card_subtitle,
                action: action.clone(),
            },
            AgentSessionEventPayload::AppActionDispatched {
                action_id,
                call_id: call_id.into(),
                action,
                requires_focus: true,
            },
        ],
    })
}

fn execute_terminal(
    call_id: &str,
    arguments: Value,
    inspector: Option<&dyn AppWorkspaceInspector>,
) -> Result<AppControlExecution, String> {
    let args: AppTerminalArguments = serde_json::from_value(arguments)
        .map_err(|e| format!("Invalid app_terminal arguments: {e}"))?;
    let explanation = args.explanation.trim().to_string();
    if explanation.is_empty() || explanation.len() > MAX_SUMMARY_BYTES {
        return Err("app_terminal explanation must be 1..=512 bytes".into());
    }
    ensure_secret_free("explanation", &explanation)?;

    let (action, title, subtitle) = match args.action.as_str() {
        "openProfile" => {
            let profile_id = args
                .profile_id
                .ok_or("app_terminal action 'openProfile' requires 'profileId'")?;
            super::session::validate_identifier(&profile_id, "profileId")?;
            let initial_directory = match args.initial_directory {
                Some(raw) => {
                    let trimmed = raw.trim().to_string();
                    if trimmed.is_empty()
                        || trimmed.len() > MAX_PATH_BYTES
                        || trimmed.contains('\0')
                    {
                        return Err("Invalid initialDirectory".into());
                    }
                    ensure_secret_free("initialDirectory", &trimmed)?;
                    Some(trimmed)
                }
                None => None,
            };
            let profile_label = if let Some(inspector) = inspector {
                let profiles = inspector.list_profiles()?;
                let found = profiles
                    .into_iter()
                    .find(|item| item.id == profile_id)
                    .ok_or_else(|| format!("Unknown profileId '{profile_id}'"))?;
                format!(
                    "{} ({}@{}:{})",
                    found.name, found.username, found.host, found.port
                )
            } else {
                profile_id.clone()
            };
            (
                AppUiAction::ConnectTerminalProfile {
                    profile_id,
                    initial_directory: initial_directory.clone(),
                },
                "Connect SSH terminal".into(),
                Some(profile_label),
            )
        }
        "openLocal" => (
            AppUiAction::OpenLocalTerminal,
            "Open local terminal".into(),
            Some(explanation.clone()),
        ),
        "focus" => {
            let terminal_session_id = args
                .terminal_session_id
                .ok_or("app_terminal action 'focus' requires 'terminalSessionId'")?;
            super::session::validate_identifier(&terminal_session_id, "terminalSessionId")?;
            let subtitle = inspector
                .and_then(|i| i.list_terminals().ok())
                .and_then(|list| {
                    list.into_iter()
                        .find(|item| item.session_id == terminal_session_id)
                        .map(|item| item.title)
                })
                .or_else(|| Some(terminal_session_id.clone()));
            (
                AppUiAction::FocusTerminal {
                    terminal_session_id,
                },
                "Focus terminal".into(),
                subtitle,
            )
        }
        other => return Err(format!("Unsupported app_terminal action: {other}")),
    };

    let action_id = format!("app-act-{}", Uuid::new_v4());
    let card_id = format!("app-card-{}", Uuid::new_v4());
    let summary = match &subtitle {
        Some(sub) => format!("Dispatched terminal action: {title} ({sub})"),
        None => format!("Dispatched terminal action: {title}"),
    };
    Ok(AppControlExecution {
        summary,
        data: json!({
            "actionId": action_id,
            "cardId": card_id,
            "cardKind": AppActionCardKind::Terminal,
            "title": title,
            "subtitle": subtitle,
            "action": action,
        }),
        extra_payloads: vec![
            AgentSessionEventPayload::AppActionCard {
                card_id,
                call_id: call_id.into(),
                kind: AppActionCardKind::Terminal,
                title,
                subtitle,
                action: action.clone(),
            },
            AgentSessionEventPayload::AppActionDispatched {
                action_id,
                call_id: call_id.into(),
                action,
                requires_focus: true,
            },
        ],
    })
}

fn execute_session(
    ctx: AppControlCallContext<'_>,
    arguments: Value,
) -> Result<AppControlExecution, String> {
    let args: AppSessionArguments = serde_json::from_value(arguments)
        .map_err(|e| format!("Invalid app_session arguments: {e}"))?;
    let explanation = args.explanation.trim().to_string();
    if explanation.is_empty() || explanation.len() > MAX_SUMMARY_BYTES {
        return Err("app_session explanation must be 1..=512 bytes".into());
    }
    ensure_secret_free("explanation", &explanation)?;

    match args.action.as_str() {
        "create" => {
            if ctx.sessions_created_in_turn >= MAX_APP_SESSIONS_PER_TURN {
                return Err(format!(
                    "APP_ACTION_RATE_LIMITED: at most {MAX_APP_SESSIONS_PER_TURN} independent AI sessions can be created per turn"
                ));
            }
            let title = match args.title {
                Some(raw) => {
                    let trimmed = raw.trim().to_string();
                    if trimmed.is_empty() || trimmed.len() > MAX_TITLE_BYTES {
                        return Err("app_session title must be 1..=120 bytes".into());
                    }
                    ensure_secret_free("title", &trimmed)?;
                    Some(trimmed)
                }
                None => None,
            };
            let prompt = match args.prompt {
                Some(raw) => {
                    let trimmed = raw.trim().to_string();
                    if trimmed.is_empty() || trimmed.len() > MAX_PROMPT_BYTES {
                        return Err("app_session prompt must be 1..=8192 bytes".into());
                    }
                    ensure_secret_free("prompt", &trimmed)?;
                    Some(trimmed)
                }
                None => None,
            };
            if let Some(profile_id) = args.profile_id.as_deref() {
                super::session::validate_identifier(profile_id, "profileId")?;
            }
            if let Some(terminal_id) = args.terminal_session_id.as_deref() {
                super::session::validate_identifier(terminal_id, "terminalSessionId")?;
            }
            let coordinator = ctx
                .coordinator
                .ok_or("APP_SESSION_UNAVAILABLE: session coordinator is not configured")?;
            let requested_auto_start = args.auto_start.unwrap_or(true);
            let requires_manual_start = requested_auto_start
                && ctx.permission_mode == AgentSessionPermissionMode::RequestApproval;
            let effective_auto_start = requested_auto_start && !requires_manual_start;
            let created = coordinator.create_root_session(
                ctx.session_id,
                AppCreateSessionRequest {
                    title,
                    prompt,
                    profile_id: args.profile_id,
                    terminal_session_id: args.terminal_session_id,
                    auto_start: effective_auto_start,
                },
            )?;
            let action = AppUiAction::OpenAgentSession {
                agent_session_id: created.session_id.clone(),
            };
            let card_id = format!("app-card-{}", Uuid::new_v4());
            let mut extra_payloads = vec![AgentSessionEventPayload::AppActionCard {
                card_id: card_id.clone(),
                call_id: ctx.call_id.into(),
                kind: AppActionCardKind::AgentSession,
                title: created.title.clone(),
                subtitle: created.target_label.clone(),
                action: action.clone(),
            }];
            let focus_new = args.focus_new_session.unwrap_or(false);
            let mut action_id = None;
            if focus_new {
                let id = format!("app-act-{}", Uuid::new_v4());
                extra_payloads.push(AgentSessionEventPayload::AppActionDispatched {
                    action_id: id.clone(),
                    call_id: ctx.call_id.into(),
                    action: action.clone(),
                    requires_focus: true,
                });
                action_id = Some(id);
            }
            let summary = if created.started {
                format!(
                    "Created and started independent AI session '{}' ({})",
                    created.title, created.session_id
                )
            } else if requires_manual_start && created.prompt_queued {
                format!(
                    "Created independent AI session '{}' ({}) with queued prompt awaiting user start (requestApproval mode)",
                    created.title, created.session_id
                )
            } else {
                format!(
                    "Created independent AI session '{}' ({})",
                    created.title, created.session_id
                )
            };
            Ok(AppControlExecution {
                summary,
                data: json!({
                    "sessionAction": "create",
                    "sessionId": created.session_id,
                    "title": created.title,
                    "started": created.started,
                    "promptQueued": created.prompt_queued,
                    "requiresManualStart": requires_manual_start,
                    "focused": focus_new,
                    "cardId": card_id,
                    "actionId": action_id,
                    "action": action,
                }),
                extra_payloads,
            })
        }
        "open" => {
            let target_session_id = args
                .target_session_id
                .ok_or("app_session action 'open' requires 'targetSessionId'")?;
            super::session::validate_identifier(&target_session_id, "targetSessionId")?;
            let action = AppUiAction::OpenAgentSession {
                agent_session_id: target_session_id.clone(),
            };
            let card_id = format!("app-card-{}", Uuid::new_v4());
            let action_id = format!("app-act-{}", Uuid::new_v4());
            Ok(AppControlExecution {
                summary: format!("Opened AI session {target_session_id}"),
                data: json!({
                    "sessionAction": "open",
                    "sessionId": target_session_id,
                    "cardId": card_id,
                    "actionId": action_id,
                    "action": action,
                }),
                extra_payloads: vec![
                    AgentSessionEventPayload::AppActionCard {
                        card_id,
                        call_id: ctx.call_id.into(),
                        kind: AppActionCardKind::AgentSession,
                        title: "Open AI session".into(),
                        subtitle: Some(target_session_id),
                        action: action.clone(),
                    },
                    AgentSessionEventPayload::AppActionDispatched {
                        action_id,
                        call_id: ctx.call_id.into(),
                        action,
                        requires_focus: true,
                    },
                ],
            })
        }
        "sendPrompt" => {
            if ctx.permission_mode == AgentSessionPermissionMode::RequestApproval {
                return Err(
                    "APP_ACTION_APPROVAL_REQUIRED: cross-session sendPrompt is disabled in requestApproval mode; open the target session for the user instead"
                        .into(),
                );
            }
            let target_session_id = args
                .target_session_id
                .ok_or("app_session action 'sendPrompt' requires 'targetSessionId'")?;
            super::session::validate_identifier(&target_session_id, "targetSessionId")?;
            if target_session_id == ctx.session_id {
                return Err(
                    "APP_ACTION_INVALID_TARGET: cannot sendPrompt to the current active session"
                        .into(),
                );
            }
            let prompt = args
                .prompt
                .ok_or("app_session action 'sendPrompt' requires 'prompt'")?
                .trim()
                .to_string();
            if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
                return Err("app_session prompt must be 1..=8192 bytes".into());
            }
            ensure_secret_free("prompt", &prompt)?;
            let coordinator = ctx
                .coordinator
                .ok_or("APP_SESSION_UNAVAILABLE: session coordinator is not configured")?;
            let outcome = coordinator.send_prompt_to_root_session(
                ctx.session_id,
                &target_session_id,
                prompt,
            )?;
            let action = AppUiAction::OpenAgentSession {
                agent_session_id: outcome.session_id.clone(),
            };
            let card_id = format!("app-card-{}", Uuid::new_v4());
            Ok(AppControlExecution {
                summary: format!(
                    "Queued prompt on AI session '{}' ({})",
                    outcome.title, outcome.session_id
                ),
                data: json!({
                    "sessionAction": "sendPrompt",
                    "sessionId": outcome.session_id,
                    "title": outcome.title,
                    "started": outcome.started,
                    "cardId": card_id,
                    "action": action,
                }),
                extra_payloads: vec![AgentSessionEventPayload::AppActionCard {
                    card_id,
                    call_id: ctx.call_id.into(),
                    kind: AppActionCardKind::AgentSession,
                    title: outcome.title,
                    subtitle: Some(outcome.session_id),
                    action,
                }],
            })
        }
        other => Err(format!("Unsupported app_session action: {other}")),
    }
}

pub(crate) fn validate_payload(event: &AgentSessionEvent) -> Result<(), String> {
    match &event.payload {
        AgentSessionEventPayload::AppActionDispatched {
            action_id, call_id, ..
        } => {
            super::session::validate_identifier(action_id, "actionId")?;
            super::session::validate_identifier(call_id, "callId")?;
            Ok(())
        }
        AgentSessionEventPayload::AppActionCard {
            card_id,
            call_id,
            title,
            ..
        } => {
            super::session::validate_identifier(card_id, "cardId")?;
            super::session::validate_identifier(call_id, "callId")?;
            if title.trim().is_empty() || title.len() > 256 {
                return Err("AppActionCard title must be 1..=256 bytes".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::AppActionProposalRequested {
            proposal_id,
            call_id,
            summary,
            draft,
            ..
        } => {
            super::session::validate_identifier(proposal_id, "proposalId")?;
            super::session::validate_identifier(call_id, "callId")?;
            if summary.trim().is_empty() || summary.len() > MAX_SUMMARY_BYTES {
                return Err("AppActionProposalRequested summary must be 1..=512 bytes".into());
            }
            if !draft.is_object() {
                return Err("AppActionProposalRequested draft must be a JSON object".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ProfileAuthMethod, ProfileRow};

    struct MockInspector {
        profiles: Vec<RedactedProfileSummary>,
        terminals: Vec<RedactedTerminalSummary>,
        forwards: Vec<RedactedPortForwardSummary>,
    }

    impl AppWorkspaceInspector for MockInspector {
        fn list_profiles(&self) -> Result<Vec<RedactedProfileSummary>, String> {
            Ok(self.profiles.clone())
        }
        fn list_terminals(&self) -> Result<Vec<RedactedTerminalSummary>, String> {
            Ok(self.terminals.clone())
        }
        fn list_port_forwards(&self) -> Result<Vec<RedactedPortForwardSummary>, String> {
            Ok(self.forwards.clone())
        }
    }

    #[test]
    fn redact_profile_row_omits_keychain_and_jump_secrets() {
        let row = ProfileRow {
            id: "prod-1".into(),
            name: "Production API".into(),
            host: "10.0.0.10".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: ProfileAuthMethod::Key,
            keychain_key_id: Some("secret-keychain-id".into()),
            jump_host_config: Some(r#"{"host":"bastion","password":"super-secret"}"#.into()),
            organization_json: Some(
                r#"{"group":"prod","tags":["api","blue"],"favorite":true,"portForwards":[{"id":"pf-1"}]}"#
                    .into(),
            ),
            created_at: 1,
            updated_at: 2,
        };
        let summary = redact_profile_row(row);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(!serialized.contains("secret-keychain-id"));
        assert!(!serialized.contains("super-secret"));
        assert!(summary.has_jump_host);
        assert_eq!(summary.group.as_deref(), Some("prod"));
        assert_eq!(summary.tags, vec!["api", "blue"]);
        assert_eq!(summary.port_forward_count, 1);
    }

    struct MockCoordinator;

    impl AppSessionCoordinator for MockCoordinator {
        fn create_root_session(
            &self,
            _origin_session_id: &str,
            request: AppCreateSessionRequest,
        ) -> Result<AppCreatedSessionOutcome, String> {
            Ok(AppCreatedSessionOutcome {
                session_id: "session-created-1".into(),
                title: request.title.unwrap_or_else(|| "Investigate DB".into()),
                started: request.auto_start && request.prompt.is_some(),
                prompt_queued: request.prompt.is_some(),
                target_label: request.profile_id,
            })
        }

        fn send_prompt_to_root_session(
            &self,
            _origin_session_id: &str,
            target_session_id: &str,
            _prompt: String,
        ) -> Result<AppSentPromptOutcome, String> {
            Ok(AppSentPromptOutcome {
                session_id: target_session_id.into(),
                title: "Existing session".into(),
                started: true,
            })
        }
    }

    fn call_ctx<'a>(
        store: &'a AgentSessionStore,
        is_subagent: bool,
        call_id: &'a str,
        sessions_created_in_turn: usize,
        inspector: Option<&'a dyn AppWorkspaceInspector>,
        coordinator: Option<&'a dyn AppSessionCoordinator>,
    ) -> AppControlCallContext<'a> {
        AppControlCallContext {
            session_id: "session-origin",
            is_subagent,
            permission_mode: AgentSessionPermissionMode::ScopedAutopilot,
            call_id,
            sessions_created_in_turn,
            sessions: store,
            inspector,
            coordinator,
        }
    }

    #[test]
    fn subagent_cannot_call_root_only_app_tools() {
        let store = AgentSessionStore::default();
        let nav_err = execute_app_control_tool(
            call_ctx(&store, true, "call-1", 0, None, None),
            APP_NAVIGATE_TOOL,
            json!({ "target": "workbenchTab", "workbenchTab": "logs" }),
        )
        .err()
        .expect("subagent navigation must fail");
        assert!(nav_err.contains("APP_ACTION_ROOT_ONLY"));

        let prop_err = execute_app_control_tool(
            call_ctx(&store, true, "call-2", 0, None, None),
            APP_PROPOSE_ACTION_TOOL,
            json!({
                "kind": "connectionProfile",
                "summary": "Add host",
                "draft": { "host": "10.0.0.5" }
            }),
        )
        .err()
        .expect("subagent proposal must fail");
        assert!(prop_err.contains("APP_ACTION_ROOT_ONLY"));

        let term_err = execute_app_control_tool(
            call_ctx(&store, true, "call-3", 0, None, None),
            APP_TERMINAL_TOOL,
            json!({ "action": "openLocal", "explanation": "Open local shell" }),
        )
        .err()
        .expect("subagent terminal open must fail");
        assert!(term_err.contains("APP_ACTION_ROOT_ONLY"));

        let sess_err = execute_app_control_tool(
            call_ctx(&store, true, "call-4", 0, None, Some(&MockCoordinator)),
            APP_SESSION_TOOL,
            json!({ "action": "create", "explanation": "Spawn separate session" }),
        )
        .err()
        .expect("subagent session create must fail");
        assert!(sess_err.contains("APP_ACTION_ROOT_ONLY"));
    }

    #[test]
    fn propose_action_rejects_embedded_secrets_and_unknown_credential_fields() {
        let store = AgentSessionStore::default();

        let unknown_field = execute_app_control_tool(
            call_ctx(&store, false, "call-1", 0, None, None),
            APP_PROPOSE_ACTION_TOOL,
            json!({
                "kind": "connectionProfile",
                "summary": "Add prod host",
                "draft": { "host": "10.0.0.5", "password": "raw-password" }
            }),
        )
        .err()
        .expect("password field must be rejected");
        assert!(unknown_field.contains("unknown field"));

        let leaked_token = execute_app_control_tool(
            call_ctx(&store, false, "call-2", 0, None, None),
            APP_PROPOSE_ACTION_TOOL,
            json!({
                "kind": "connectionProfile",
                "summary": "Add prod host",
                "draft": {
                    "host": "10.0.0.5",
                    "notes": "Authorization: Bearer sk-1234567890abcdef1234567890"
                }
            }),
        )
        .err()
        .expect("embedded bearer token must be rejected");
        assert!(leaked_token.contains("APP_ACTION_REDACTION_REQUIRED"));
    }

    #[test]
    fn navigate_and_propose_produce_valid_event_v5_payloads() {
        let store = AgentSessionStore::default();
        let inspector = MockInspector {
            profiles: vec![RedactedProfileSummary {
                id: "p1".into(),
                name: "Prod Web".into(),
                host: "10.0.1.5".into(),
                port: 22,
                username: "ops".into(),
                auth_method: "key".into(),
                has_jump_host: false,
                group: Some("prod".into()),
                tags: vec!["web".into()],
                favorite: true,
                port_forward_count: 1,
            }],
            terminals: vec![],
            forwards: vec![],
        };

        let nav = execute_app_control_tool(
            call_ctx(&store, false, "call-nav", 0, Some(&inspector), None),
            APP_NAVIGATE_TOOL,
            json!({ "target": "sftpPath", "profileId": "p1", "path": "/var/log/nginx" }),
        )
        .expect("navigation succeeds");
        assert_eq!(nav.extra_payloads.len(), 2);

        let prop = execute_app_control_tool(
            call_ctx(&store, false, "call-prop", 0, Some(&inspector), None),
            APP_PROPOSE_ACTION_TOOL,
            json!({
                "kind": "portForward",
                "summary": "Forward local 8080 to nginx",
                "draft": {
                    "profileId": "p1",
                    "name": "Nginx Local",
                    "kind": "local",
                    "localPort": 8080,
                    "remoteHost": "127.0.0.1",
                    "remotePort": 80,
                    "autoStart": false
                }
            }),
        )
        .expect("proposal succeeds");
        assert_eq!(prop.extra_payloads.len(), 3);
        for payload in nav.extra_payloads.into_iter().chain(prop.extra_payloads) {
            let event = AgentSessionEvent::new("s1".into(), 1, 1000, None, None, payload);
            validate_payload(&event).expect("event payload validates");
        }
    }

    #[test]
    fn app_terminal_validates_profile_and_dispatches_standard_connect_flow() {
        let store = AgentSessionStore::default();
        let inspector = MockInspector {
            profiles: vec![RedactedProfileSummary {
                id: "p1".into(),
                name: "Prod API".into(),
                host: "10.0.1.5".into(),
                port: 22,
                username: "ops".into(),
                auth_method: "key".into(),
                has_jump_host: false,
                group: None,
                tags: vec![],
                favorite: false,
                port_forward_count: 0,
            }],
            terminals: vec![],
            forwards: vec![],
        };

        let missing = execute_app_control_tool(
            call_ctx(&store, false, "call-t0", 0, Some(&inspector), None),
            APP_TERMINAL_TOOL,
            json!({
                "action": "openProfile",
                "profileId": "does-not-exist",
                "explanation": "Connect missing host"
            }),
        )
        .err()
        .expect("unknown profile must fail");
        assert!(missing.contains("Unknown profileId"));

        let opened = execute_app_control_tool(
            call_ctx(&store, false, "call-t1", 0, Some(&inspector), None),
            APP_TERMINAL_TOOL,
            json!({
                "action": "openProfile",
                "profileId": "p1",
                "initialDirectory": "/var/log/nginx",
                "explanation": "Open prod terminal"
            }),
        )
        .expect("openProfile succeeds");
        assert_eq!(opened.extra_payloads.len(), 2);
        assert!(matches!(
            &opened.extra_payloads[1],
            AgentSessionEventPayload::AppActionDispatched {
                action: AppUiAction::ConnectTerminalProfile { profile_id, initial_directory },
                ..
            } if profile_id == "p1" && initial_directory.as_deref() == Some("/var/log/nginx")
        ));
    }

    #[test]
    fn app_session_respects_stay_in_view_default_rate_limit_and_self_target_guard() {
        let store = AgentSessionStore::default();
        let coordinator = MockCoordinator;

        // Default focusNewSession=false emits only a durable card without stealing focus.
        let created_card_only = execute_app_control_tool(
            call_ctx(&store, false, "call-s1", 0, None, Some(&coordinator)),
            APP_SESSION_TOOL,
            json!({
                "action": "create",
                "title": "DB slow query triage",
                "prompt": "Check slow query log",
                "explanation": "Start parallel root session"
            }),
        )
        .expect("create succeeds");
        assert_eq!(created_card_only.extra_payloads.len(), 1);
        assert!(matches!(
            &created_card_only.extra_payloads[0],
            AgentSessionEventPayload::AppActionCard {
                kind: AppActionCardKind::AgentSession,
                ..
            }
        ));

        // Explicit focusNewSession=true also dispatches OpenAgentSession.
        let created_focused = execute_app_control_tool(
            call_ctx(&store, false, "call-s2", 1, None, Some(&coordinator)),
            APP_SESSION_TOOL,
            json!({
                "action": "create",
                "title": "Switch immediately",
                "focusNewSession": true,
                "explanation": "Create and switch"
            }),
        )
        .expect("create focused succeeds");
        assert_eq!(created_focused.extra_payloads.len(), 2);

        // Rate limit at MAX_APP_SESSIONS_PER_TURN.
        let limited = execute_app_control_tool(
            call_ctx(
                &store,
                false,
                "call-s3",
                MAX_APP_SESSIONS_PER_TURN,
                None,
                Some(&coordinator),
            ),
            APP_SESSION_TOOL,
            json!({
                "action": "create",
                "explanation": "Exceed turn limit"
            }),
        )
        .err()
        .expect("rate limit must trigger");
        assert!(limited.contains("APP_ACTION_RATE_LIMITED"));

        // Self-target sendPrompt is forbidden.
        let self_send = execute_app_control_tool(
            call_ctx(&store, false, "call-s4", 0, None, Some(&coordinator)),
            APP_SESSION_TOOL,
            json!({
                "action": "sendPrompt",
                "targetSessionId": "session-origin",
                "prompt": "Loop forever",
                "explanation": "Self send"
            }),
        )
        .err()
        .expect("self sendPrompt must fail");
        assert!(self_send.contains("APP_ACTION_INVALID_TARGET"));
    }

    #[test]
    fn request_approval_mode_blocks_silent_autostart_and_cross_session_send_prompt() {
        let store = AgentSessionStore::default();
        let coordinator = MockCoordinator;
        let approval_ctx = |call_id| AppControlCallContext {
            session_id: "session-origin",
            is_subagent: false,
            permission_mode: AgentSessionPermissionMode::RequestApproval,
            call_id,
            sessions_created_in_turn: 0,
            sessions: &store,
            inspector: None,
            coordinator: Some(&coordinator),
        };

        let created = execute_app_control_tool(
            approval_ctx("call-req-1"),
            APP_SESSION_TOOL,
            json!({
                "action": "create",
                "title": "Audit host",
                "prompt": "Check syslog",
                "autoStart": true,
                "explanation": "Create session under requestApproval"
            }),
        )
        .expect("create succeeds in gated manual-start mode");
        assert_eq!(created.data["started"], json!(false));
        assert_eq!(created.data["requiresManualStart"], json!(true));
        assert_eq!(created.data["promptQueued"], json!(true));

        let send_err = execute_app_control_tool(
            approval_ctx("call-req-2"),
            APP_SESSION_TOOL,
            json!({
                "action": "sendPrompt",
                "targetSessionId": "session-other",
                "prompt": "Run diagnostics",
                "explanation": "Send prompt across sessions"
            }),
        )
        .err()
        .expect("sendPrompt must be blocked in requestApproval mode");
        assert!(send_err.contains("APP_ACTION_APPROVAL_REQUIRED"));
    }
}
