//! Durable human-in-the-loop Skill creation and update proposals.
//! Models never receive general write access to `~/.shellspan`; all writes pass
//! through explicit user confirmation, strict name/path validation, redaction,
//! and atomic file replacement.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::skills::{
    digest, parse_skill, render_skill_markdown, unchanged_by_redaction, valid_name,
    SkillDiagnostic, SkillOrigin, MAX_SKILL_FILE,
};
use super::{AgentSessionEvent, AgentSessionEventPayload, AgentSessionHeader};

pub(crate) const TOOL_NAME: &str = "propose_skill";
const MAX_PROPOSAL_BYTES: usize = 160 * 1024;
const MAX_REVISION_NOTE_BYTES: usize = 2048;

pub(crate) fn is_proposal_tool(name: &str) -> bool {
    name == TOOL_NAME
}

pub(crate) fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["mode", "name", "description", "instructions"],
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["create", "update"]
            },
            "scope": {
                "type": "string",
                "enum": ["user", "workspace"],
                "default": "user"
            },
            "name": {
                "type": "string",
                "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
                "maxLength": 64
            },
            "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
            },
            "instructions": {
                "type": "string",
                "minLength": 1,
                "maxLength": 120000
            },
            "userInvocable": {
                "type": "boolean",
                "default": true
            },
            "disableModelInvocation": {
                "type": "boolean",
                "default": false
            },
            "summary": {
                "type": "string",
                "maxLength": 1000
            }
        }
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillProposalMode {
    Create,
    Update,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillProposalScope {
    User,
    Workspace,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SkillProposalAction {
    Save,
    RequestRevision,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillProposalIdentity {
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) step_id: String,
    pub(crate) request_id: String,
    pub(crate) call_id: String,
    pub(crate) proposal_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillProposalIssue {
    pub(crate) code: String,
    pub(crate) field: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedSkillProposal {
    pub(crate) mode: SkillProposalMode,
    pub(crate) scope: SkillProposalScope,
    pub(crate) workspace_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) scope_downgrade_reason: Option<String>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) instructions: String,
    pub(crate) user_invocable: bool,
    pub(crate) disable_model_invocation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) existing_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) existing_file_hash: Option<String>,
    pub(crate) overwrites_builtin: bool,
    pub(crate) shadowed_by_workspace: bool,
    #[serde(default)]
    pub(crate) validation_issues: Vec<SkillProposalIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedSkillMetadata {
    pub(crate) scope: SkillProposalScope,
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) file_hash: String,
    pub(crate) edited_by_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillProposalResolution {
    pub(crate) identity: SkillProposalIdentity,
    pub(crate) client_operation_id: String,
    pub(crate) action: SkillProposalAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) saved: Option<SavedSkillMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolveSkillProposalInput {
    pub(crate) identity: SkillProposalIdentity,
    pub(crate) client_operation_id: String,
    pub(crate) action: SkillProposalAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<SkillProposalScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) user_invocable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) disable_model_invocation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) expected_base_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectSkillTargetInput {
    pub(crate) session_id: String,
    pub(crate) scope: SkillProposalScope,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTargetInspection {
    pub(crate) scope: SkillProposalScope,
    pub(crate) workspace_allowed: bool,
    pub(crate) exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) existing_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) existing_file_hash: Option<String>,
    pub(crate) overwrites_builtin: bool,
    pub(crate) shadowed_by_workspace: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedSkillItem {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) instructions: String,
    pub(crate) origin: SkillOrigin,
    pub(crate) relative_path: String,
    pub(crate) file_hash: String,
    pub(crate) user_invocable: bool,
    pub(crate) disable_model_invocation: bool,
    pub(crate) overrides_builtin: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedSkillCatalog {
    pub(crate) user_skills_dir: String,
    pub(crate) user_skills_dir_exists: bool,
    pub(crate) skills: Vec<ManagedSkillItem>,
    pub(crate) diagnostics: Vec<SkillDiagnostic>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveUserSkillInput {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) instructions: String,
    #[serde(default = "default_true")]
    pub(crate) user_invocable: bool,
    #[serde(default)]
    pub(crate) disable_model_invocation: bool,
    #[serde(default)]
    pub(crate) expected_base_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteUserSkillInput {
    pub(crate) name: String,
    pub(crate) expected_file_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProposalArgs {
    mode: SkillProposalMode,
    #[serde(default = "default_scope")]
    scope: SkillProposalScope,
    name: String,
    description: String,
    instructions: String,
    #[serde(default = "default_true")]
    user_invocable: bool,
    #[serde(default)]
    disable_model_invocation: bool,
    #[serde(default)]
    summary: Option<String>,
}

fn default_scope() -> SkillProposalScope {
    SkillProposalScope::User
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
pub(crate) struct SkillProposalRecord {
    pub(crate) identity: SkillProposalIdentity,
    pub(crate) proposal: PreparedSkillProposal,
    pub(crate) provider: super::AgentSubagentModel,
    pub(crate) resolution: Option<SkillProposalResolution>,
    pub(crate) cancelled: bool,
    pub(crate) has_result: bool,
    pub(crate) fingerprint: Option<String>,
}

impl SkillProposalRecord {
    pub(crate) fn waiting(&self) -> bool {
        !self.cancelled && !self.has_result && self.resolution.is_none()
    }
}

fn non_empty_id(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 128 {
        return Err(format!("{label} is empty or exceeds 128 bytes"));
    }
    Ok(())
}

impl SkillProposalIdentity {
    pub(crate) fn validate(&self) -> Result<(), String> {
        non_empty_id(&self.session_id, "sessionId")?;
        non_empty_id(&self.turn_id, "turnId")?;
        non_empty_id(&self.step_id, "stepId")?;
        non_empty_id(&self.request_id, "requestId")?;
        non_empty_id(&self.call_id, "callId")?;
        non_empty_id(&self.proposal_id, "proposalId")?;
        Ok(())
    }
}

impl ResolveSkillProposalInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.identity.validate()?;
        non_empty_id(&self.client_operation_id, "clientOperationId")?;
        if let Some(note) = &self.note {
            if note.len() > MAX_REVISION_NOTE_BYTES {
                return Err("revision note exceeds 2048 bytes".into());
            }
        }
        if self.action == SkillProposalAction::RequestRevision {
            let note = self
                .note
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("revision note is required")?;
            if crate::redaction::redact_json_value(&Value::String(note.into()))
                != Value::String(note.into())
            {
                return Err("revision note requires redaction; use non-sensitive feedback".into());
            }
        }
        Ok(())
    }
}

pub(crate) fn input_fingerprint(input: &ResolveSkillProposalInput) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(input).map_err(|e| e.to_string())?,
    )))
}

pub(crate) fn is_same_submission(
    record: &SkillProposalRecord,
    input: &ResolveSkillProposalInput,
) -> Result<bool, String> {
    let fp = input_fingerprint(input)?;
    Ok(record
        .resolution
        .as_ref()
        .is_some_and(|res| res.client_operation_id == input.client_operation_id)
        && record.fingerprint.as_deref() == Some(&fp))
}

fn local_workspace_root(header: &AgentSessionHeader) -> Option<PathBuf> {
    let target = header.target.as_ref()?;
    if target.kind != "local" {
        return None;
    }
    let cwd = target.cwd.as_deref()?.trim();
    if cwd.is_empty() {
        return None;
    }
    Some(PathBuf::from(cwd))
}

fn ensure_no_symlink_components(base: &Path, relative_parts: &[&str]) -> Result<(), String> {
    if fs::symlink_metadata(base).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("target skills root must not be a symlink".into());
    }
    let mut current = base.to_path_buf();
    for part in relative_parts {
        if *part == "." || *part == ".." || part.contains('/') || part.contains('\\') {
            return Err("invalid skill path component".into());
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("symlink components are not permitted in skill paths".into());
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("failed to inspect skill path: {err}")),
        }
    }
    Ok(())
}

fn ensure_path_inside_root(root: &Path, candidate: &Path) -> Result<(), String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|err| format!("failed to canonicalize skills root: {err}"))?;
    let canonical_candidate = fs::canonicalize(candidate)
        .map_err(|err| format!("failed to canonicalize skill directory: {err}"))?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("skill path escapes allowed root".into());
    }
    Ok(())
}

struct ExistingSkillFile {
    is_flat: bool,
    content: String,
    hash: String,
}

fn read_existing_skill_at(base: &Path, name: &str) -> Result<Option<ExistingSkillFile>, String> {
    if !valid_name(name) || !base.exists() {
        return Ok(None);
    }
    let flat_name = format!("{name}.md");
    ensure_no_symlink_components(base, &[&flat_name])?;
    let flat_file = base.join(&flat_name);
    if flat_file.is_file() {
        let bytes =
            fs::read(&flat_file).map_err(|e| format!("failed to read existing skill: {e}"))?;
        if bytes.len() > MAX_SKILL_FILE {
            return Err("existing skill exceeds byte limit".into());
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| "existing skill is not valid UTF-8".to_string())?;
        let hash = digest(content.as_bytes());
        return Ok(Some(ExistingSkillFile {
            is_flat: true,
            content,
            hash,
        }));
    }
    ensure_no_symlink_components(base, &[name, "SKILL.md"])?;
    let dir_file = base.join(name).join("SKILL.md");
    if dir_file.is_file() {
        let bytes =
            fs::read(&dir_file).map_err(|e| format!("failed to read existing skill: {e}"))?;
        if bytes.len() > MAX_SKILL_FILE {
            return Err("existing skill exceeds byte limit".into());
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| "existing skill is not valid UTF-8".to_string())?;
        let hash = digest(content.as_bytes());
        return Ok(Some(ExistingSkillFile {
            is_flat: false,
            content,
            hash,
        }));
    }
    Ok(None)
}

pub(crate) fn inspect_target(
    header: &AgentSessionHeader,
    user_skills_dir: Option<&Path>,
    scope: SkillProposalScope,
    name: &str,
) -> Result<SkillTargetInspection, String> {
    if !valid_name(name) {
        return Err("invalid Skill name".into());
    }
    let workspace_root = local_workspace_root(header);
    let workspace_allowed = workspace_root.is_some();
    let effective_scope = if scope == SkillProposalScope::Workspace && !workspace_allowed {
        SkillProposalScope::User
    } else {
        scope
    };
    let workspace_skills_dir = workspace_root
        .as_ref()
        .map(|root| root.join(".agents").join("skills"));
    let target_dir = match effective_scope {
        SkillProposalScope::User => user_skills_dir.map(Path::to_path_buf),
        SkillProposalScope::Workspace => workspace_skills_dir.clone(),
    };
    let existing = match target_dir.as_deref() {
        Some(dir) => read_existing_skill_at(dir, name)?,
        None => None,
    };
    let overwrites_builtin = super::builtin_skills::definitions()
        .iter()
        .any(|d| d.entry.name == name);
    let shadowed_by_workspace = effective_scope == SkillProposalScope::User
        && workspace_skills_dir
            .as_deref()
            .and_then(|dir| read_existing_skill_at(dir, name).ok().flatten())
            .is_some();
    Ok(SkillTargetInspection {
        scope: effective_scope,
        workspace_allowed,
        exists: existing.is_some(),
        existing_content: existing.as_ref().map(|item| item.content.clone()),
        existing_file_hash: existing.map(|item| item.hash),
        overwrites_builtin,
        shadowed_by_workspace,
    })
}

pub(crate) fn validate_draft(
    name: &str,
    description: &str,
    instructions: &str,
    user_invocable: bool,
    disable_model_invocation: bool,
) -> (Option<String>, Vec<SkillProposalIssue>) {
    let mut issues = Vec::new();
    if !valid_name(name) {
        issues.push(SkillProposalIssue {
            code: "invalidName".into(),
            field: "name".into(),
            message: "Skill name must use lowercase ASCII letters, digits, and single hyphens (max 64 chars).".into(),
        });
    }
    let trimmed_desc = description.trim();
    if trimmed_desc.is_empty() {
        issues.push(SkillProposalIssue {
            code: "emptyDescription".into(),
            field: "description".into(),
            message: "Description must not be empty.".into(),
        });
    } else if trimmed_desc.chars().count() > 500 {
        issues.push(SkillProposalIssue {
            code: "descriptionTooLong".into(),
            field: "description".into(),
            message: "Description must be at most 500 characters.".into(),
        });
    }
    if instructions.trim().is_empty() {
        issues.push(SkillProposalIssue {
            code: "emptyInstructions".into(),
            field: "instructions".into(),
            message: "Instructions must not be empty.".into(),
        });
    }
    if unchanged_by_redaction(&description).is_err() {
        issues.push(SkillProposalIssue {
            code: "redactionRequired".into(),
            field: "description".into(),
            message:
                "Description contains sensitive material that requires redaction before saving."
                    .into(),
        });
    }
    if unchanged_by_redaction(&instructions).is_err() {
        issues.push(SkillProposalIssue {
            code: "redactionRequired".into(),
            field: "instructions".into(),
            message: "Instructions contain sensitive material (credentials, keys, or tokens) that must be removed before saving.".into(),
        });
    }
    if !issues.is_empty() {
        return (None, issues);
    }
    match render_skill_markdown(
        name,
        description,
        instructions,
        user_invocable,
        disable_model_invocation,
    ) {
        Ok(rendered) => {
            if unchanged_by_redaction(&rendered).is_err() {
                issues.push(SkillProposalIssue {
                    code: "redactionRequired".into(),
                    field: "instructions".into(),
                    message: "Rendered Skill content requires redaction before saving.".into(),
                });
                (None, issues)
            } else {
                (Some(rendered), issues)
            }
        }
        Err(message) => {
            issues.push(SkillProposalIssue {
                code: "invalidSkill".into(),
                field: "instructions".into(),
                message,
            });
            (None, issues)
        }
    }
}

fn commit_skill_file_at(
    base_dir: &Path,
    guard_root: &Path,
    relative_prefix: &str,
    name: &str,
    rendered: &str,
    expected_base_hash: Option<&str>,
    conflict_missing_expected_msg: &str,
) -> Result<(String, String), String> {
    let existing = read_existing_skill_at(base_dir, name)?;
    match (&existing, expected_base_hash) {
        (Some(item), Some(expected)) if item.hash != expected => {
            return Err(
                "SKILL_CONFLICT: the target skill changed on disk; refresh the preview before saving"
                    .into(),
            );
        }
        (Some(_), None) => {
            return Err(conflict_missing_expected_msg.into());
        }
        _ => {}
    }

    let write_flat = existing.as_ref().is_some_and(|item| item.is_flat);
    let (target_dir, target_file, temp_name, relative_path) = if write_flat {
        let flat_name = format!("{name}.md");
        ensure_no_symlink_components(base_dir, &[&flat_name])?;
        ensure_path_inside_root(guard_root, base_dir)?;
        (
            base_dir.to_path_buf(),
            base_dir.join(&flat_name),
            format!(".{flat_name}.{}.tmp", uuid::Uuid::new_v4().simple()),
            format!("{relative_prefix}/{flat_name}"),
        )
    } else {
        ensure_no_symlink_components(base_dir, &[name, "SKILL.md"])?;
        let skill_dir = base_dir.join(name);
        fs::create_dir_all(&skill_dir)
            .map_err(|e| format!("failed to create skill directory: {e}"))?;
        ensure_path_inside_root(guard_root, &skill_dir)?;
        ensure_no_symlink_components(&skill_dir, &["SKILL.md"])?;
        (
            skill_dir.clone(),
            skill_dir.join("SKILL.md"),
            format!(".SKILL.md.{}.tmp", uuid::Uuid::new_v4().simple()),
            format!("{relative_prefix}/{name}/SKILL.md"),
        )
    };

    let temp_file = target_dir.join(temp_name);
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_file)
            .map_err(|e| format!("failed to create temp skill file: {e}"))?;
        file.write_all(rendered.as_bytes())
            .map_err(|e| format!("failed to write temp skill file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("failed to sync temp skill file: {e}"))?;
        drop(file);
        fs::rename(&temp_file, &target_file)
            .map_err(|e| format!("failed to commit skill file: {e}"))?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_file);
        return Err(err);
    }
    Ok((relative_path, digest(rendered.as_bytes())))
}

fn write_skill_file(
    header: &AgentSessionHeader,
    user_skills_dir: Option<&Path>,
    scope: SkillProposalScope,
    name: &str,
    rendered: &str,
    expected_base_hash: Option<&str>,
) -> Result<(String, String), String> {
    if !valid_name(name) {
        return Err("invalid Skill name".into());
    }
    if rendered.len() > MAX_SKILL_FILE {
        return Err("Skill file exceeds byte limit".into());
    }
    let _ = parse_skill(&format!("{name}/SKILL.md"), rendered.as_bytes())?;
    unchanged_by_redaction(&rendered).map_err(|_| {
        "SKILL_REDACTION_REQUIRED: remove credentials or secrets before saving".to_string()
    })?;

    let (base_dir, guard_root, relative_prefix) = match scope {
        SkillProposalScope::User => {
            let dir = user_skills_dir
                .ok_or("User skills directory is not configured")?
                .to_path_buf();
            fs::create_dir_all(&dir)
                .map_err(|e| format!("failed to prepare user skills directory: {e}"))?;
            (dir.clone(), dir, "user")
        }
        SkillProposalScope::Workspace => {
            let workspace_root = local_workspace_root(header)
                .ok_or("workspace scope is only supported for bound local workspaces")?;
            if workspace_root
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            {
                return Err("invalid workspace root".into());
            }
            ensure_no_symlink_components(&workspace_root, &[".agents", "skills"])?;
            let dir = workspace_root.join(".agents").join("skills");
            fs::create_dir_all(&dir)
                .map_err(|e| format!("failed to prepare workspace skills directory: {e}"))?;
            ensure_path_inside_root(&workspace_root, &dir)?;
            (dir, workspace_root, ".agents/skills")
        }
    };

    commit_skill_file_at(
        &base_dir,
        &guard_root,
        relative_prefix,
        name,
        rendered,
        expected_base_hash,
        "SKILL_CONFLICT: a skill with this name already exists on disk; review its diff before overwriting",
    )
}

pub(crate) fn list_managed_skills(
    user_skills_dir: Option<&Path>,
) -> Result<ManagedSkillCatalog, String> {
    let dir = user_skills_dir.ok_or("User skills directory is not configured")?;
    let cancellation = tokio_util::sync::CancellationToken::new();
    let (user_defs, diagnostics) = super::skill_runtime::discover_user_skills(dir, &cancellation);
    let builtins = super::builtin_skills::definitions();
    let builtin_names: std::collections::HashSet<&str> =
        builtins.iter().map(|d| d.entry.name.as_str()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut skills = Vec::new();
    for def in user_defs {
        let overrides_builtin = builtin_names.contains(def.entry.name.as_str());
        seen.insert(def.entry.name.clone());
        skills.push(ManagedSkillItem {
            name: def.entry.name,
            description: def.entry.description,
            instructions: def.instructions,
            origin: SkillOrigin::User,
            relative_path: def.entry.relative_path,
            file_hash: def.entry.file_hash,
            user_invocable: def.entry.user_invocable,
            disable_model_invocation: !def.entry.model_invocable,
            overrides_builtin,
        });
    }
    for def in builtins {
        if seen.contains(&def.entry.name) {
            continue;
        }
        skills.push(ManagedSkillItem {
            name: def.entry.name,
            description: def.entry.description,
            instructions: def.instructions,
            origin: SkillOrigin::Builtin,
            relative_path: def.entry.relative_path,
            file_hash: def.entry.file_hash,
            user_invocable: def.entry.user_invocable,
            disable_model_invocation: !def.entry.model_invocable,
            overrides_builtin: false,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ManagedSkillCatalog {
        user_skills_dir: crate::path_utils::portable_local_path(dir),
        user_skills_dir_exists: dir.is_dir(),
        skills,
        diagnostics,
    })
}

pub(crate) fn save_user_skill(
    user_skills_dir: Option<&Path>,
    input: SaveUserSkillInput,
) -> Result<ManagedSkillItem, String> {
    let name = input.name.trim().to_string();
    let (rendered, issues) = validate_draft(
        &name,
        &input.description,
        &input.instructions,
        input.user_invocable,
        input.disable_model_invocation,
    );
    let rendered = match rendered {
        Some(text) => text,
        None => {
            let summary = issues
                .first()
                .map(|issue| format!("{}: {}", issue.code, issue.message))
                .unwrap_or_else(|| "invalid skill content".into());
            return Err(summary);
        }
    };
    let dir = user_skills_dir.ok_or("User skills directory is not configured")?;
    fs::create_dir_all(dir).map_err(|e| format!("failed to prepare user skills directory: {e}"))?;
    let (relative_path, _) = commit_skill_file_at(
        dir,
        dir,
        "user",
        &name,
        &rendered,
        input.expected_base_hash.as_deref(),
        "SKILL_CONFLICT: a skill with this name already exists; open it to edit",
    )?;
    let (parsed, _) = parse_skill(&relative_path, rendered.as_bytes())?;
    let overrides_builtin = super::builtin_skills::definitions()
        .iter()
        .any(|d| d.entry.name == name);
    Ok(ManagedSkillItem {
        name: parsed.entry.name,
        description: parsed.entry.description,
        instructions: parsed.instructions,
        origin: SkillOrigin::User,
        relative_path: parsed.entry.relative_path,
        file_hash: parsed.entry.file_hash,
        user_invocable: parsed.entry.user_invocable,
        disable_model_invocation: !parsed.entry.model_invocable,
        overrides_builtin,
    })
}

pub(crate) fn delete_user_skill(
    user_skills_dir: Option<&Path>,
    input: DeleteUserSkillInput,
) -> Result<(), String> {
    let name = input.name.trim();
    if !valid_name(name) {
        return Err("invalid Skill name".into());
    }
    let dir = user_skills_dir.ok_or("User skills directory is not configured")?;
    if !dir.exists() {
        return Err("Skill no longer exists".into());
    }
    ensure_no_symlink_components(dir, &[name, "SKILL.md"])?;
    let dir_path = dir.join(name);
    let dir_file = dir_path.join("SKILL.md");
    let flat_name = format!("{name}.md");
    let flat_file = dir.join(&flat_name);

    let (actual_file, trash_target) = if dir_file.is_file() {
        ensure_path_inside_root(dir, &dir_path)?;
        let only_skill_file = fs::read_dir(&dir_path)
            .map_err(|e| format!("failed to inspect skill directory: {e}"))?
            .filter_map(Result::ok)
            .all(|entry| entry.file_name() == "SKILL.md");
        (
            dir_file.clone(),
            if only_skill_file { dir_path } else { dir_file },
        )
    } else if flat_file.is_file() {
        ensure_no_symlink_components(dir, &[&flat_name])?;
        (flat_file.clone(), flat_file)
    } else {
        return Err("Skill no longer exists".into());
    };

    let bytes = fs::read(&actual_file).map_err(|e| format!("failed to read skill file: {e}"))?;
    let current_hash = digest(&bytes);
    if current_hash != input.expected_file_hash {
        return Err("SKILL_CONFLICT: skill changed on disk before deletion; refresh first".into());
    }
    let path_str = crate::path_utils::portable_local_path(&trash_target);
    crate::local_fs::trash_local_paths_blocking(vec![path_str])
}

pub(crate) fn open_user_skills_dir(user_skills_dir: Option<&Path>) -> Result<(), String> {
    let dir = user_skills_dir.ok_or("User skills directory is not configured")?;
    if fs::symlink_metadata(dir).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("user skills directory must not be a symlink".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("failed to create user skills directory: {e}"))?;
    let canonical = fs::canonicalize(dir)
        .map_err(|e| format!("failed to resolve user skills directory: {e}"))?;
    crate::commands::open_path(crate::path_utils::portable_local_path(&canonical))
}

pub(crate) fn records(events: &[AgentSessionEvent]) -> Vec<SkillProposalRecord> {
    let mut list: Vec<SkillProposalRecord> = Vec::new();
    for event in events {
        match &event.payload {
            AgentSessionEventPayload::SkillProposalRequested {
                identity,
                proposal,
                provider,
            } => {
                list.push(SkillProposalRecord {
                    identity: identity.clone(),
                    proposal: proposal.clone(),
                    provider: provider.clone(),
                    resolution: None,
                    cancelled: false,
                    has_result: false,
                    fingerprint: None,
                });
            }
            AgentSessionEventPayload::SkillProposalResolved {
                resolution,
                fingerprint,
            } => {
                if let Some(record) = list.iter_mut().find(|r| r.identity == resolution.identity) {
                    record.resolution = Some(resolution.clone());
                    record.fingerprint = Some(fingerprint.clone());
                }
            }
            AgentSessionEventPayload::SkillProposalCancelled { identity } => {
                if let Some(record) = list.iter_mut().find(|r| &r.identity == identity) {
                    record.cancelled = true;
                }
            }
            AgentSessionEventPayload::ToolResult { call_id, .. } => {
                if let Some(record) = list.iter_mut().find(|r| {
                    event.step_id.as_deref() == Some(&r.identity.step_id)
                        && &r.identity.call_id == call_id
                }) {
                    record.has_result = true;
                }
            }
            _ => {}
        }
    }
    list
}

pub(crate) fn unresolved(events: &[AgentSessionEvent]) -> Option<SkillProposalRecord> {
    records(events)
        .into_iter()
        .rev()
        .find(|record| !record.has_result && !record.cancelled)
}

pub(crate) fn proposal_queue(events: &[AgentSessionEvent]) -> Option<(String, String, String)> {
    let record = records(events)
        .into_iter()
        .rev()
        .find(|record| !record.cancelled)?;
    let step_done = events.iter().any(|event| {
        event.step_id.as_deref() == Some(&record.identity.step_id)
            && matches!(event.payload, AgentSessionEventPayload::StepEnd { .. })
    });
    let turn_done = events.iter().any(|event| {
        event.turn_id.as_deref() == Some(&record.identity.turn_id)
            && matches!(event.payload, AgentSessionEventPayload::TurnEnd { .. })
    });
    if step_done || turn_done {
        return None;
    }
    Some((
        record.identity.turn_id,
        record.identity.step_id,
        record.identity.request_id,
    ))
}

pub(crate) fn can_complete_turn(events: &[AgentSessionEvent], turn_id: &str) -> bool {
    !records(events)
        .iter()
        .any(|r| r.identity.turn_id == turn_id && r.waiting())
}

pub(crate) fn validate_transition(
    previous_events: &[AgentSessionEvent],
    event: &AgentSessionEvent,
) -> Result<(), String> {
    let existing = records(previous_events);
    match &event.payload {
        AgentSessionEventPayload::SkillProposalRequested { identity, .. } => {
            let has_call = previous_events.iter().any(|prev| {
                prev.step_id.as_deref() == Some(&identity.step_id)
                    && matches!(
                        &prev.payload,
                        AgentSessionEventPayload::ToolCall { call }
                            if call.call_id == identity.call_id && call.name == TOOL_NAME
                    )
            });
            if !has_call {
                return Err("skill proposal request has no matching durable ToolCall".into());
            }
            if existing.iter().any(|r| {
                r.identity == *identity
                    || (r.identity.step_id == identity.step_id
                        && r.identity.call_id == identity.call_id)
            }) {
                return Err("duplicate skill proposal request for the same call".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillProposalResolved { resolution, .. } => {
            let Some(record) = existing.iter().find(|r| r.identity == resolution.identity) else {
                return Err("skill proposal resolution has no matching request".into());
            };
            if !record.waiting() {
                return Err("skill proposal is already resolved or cancelled".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillProposalCancelled { identity } => {
            let Some(record) = existing.iter().find(|r| r.identity == *identity) else {
                return Err("skill proposal cancellation has no matching request".into());
            };
            if !record.waiting() {
                return Err("skill proposal is already resolved or cancelled".into());
            }
            Ok(())
        }
        _ => Err("unexpected skill proposal transition".into()),
    }
}

pub(crate) fn validate_payload(event: &AgentSessionEvent) -> Result<(), String> {
    let bytes = serde_json::to_vec(&event.payload).map_err(|e| e.to_string())?;
    if bytes.len() > 240 * 1024 {
        return Err("skill proposal event exceeds durable event limit".into());
    }
    match &event.payload {
        AgentSessionEventPayload::SkillProposalRequested {
            identity, proposal, ..
        } => {
            identity.validate()?;
            if event.session_id != identity.session_id
                || event.turn_id.as_deref() != Some(&identity.turn_id)
                || event.step_id.as_deref() != Some(&identity.step_id)
            {
                return Err("skill proposal event scope does not match identity".into());
            }
            if proposal.name.len() > 128 || proposal.instructions.len() > MAX_SKILL_FILE {
                return Err("skill proposal payload exceeds bounds".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillProposalResolved {
            resolution,
            fingerprint,
        } => {
            resolution.identity.validate()?;
            non_empty_id(&resolution.client_operation_id, "clientOperationId")?;
            if fingerprint.len() != 64 {
                return Err("invalid skill proposal fingerprint".into());
            }
            if event.session_id != resolution.identity.session_id
                || event.turn_id.as_deref() != Some(&resolution.identity.turn_id)
                || event.step_id.as_deref() != Some(&resolution.identity.step_id)
            {
                return Err("skill proposal resolution scope does not match identity".into());
            }
            Ok(())
        }
        AgentSessionEventPayload::SkillProposalCancelled { identity } => {
            identity.validate()?;
            if event.session_id != identity.session_id
                || event.turn_id.as_deref() != Some(&identity.turn_id)
                || event.step_id.as_deref() != Some(&identity.step_id)
            {
                return Err("skill proposal cancellation scope does not match identity".into());
            }
            Ok(())
        }
        _ => Err("unexpected skill proposal payload".into()),
    }
}

fn scoped(
    identity: &SkillProposalIdentity,
    payload: AgentSessionEventPayload,
) -> super::AgentScopedPayload {
    super::AgentScopedPayload {
        turn_id: Some(identity.turn_id.clone()),
        step_id: Some(identity.step_id.clone()),
        payload,
    }
}

pub(crate) fn matches_result(
    record: &SkillProposalRecord,
    payload: &AgentSessionEventPayload,
) -> bool {
    !record.waiting() && *payload == tool_result_payload(record)
}

fn tool_result_payload(record: &SkillProposalRecord) -> AgentSessionEventPayload {
    if record.cancelled {
        return AgentSessionEventPayload::ToolResult {
            call_id: record.identity.call_id.clone(),
            name: TOOL_NAME.into(),
            status: super::AgentToolResultStatus::Cancelled,
            summary: "Skill proposal was cancelled before the user responded.".into(),
            data: Some(json!({ "status": "cancelled" })),
            duration_ms: None,
            evidence_refs: Vec::new(),
        };
    }
    match &record.resolution {
        Some(resolution) => match resolution.action {
            SkillProposalAction::Save => {
                let saved = resolution.saved.as_ref();
                let name = saved
                    .map(|s| s.name.as_str())
                    .unwrap_or(&record.proposal.name);
                let scope_str = match saved.map(|s| s.scope).unwrap_or(record.proposal.scope) {
                    SkillProposalScope::User => "user",
                    SkillProposalScope::Workspace => "workspace",
                };
                AgentSessionEventPayload::ToolResult {
                    call_id: record.identity.call_id.clone(),
                    name: TOOL_NAME.into(),
                    status: super::AgentToolResultStatus::Completed,
                    summary: format!(
                        "Saved Skill '{name}' in {scope_str} scope. It is now available in the current session via /{name}."
                    ),
                    data: Some(json!({
                        "status": "saved",
                        "scope": scope_str,
                        "name": name,
                        "relativePath": saved.map(|s| s.relative_path.as_str()),
                        "fileHash": saved.map(|s| s.file_hash.as_str()),
                        "editedByUser": saved.map(|s| s.edited_by_user).unwrap_or(false),
                    })),
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                }
            }
            SkillProposalAction::RequestRevision => {
                let note = resolution.note.as_deref().unwrap_or("");
                AgentSessionEventPayload::ToolResult {
                    call_id: record.identity.call_id.clone(),
                    name: TOOL_NAME.into(),
                    status: super::AgentToolResultStatus::Completed,
                    summary: format!(
                        "User requested revisions to the proposed Skill before saving: {note}"
                    ),
                    data: Some(json!({
                        "status": "revision_requested",
                        "note": note,
                    })),
                    duration_ms: None,
                    evidence_refs: Vec::new(),
                }
            }
            SkillProposalAction::Cancel => AgentSessionEventPayload::ToolResult {
                call_id: record.identity.call_id.clone(),
                name: TOOL_NAME.into(),
                status: super::AgentToolResultStatus::Completed,
                summary: "User declined to save the proposed Skill. No files were written.".into(),
                data: Some(json!({ "status": "cancelled" })),
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        },
        None => AgentSessionEventPayload::ToolResult {
            call_id: record.identity.call_id.clone(),
            name: TOOL_NAME.into(),
            status: super::AgentToolResultStatus::Failed,
            summary: "Skill proposal ended without a resolution.".into(),
            data: None,
            duration_ms: None,
            evidence_refs: Vec::new(),
        },
    }
}

fn remaining_step_calls_after_proposal(
    events: &[AgentSessionEvent],
    identity: &SkillProposalIdentity,
) -> Vec<super::ModelToolCall> {
    let Some(calls) = events
        .iter()
        .filter(|event| {
            event.turn_id.as_deref() == Some(&identity.turn_id)
                && event.step_id.as_deref() == Some(&identity.step_id)
        })
        .find_map(|event| match &event.payload {
            AgentSessionEventPayload::AssistantMessage { content, .. } => {
                Some(super::assistant_tool_calls(content))
            }
            _ => None,
        })
    else {
        return Vec::new();
    };
    calls
        .into_iter()
        .skip_while(|call| call.call_id != identity.call_id)
        .skip(1)
        .filter(|call| {
            !events.iter().any(|event| {
                event.turn_id.as_deref() == Some(&identity.turn_id)
                    && event.step_id.as_deref() == Some(&identity.step_id)
                    && matches!(
                        &event.payload,
                        AgentSessionEventPayload::ToolResult { call_id, .. }
                            if call_id == &call.call_id
                    )
            })
        })
        .map(|call| super::ModelToolCall {
            call_id: call.call_id,
            provider_call_id: call.provider_call_id,
            name: call.name,
            arguments: call.arguments,
        })
        .collect()
}

impl super::AgentToolPipeline {
    fn fail_skill_proposal_call(
        &self,
        identity: &SkillProposalIdentity,
        mut payloads: Vec<super::AgentScopedPayload>,
        reason: String,
    ) -> Result<super::ToolPipelineSettlement, String> {
        payloads.push(scoped(
            identity,
            AgentSessionEventPayload::ToolResult {
                call_id: identity.call_id.clone(),
                name: TOOL_NAME.into(),
                status: super::AgentToolResultStatus::Failed,
                summary: reason,
                data: None,
                duration_ms: None,
                evidence_refs: Vec::new(),
            },
        ));
        self.sessions.append_batch(&identity.session_id, payloads)?;
        Ok(super::ToolPipelineSettlement::Completed)
    }

    pub(crate) fn request_skill_proposal(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        turn: &str,
        step: &str,
        request: &str,
        call: super::ModelToolCall,
    ) -> Result<super::ToolPipelineSettlement, String> {
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "interaction gate unavailable")?;
        if entry.cancellation().is_cancelled() {
            return Ok(super::ToolPipelineSettlement::Cancelled);
        }
        let header = self.sessions.snapshot(&entry.session_id)?.header;
        let user_dir = self.skills.user_skills_dir();
        let prepared = self.agents.require_live_root(entry).and_then(|()| {
            let arg_bytes = serde_json::to_vec(&call.arguments).map_err(|e| e.to_string())?;
            if arg_bytes.len() > MAX_PROPOSAL_BYTES {
                return Err("propose_skill payload exceeds 160 KiB".into());
            }
            if crate::redaction::redact_json_value(&call.arguments) != call.arguments {
                return Err(
                    "SKILL_REDACTION_REQUIRED: proposed Skill contains credentials or secrets; remove all sensitive values and retry propose_skill"
                        .into(),
                );
            }
            let raw: RawProposalArgs =
                serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
            let mut scope = raw.scope;
            let workspace_allowed = local_workspace_root(&header).is_some();
            let mut scope_downgrade_reason = None;
            if scope == SkillProposalScope::Workspace && !workspace_allowed {
                scope = SkillProposalScope::User;
                scope_downgrade_reason = Some(
                    "Workspace scope is only available for bound local directories; defaulted to user global (~/.shellspan/skills)."
                        .into(),
                );
            }
            let (_, validation_issues) = validate_draft(
                &raw.name,
                &raw.description,
                &raw.instructions,
                raw.user_invocable,
                raw.disable_model_invocation,
            );
            let inspection = if valid_name(&raw.name) {
                inspect_target(&header, user_dir.as_deref(), scope, &raw.name).ok()
            } else {
                None
            };
            let summary = raw
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            Ok(PreparedSkillProposal {
                mode: raw.mode,
                scope,
                workspace_allowed,
                scope_downgrade_reason,
                name: raw.name,
                description: raw.description,
                instructions: raw.instructions,
                user_invocable: raw.user_invocable,
                disable_model_invocation: raw.disable_model_invocation,
                summary,
                existing_content: inspection.as_ref().and_then(|i| i.existing_content.clone()),
                existing_file_hash: inspection
                    .as_ref()
                    .and_then(|i| i.existing_file_hash.clone()),
                overwrites_builtin: inspection.as_ref().is_some_and(|i| i.overwrites_builtin),
                shadowed_by_workspace: inspection
                    .as_ref()
                    .is_some_and(|i| i.shadowed_by_workspace),
                validation_issues,
            })
        });
        let identity = SkillProposalIdentity {
            session_id: entry.session_id.clone(),
            turn_id: turn.into(),
            step_id: step.into(),
            request_id: request.into(),
            call_id: call.call_id.clone(),
            proposal_id: format!("skill-proposal-{}", uuid::Uuid::new_v4().simple()),
        };
        let recorded = super::RecordedToolCall {
            call_id: call.call_id,
            provider_call_id: call.provider_call_id,
            name: call.name,
            native_name: None,
            arguments: call.arguments,
            title: Some("Propose skill".into()),
            effect: Some(super::AgentSessionEffect::ReadOnly),
            target: header.target,
        };
        let mut payloads = Vec::new();
        let existing = self
            .sessions
            .all_events(&entry.session_id)?
            .into_iter()
            .find_map(|e| match e.payload {
                AgentSessionEventPayload::ToolCall { call }
                    if e.step_id.as_deref() == Some(step) && call.call_id == recorded.call_id =>
                {
                    Some(call)
                }
                _ => None,
            });
        if let Some(existing) = existing {
            if existing != recorded {
                return Err("recovered skill proposal call drifted".into());
            }
        } else {
            payloads.push(scoped(
                &identity,
                AgentSessionEventPayload::ToolCall { call: recorded },
            ));
        }
        match prepared {
            Ok(proposal) => {
                payloads.push(scoped(
                    &identity,
                    AgentSessionEventPayload::SkillProposalRequested {
                        identity: identity.clone(),
                        proposal,
                        provider: super::subagent::provider_descriptor(&entry.model()?.provider),
                    },
                ));
                payloads.push(super::AgentScopedPayload {
                    turn_id: None,
                    step_id: None,
                    payload: AgentSessionEventPayload::AgentStatus {
                        status: super::AgentSessionStatus::Waiting,
                        reason: Some("waitingForSkillProposal".into()),
                    },
                });
                self.sessions.append_batch(&entry.session_id, payloads)?;
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id: turn.into(),
                    step_id: Some(step.into()),
                }))?;
                entry.set_phase(super::AgentLifecyclePhase::Waiting)?;
                Ok(super::ToolPipelineSettlement::Waiting)
            }
            Err(reason) => self.fail_skill_proposal_call(&identity, payloads, reason),
        }
    }

    pub(crate) fn submit_skill_proposal_resolution(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
        input: ResolveSkillProposalInput,
    ) -> Result<bool, String> {
        input.validate()?;
        let fingerprint = input_fingerprint(&input)?;
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "interaction gate unavailable")?;
        self.agents.require_live_root(entry)?;
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let events = self.sessions.all_events(&entry.session_id)?;
        let all_records = records(&events);
        let record = all_records
            .iter()
            .find(|r| r.identity == input.identity)
            .ok_or("unknown or cross-Session skill proposal")?;
        if record.waiting()
            && matches!(
                snapshot.recovery.status,
                super::AgentRecoveryStatus::Required | super::AgentRecoveryStatus::Reconciling
            )
        {
            return Err("skill proposal cannot bypass required recovery reconciliation".into());
        }
        if record.cancelled || entry.cancellation().is_cancelled() {
            return Err("skill proposal was cancelled".into());
        }
        if let Some(existing) = &record.resolution {
            return if existing.client_operation_id == input.client_operation_id
                && record.fingerprint.as_deref() == Some(&fingerprint)
            {
                Ok(false)
            } else {
                Err("skill proposal resolution conflicts with its committed decision".into())
            };
        }
        if snapshot.ended {
            return Err("skill proposal Session has ended".into());
        }
        let (saved, note) = match input.action {
            SkillProposalAction::Save => {
                let scope = input.scope.unwrap_or(record.proposal.scope);
                let name = input
                    .name
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or(&record.proposal.name)
                    .to_string();
                let description = input
                    .description
                    .as_deref()
                    .unwrap_or(&record.proposal.description)
                    .to_string();
                let instructions = input
                    .instructions
                    .as_deref()
                    .unwrap_or(&record.proposal.instructions)
                    .to_string();
                let user_invocable = input
                    .user_invocable
                    .unwrap_or(record.proposal.user_invocable);
                let disable_model_invocation = input
                    .disable_model_invocation
                    .unwrap_or(record.proposal.disable_model_invocation);
                let (rendered, issues) = validate_draft(
                    &name,
                    &description,
                    &instructions,
                    user_invocable,
                    disable_model_invocation,
                );
                let rendered = match rendered {
                    Some(text) => text,
                    None => {
                        let summary = issues
                            .first()
                            .map(|issue| format!("{}: {}", issue.code, issue.message))
                            .unwrap_or_else(|| "invalid skill content".into());
                        return Err(summary);
                    }
                };
                let expected_base_hash = if input.expected_base_hash.is_some() {
                    input.expected_base_hash.as_deref()
                } else if scope == record.proposal.scope && name == record.proposal.name {
                    record.proposal.existing_file_hash.as_deref()
                } else {
                    None
                };
                let user_dir = self.skills.user_skills_dir();
                let (relative_path, file_hash) = write_skill_file(
                    &snapshot.header,
                    user_dir.as_deref(),
                    scope,
                    &name,
                    &rendered,
                    expected_base_hash,
                )?;
                let edited_by_user = scope != record.proposal.scope
                    || name != record.proposal.name
                    || description != record.proposal.description
                    || instructions != record.proposal.instructions
                    || user_invocable != record.proposal.user_invocable
                    || disable_model_invocation != record.proposal.disable_model_invocation;
                (
                    Some(SavedSkillMetadata {
                        scope,
                        name,
                        relative_path,
                        file_hash,
                        edited_by_user,
                    }),
                    None,
                )
            }
            SkillProposalAction::RequestRevision => (
                None,
                input
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            ),
            SkillProposalAction::Cancel => (None, None),
        };
        let saved_file = saved.is_some();
        let resolution = SkillProposalResolution {
            identity: input.identity.clone(),
            client_operation_id: input.client_operation_id,
            action: input.action,
            note,
            saved,
        };
        self.sessions.append_batch(
            &entry.session_id,
            vec![scoped(
                &input.identity,
                AgentSessionEventPayload::SkillProposalResolved {
                    resolution,
                    fingerprint,
                },
            )],
        )?;
        entry.set_phase(super::AgentLifecyclePhase::Running)?;
        Ok(saved_file)
    }

    pub(crate) fn cancel_skill_proposals(&self, session_id: &str) -> Result<(), String> {
        let events = self.sessions.all_events(session_id)?;
        for mut record in records(&events) {
            if record.has_result {
                continue;
            }
            let mut payloads = Vec::new();
            if record.waiting() {
                payloads.push(scoped(
                    &record.identity,
                    AgentSessionEventPayload::SkillProposalCancelled {
                        identity: record.identity.clone(),
                    },
                ));
                record.cancelled = true;
            }
            payloads.push(scoped(&record.identity, tool_result_payload(&record)));
            self.sessions.append_batch(session_id, payloads)?;
            let remaining = remaining_step_calls_after_proposal(
                &self.sessions.all_events(session_id)?,
                &record.identity,
            );
            for call in remaining {
                self.commit_not_started_call(
                    session_id,
                    &record.identity.turn_id,
                    &record.identity.step_id,
                    &call,
                    None,
                    "cancelled",
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn restore_skill_proposal_phase(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
    ) -> Result<(), String> {
        let gate = self.question_gate(&entry.session_id)?;
        let _gate = gate.lock().map_err(|_| "interaction gate unavailable")?;
        let events = self.sessions.all_events(&entry.session_id)?;
        if events
            .iter()
            .rev()
            .take_while(|event| {
                !matches!(event.payload, AgentSessionEventPayload::SessionResumed {})
                    && !matches!(&event.payload,
                        AgentSessionEventPayload::AgentStatus { status: super::AgentSessionStatus::Idle, reason }
                            if reason.as_deref() == Some("stoppedByUser"))
            })
            .any(|event| {
                matches!(
                    event.payload,
                    AgentSessionEventPayload::SkillProposalCancelled { .. }
                )
            })
        {
            entry.cancel();
            self.cancel_skill_proposals(&entry.session_id)?;
            super::driver::close_open_scope(&self.sessions, entry, "cancelled")?;
            self.sessions.cancel(&entry.session_id)?;
            return entry.set_phase(super::AgentLifecyclePhase::Stopping);
        }
        let snapshot = self.sessions.snapshot(&entry.session_id)?;
        let checkpoint = snapshot.recovery;
        if matches!(
            checkpoint.kind,
            super::AgentRecoveryCheckpointKind::WaitingSkillProposal
                | super::AgentRecoveryCheckpointKind::SkillProposalContinuation
        ) {
            if let Some((turn_id, step_id, _)) = proposal_queue(&events) {
                let finished = events.iter().any(|e| {
                    e.step_id.as_ref() == Some(&step_id)
                        && matches!(&e.payload, AgentSessionEventPayload::StepEnd { reason } if reason == "toolsCompleted")
                });
                entry.set_scope(Some(super::AgentActiveScope {
                    turn_id,
                    step_id: (!finished).then_some(step_id),
                }))?;
            }
        }
        match checkpoint.kind {
            super::AgentRecoveryCheckpointKind::WaitingSkillProposal => {
                entry.set_phase(super::AgentLifecyclePhase::Waiting)
            }
            super::AgentRecoveryCheckpointKind::SkillProposalContinuation => {
                entry.set_phase(super::AgentLifecyclePhase::Running)
            }
            _ => Ok(()),
        }
    }

    pub(crate) async fn continue_skill_proposals(
        &self,
        entry: &std::sync::Arc<super::AgentEntry>,
    ) -> Result<Option<super::ToolPipelineSettlement>, String> {
        let Some(scope) = entry.scope()? else {
            return Ok(None);
        };
        let Some(step_id) = scope.step_id else {
            return Ok(None);
        };
        let events = self.sessions.all_events(&entry.session_id)?;
        let record = records(&events)
            .into_iter()
            .rev()
            .find(|r| r.identity.step_id == step_id);
        let Some((_, queue_step, request_id)) = proposal_queue(&events) else {
            return Ok(None);
        };
        if queue_step != step_id {
            return Ok(None);
        }
        if let Some(record) = record {
            let gate = self.question_gate(&entry.session_id)?;
            let _gate = gate.lock().map_err(|_| "interaction gate unavailable")?;
            let record = records(&self.sessions.all_events(&entry.session_id)?)
                .into_iter()
                .find(|r| r.identity == record.identity)
                .ok_or("skill proposal disappeared")?;
            if record.waiting() {
                return Ok(Some(super::ToolPipelineSettlement::Waiting));
            }
            if !record.has_result {
                self.sessions.append_batch(
                    &entry.session_id,
                    vec![scoped(&record.identity, tool_result_payload(&record))],
                )?;
            }
            if entry.cancellation().is_cancelled() || record.cancelled {
                return Ok(Some(super::ToolPipelineSettlement::Cancelled));
            }
            self.sessions.append(
                &entry.session_id,
                None,
                None,
                AgentSessionEventPayload::AgentStatus {
                    status: super::AgentSessionStatus::Running,
                    reason: Some("skillProposalResolved".into()),
                },
            )?;
        }
        let events = self.sessions.all_events(&entry.session_id)?;
        let calls = events
            .iter()
            .filter(|e| e.step_id.as_deref() == Some(&step_id))
            .find_map(|e| match &e.payload {
                AgentSessionEventPayload::AssistantMessage { content, .. } => {
                    Some(super::assistant_tool_calls(content))
                }
                _ => None,
            })
            .ok_or("skill proposal lost original assistant calls")?;
        let remaining = calls
            .into_iter()
            .filter(|call| {
                !events.iter().any(|e| {
                    e.step_id.as_deref() == Some(&step_id)
                        && matches!(&e.payload, AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == &call.call_id)
                })
            })
            .map(|call| super::ModelToolCall {
                call_id: call.call_id,
                provider_call_id: call.provider_call_id,
                name: call.name,
                arguments: call.arguments,
            })
            .collect();
        self.process_model_calls(entry, &scope.turn_id, &step_id, &request_id, remaining)
            .await
            .map(Some)
    }
}
