use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent_contract_v3::{
    AgentEffectKindV3, AgentRequestV3, AgentTargetKindV3, AgentToolTargetV3, PlanStepStatusV3,
    PlanStepV3, UpdatePlanArgumentsV3,
};
use crate::redaction::redact_sensitive_text;
use crate::runbook::contains_secret_literal;

use super::{ToolImplementationStateV3, ToolRegistryV3};

const MAX_EXTENSION_FILE_BYTES: u64 = 128 * 1024;
const MAX_SKILL_BODY_BYTES: usize = 64 * 1024;
const MAX_EXTENSIONS_PER_KIND: usize = 64;
const MAX_HOOK_EVENTS: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillCatalogEntryV3 {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) required_tools: Vec<String>,
    pub(crate) targets: Vec<AgentTargetKindV3>,
    pub(crate) permissions: Vec<AgentEffectKindV3>,
    pub(crate) loaded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadedSkillV3 {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) required_tools: Vec<String>,
    pub(crate) targets: Vec<AgentTargetKindV3>,
    pub(crate) permissions: Vec<AgentEffectKindV3>,
    pub(crate) instruction_eligible: bool,
    pub(crate) grants_permissions: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadSkillRequestV3 {
    pub(crate) task_id: String,
    pub(crate) skill_id: String,
    pub(crate) target_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HookEventV3 {
    SessionStart,
    SessionEnd,
    UserPromptSubmitted,
    BeforeTool,
    AfterTool,
    ToolFailed,
    PermissionRequested,
    BeforeCompact,
    TaskCompleted,
    TaskFailed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum HookModeV3 {
    Sync,
    Async,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum HookActionV3 {
    Allow,
    Deny,
    Modify,
    Observe,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookDecisionV3 {
    pub(crate) hook_id: String,
    pub(crate) action: String,
    pub(crate) summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookApplicationV3 {
    pub(crate) effective_arguments: Value,
    pub(crate) decisions: Vec<HookDecisionV3>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookAuditEventV3 {
    pub(crate) event: HookEventV3,
    pub(crate) task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) call_id: Option<String>,
    pub(crate) outcome: String,
    pub(crate) recorded_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunbookCatalogEntryV3 {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) version: u8,
    pub(crate) parameters: Vec<RunbookParameterV3>,
    pub(crate) step_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstantiateRunbookRequestV3 {
    pub(crate) task_id: String,
    pub(crate) runbook_id: String,
    pub(crate) target_id: String,
    #[serde(default)]
    pub(crate) parameters: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExtensionSnapshotV3 {
    pub(crate) generation: u64,
    pub(crate) workspace_loaded: bool,
    pub(crate) skills: Vec<SkillCatalogEntryV3>,
    pub(crate) hooks: Vec<String>,
    pub(crate) runbooks: Vec<RunbookCatalogEntryV3>,
    pub(crate) recent_hook_events: Vec<HookAuditEventV3>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillHeaderV3 {
    version: u8,
    name: String,
    description: String,
    required_tools: Vec<String>,
    targets: Vec<AgentTargetKindV3>,
    permissions: Vec<AgentEffectKindV3>,
}

#[derive(Debug, Clone)]
struct StoredSkillV3 {
    catalog: SkillCatalogEntryV3,
    body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookFileV3 {
    version: u8,
    hooks: Vec<HookDefinitionV3>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HookDefinitionV3 {
    id: String,
    event: HookEventV3,
    mode: HookModeV3,
    action: HookActionV3,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    argument_overrides: Option<Map<String, Value>>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    metric_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunbookParameterV3 {
    pub(crate) name: String,
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) default: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookFileV3 {
    version: u8,
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    parameters: Vec<RunbookParameterV3>,
    #[serde(default)]
    prechecks: Vec<RunbookStepV3>,
    steps: Vec<RunbookStepV3>,
    success_criteria: Vec<String>,
    rollback: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunbookStepV3 {
    id: String,
    description: String,
    #[serde(default)]
    dependencies: Vec<String>,
    required_tools: Vec<String>,
    expected_effect: AgentEffectKindV3,
    success_criteria: Vec<String>,
    rollback_or_compensation: String,
}

#[derive(Debug, Clone)]
struct StoredRunbookV3 {
    catalog: RunbookCatalogEntryV3,
    definition: RunbookFileV3,
}

#[derive(Debug, Clone)]
struct ExtensionTaskStateV3 {
    request: AgentRequestV3,
    workspace_root: Option<PathBuf>,
    generation: u64,
    skills: HashMap<String, StoredSkillV3>,
    hooks: Vec<HookDefinitionV3>,
    runbooks: HashMap<String, StoredRunbookV3>,
    recent_hook_events: Vec<HookAuditEventV3>,
}

#[derive(Clone, Default)]
pub(crate) struct ExtensionRuntimeV3 {
    states: Arc<Mutex<HashMap<String, ExtensionTaskStateV3>>>,
}

impl ExtensionRuntimeV3 {
    pub(crate) fn register_task(&self, request: &AgentRequestV3) -> Result<(), String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        if let Some(existing) = states.get(&request.task_id) {
            return if existing.request == *request {
                Ok(())
            } else {
                Err("extension task id belongs to a different request".into())
            };
        }
        states.insert(
            request.task_id.clone(),
            ExtensionTaskStateV3 {
                request: request.clone(),
                workspace_root: None,
                generation: 1,
                skills: HashMap::new(),
                hooks: Vec::new(),
                runbooks: HashMap::new(),
                recent_hook_events: vec![HookAuditEventV3 {
                    event: HookEventV3::SessionStart,
                    task_id: request.task_id.clone(),
                    tool_name: None,
                    call_id: None,
                    outcome: "recorded".into(),
                    recorded_at_unix_ms: current_unix_ms(),
                }],
            },
        );
        Ok(())
    }

    pub(crate) fn refresh(
        &self,
        task_id: &str,
        registry: &ToolRegistryV3,
    ) -> Result<ExtensionSnapshotV3, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        let state = states
            .get_mut(task_id)
            .ok_or_else(|| "Agent extension task was not found".to_string())?;
        let root = validate_workspace_root(&workspace_root_v3(&state.request)?)?;
        state.skills = discover_skills(&root, registry)?;
        state.hooks = discover_hooks(&root)?;
        state.runbooks = discover_runbooks(&root, registry)?;
        state.workspace_root = Some(root);
        state.generation = state.generation.saturating_add(1);
        Ok(extension_snapshot(state))
    }

    pub(crate) fn snapshot(&self, task_id: &str) -> Result<ExtensionSnapshotV3, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        states
            .get(task_id)
            .map(extension_snapshot)
            .ok_or_else(|| "Agent extension task was not found".to_string())
    }

    pub(crate) fn load_skill(
        &self,
        input: LoadSkillRequestV3,
        registry: &ToolRegistryV3,
    ) -> Result<LoadedSkillV3, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        let state = states
            .get_mut(&input.task_id)
            .ok_or_else(|| "Agent extension task was not found".to_string())?;
        let target = state
            .request
            .targets
            .iter()
            .find(|target| target.target_id() == input.target_id)
            .ok_or_else(|| "Skill target is outside the frozen task".to_string())?;
        let skill = state
            .skills
            .get_mut(&input.skill_id)
            .ok_or_else(|| "Skill was not discovered in the frozen workspace".to_string())?;
        if !skill.catalog.targets.contains(&target.kind()) {
            return Err("Skill declaration does not support the selected target".into());
        }
        validate_required_tools(
            &skill.catalog.required_tools,
            &skill.catalog.targets,
            registry,
        )?;
        skill.catalog.loaded = true;
        state.generation = state.generation.saturating_add(1);
        Ok(LoadedSkillV3 {
            id: skill.catalog.id.clone(),
            name: skill.catalog.name.clone(),
            content: skill.body.clone(),
            required_tools: skill.catalog.required_tools.clone(),
            targets: skill.catalog.targets.clone(),
            permissions: skill.catalog.permissions.clone(),
            instruction_eligible: true,
            grants_permissions: false,
        })
    }

    pub(crate) fn apply_before_tool(
        &self,
        task_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> Result<HookApplicationV3, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        let state = states
            .get(task_id)
            .ok_or_else(|| "Agent extension task was not found".to_string())?;
        let mut effective = arguments.clone();
        let mut decisions = Vec::new();
        for hook in state.hooks.iter().filter(|hook| {
            hook.event == HookEventV3::BeforeTool
                && hook.mode == HookModeV3::Sync
                && hook.tool.as_deref().is_none_or(|tool| tool == tool_name)
        }) {
            match hook.action {
                HookActionV3::Deny => {
                    return Err(format!(
                        "synchronous beforeTool hook {} denied the call: {}",
                        hook.id,
                        hook.reason.as_deref().unwrap_or("no reason supplied")
                    ))
                }
                HookActionV3::Modify => {
                    let object = effective.as_object_mut().ok_or_else(|| {
                        "beforeTool hook can only modify object arguments".to_string()
                    })?;
                    let overrides = hook
                        .argument_overrides
                        .as_ref()
                        .ok_or_else(|| "modify hook has no argumentOverrides".to_string())?;
                    for (key, value) in overrides {
                        object.insert(key.clone(), value.clone());
                    }
                    decisions.push(HookDecisionV3 {
                        hook_id: hook.id.clone(),
                        action: "modify".into(),
                        summary: "arguments modified; Rust schema/effect/policy revalidation remains mandatory".into(),
                    });
                }
                HookActionV3::Allow => decisions.push(HookDecisionV3 {
                    hook_id: hook.id.clone(),
                    action: "allow".into(),
                    summary: "advisory allow only; no capability or permission was granted".into(),
                }),
                HookActionV3::Observe => return Err("synchronous hooks cannot use observe".into()),
            }
        }
        Ok(HookApplicationV3 {
            effective_arguments: effective,
            decisions,
        })
    }

    pub(crate) fn record_event(
        &self,
        task_id: &str,
        event: HookEventV3,
        tool_name: Option<&str>,
        call_id: Option<&str>,
        outcome: &str,
    ) {
        let Ok(mut states) = self.states.lock() else {
            return;
        };
        let Some(state) = states.get_mut(task_id) else {
            return;
        };
        let has_async_observer = state
            .hooks
            .iter()
            .any(|hook| hook.event == event && hook.mode == HookModeV3::Async);
        if !has_async_observer && event != HookEventV3::SessionStart {
            return;
        }
        state.recent_hook_events.push(HookAuditEventV3 {
            event,
            task_id: task_id.to_string(),
            tool_name: tool_name.map(str::to_string),
            call_id: call_id.map(str::to_string),
            outcome: redact_sensitive_text(outcome),
            recorded_at_unix_ms: current_unix_ms(),
        });
        if state.recent_hook_events.len() > MAX_HOOK_EVENTS {
            let excess = state.recent_hook_events.len() - MAX_HOOK_EVENTS;
            state.recent_hook_events.drain(..excess);
        }
        state.generation = state.generation.saturating_add(1);
    }

    pub(crate) fn instantiate_runbook(
        &self,
        input: InstantiateRunbookRequestV3,
        current_plan_version: u64,
        registry: &ToolRegistryV3,
    ) -> Result<UpdatePlanArgumentsV3, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "Agent extension state is unavailable".to_string())?;
        let state = states
            .get(&input.task_id)
            .ok_or_else(|| "Agent extension task was not found".to_string())?;
        let target = state
            .request
            .targets
            .iter()
            .find(|target| target.target_id() == input.target_id)
            .ok_or_else(|| "Runbook target is outside the frozen task".to_string())?;
        let runbook = state
            .runbooks
            .get(&input.runbook_id)
            .ok_or_else(|| "Runbook was not discovered in the frozen workspace".to_string())?;
        let parameters = resolve_parameters(&runbook.definition.parameters, &input.parameters)?;
        let mut declared_ids = HashSet::new();
        let all_steps = runbook
            .definition
            .prechecks
            .iter()
            .chain(runbook.definition.steps.iter())
            .collect::<Vec<_>>();
        let mut plan_steps = Vec::with_capacity(all_steps.len());
        for step in all_steps {
            if !declared_ids.insert(step.id.clone()) {
                return Err("Runbook contains duplicate step ids".into());
            }
            validate_required_tools(&step.required_tools, &[target.kind()], registry)?;
            plan_steps.push(PlanStepV3 {
                id: step.id.clone(),
                description: substitute_parameters(&step.description, &parameters)?,
                dependencies: step.dependencies.clone(),
                target_ids: vec![target.target_id().to_string()],
                required_tools: step.required_tools.clone(),
                expected_effect: step.expected_effect,
                status: PlanStepStatusV3::Pending,
                success_criteria: step
                    .success_criteria
                    .iter()
                    .map(|value| substitute_parameters(value, &parameters))
                    .collect::<Result<Vec<_>, _>>()?,
                rollback_or_compensation: substitute_parameters(
                    &step.rollback_or_compensation,
                    &parameters,
                )?,
                evidence_refs: Vec::new(),
            });
        }
        let explanation = format!(
            "Runbook {} v{} instantiated without granting permissions. Overall success: {}. Rollback: {}",
            runbook.catalog.name,
            runbook.catalog.version,
            runbook.definition.success_criteria.join("; "),
            runbook.definition.rollback.join("; ")
        );
        Ok(UpdatePlanArgumentsV3 {
            plan_version: current_plan_version,
            explanation: Some(substitute_parameters(&explanation, &parameters)?),
            steps: plan_steps,
        })
    }
}

pub(crate) fn workspace_root_v3(request: &AgentRequestV3) -> Result<PathBuf, String> {
    match request.targets.first() {
        Some(AgentToolTargetV3::Local {
            cwd: Some(root), ..
        }) => Ok(PathBuf::from(root)),
        Some(AgentToolTargetV3::Remote { .. }) => {
            Err("M3 workspace extensions are local-only in this milestone".into())
        }
        _ => Err("task has no frozen local workspace root".into()),
    }
}

fn extension_snapshot(state: &ExtensionTaskStateV3) -> ExtensionSnapshotV3 {
    let mut skills = state
        .skills
        .values()
        .map(|skill| skill.catalog.clone())
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    let mut hooks = state
        .hooks
        .iter()
        .map(|hook| hook.id.clone())
        .collect::<Vec<_>>();
    hooks.sort();
    let mut runbooks = state
        .runbooks
        .values()
        .map(|runbook| runbook.catalog.clone())
        .collect::<Vec<_>>();
    runbooks.sort_by(|left, right| left.id.cmp(&right.id));
    ExtensionSnapshotV3 {
        generation: state.generation,
        workspace_loaded: state.workspace_root.is_some(),
        skills,
        hooks,
        runbooks,
        recent_hook_events: state.recent_hook_events.clone(),
    }
}

fn discover_skills(
    root: &Path,
    registry: &ToolRegistryV3,
) -> Result<HashMap<String, StoredSkillV3>, String> {
    let skills_root = root.join(".shellspan").join("skills");
    let Some(entries) = read_optional_directory(root, &skills_root)? else {
        return Ok(HashMap::new());
    };
    let mut skills = HashMap::new();
    for entry in entries {
        if skills.len() >= MAX_EXTENSIONS_PER_KIND {
            return Err("Skill count exceeded the native bound".into());
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("failed to inspect Skill directory: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symlinked Skill directories are rejected".into());
        }
        if !metadata.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        validate_identifier(&id)?;
        let path = entry.path().join("SKILL.md");
        let Some(raw) = read_optional_extension_file(root, &path)? else {
            continue;
        };
        let (yaml, body) = split_frontmatter(&raw)?;
        let header: SkillHeaderV3 = serde_yaml::from_str(yaml)
            .map_err(|error| format!("invalid Skill frontmatter: {error}"))?;
        if header.version != 1
            || header.name.trim().is_empty()
            || header.description.trim().is_empty()
            || header.targets.is_empty()
            || header.required_tools.is_empty()
            || body.len() > MAX_SKILL_BODY_BYTES
        {
            return Err("Skill declaration is outside the M3 v1 bounds".into());
        }
        validate_required_tools(&header.required_tools, &header.targets, registry)?;
        if header.permissions.is_empty() {
            return Err("Skill must declare its required permission effects".into());
        }
        for tool_name in &header.required_tools {
            let tool = registry
                .get(tool_name)
                .map_err(|_| "Skill references an unregistered tool".to_string())?;
            if !header
                .permissions
                .iter()
                .any(|effect| tool.descriptor.allowed_effects.contains(effect))
            {
                return Err(
                    "Skill permission declaration does not match its required tools".into(),
                );
            }
        }
        let catalog = SkillCatalogEntryV3 {
            id: id.clone(),
            name: header.name,
            description: header.description,
            required_tools: header.required_tools,
            targets: header.targets,
            permissions: header.permissions,
            loaded: false,
        };
        if skills
            .insert(
                id,
                StoredSkillV3 {
                    catalog,
                    body: redact_sensitive_text(body),
                },
            )
            .is_some()
        {
            return Err("duplicate Skill id".into());
        }
    }
    Ok(skills)
}

fn discover_hooks(root: &Path) -> Result<Vec<HookDefinitionV3>, String> {
    let path = root.join(".shellspan").join("hooks.json");
    let Some(raw) = read_optional_extension_file(root, &path)? else {
        return Ok(Vec::new());
    };
    let file: HookFileV3 =
        serde_json::from_str(&raw).map_err(|error| format!("invalid Hook config: {error}"))?;
    if file.version != 1 || file.hooks.len() > MAX_EXTENSIONS_PER_KIND {
        return Err("Hook config is outside the M3 v1 bounds".into());
    }
    let mut ids = HashSet::new();
    for hook in &file.hooks {
        validate_identifier(&hook.id)?;
        if !ids.insert(&hook.id) {
            return Err("duplicate Hook id".into());
        }
        match (hook.mode, hook.event, hook.action) {
            (HookModeV3::Sync, HookEventV3::BeforeTool, HookActionV3::Allow)
            | (HookModeV3::Sync, HookEventV3::BeforeTool, HookActionV3::Deny) => {
                if hook.argument_overrides.is_some() {
                    return Err("allow/deny Hooks cannot modify arguments".into());
                }
            }
            (HookModeV3::Sync, HookEventV3::BeforeTool, HookActionV3::Modify) => {
                if hook.argument_overrides.as_ref().is_none_or(Map::is_empty) {
                    return Err("modify Hook requires argumentOverrides".into());
                }
            }
            (HookModeV3::Async, _, HookActionV3::Observe) => {
                if hook.argument_overrides.is_some()
                    || hook.metric_name.as_deref().unwrap_or("").is_empty()
                {
                    return Err(
                        "async Hook must be an observe-only metric with no modifications".into(),
                    );
                }
            }
            _ => {
                return Err(
                    "sync Hooks are limited to beforeTool; async Hooks are observe-only".into(),
                )
            }
        }
    }
    Ok(file.hooks)
}

fn discover_runbooks(
    root: &Path,
    registry: &ToolRegistryV3,
) -> Result<HashMap<String, StoredRunbookV3>, String> {
    let runbooks_root = root.join(".shellspan").join("runbooks");
    let Some(entries) = read_optional_directory(root, &runbooks_root)? else {
        return Ok(HashMap::new());
    };
    let mut runbooks = HashMap::new();
    for entry in entries {
        if runbooks.len() >= MAX_EXTENSIONS_PER_KIND {
            return Err("Runbook count exceeded the native bound".into());
        }
        let path = entry.path();
        let extension = path.extension().and_then(|value| value.to_str());
        if !matches!(extension, Some("md" | "yaml" | "yml")) {
            continue;
        }
        let Some(raw) = read_optional_extension_file(root, &path)? else {
            continue;
        };
        if contains_secret_literal(&raw) {
            return Err(
                "Runbook contains a secret literal; use a native credential reference".into(),
            );
        }
        let yaml = if extension == Some("md") {
            split_frontmatter(&raw)?.0
        } else {
            raw.as_str()
        };
        let definition: RunbookFileV3 = serde_yaml::from_str(yaml)
            .map_err(|error| format!("invalid Runbook v1 document: {error}"))?;
        validate_identifier(&definition.id)?;
        if definition.version != 1
            || definition.name.trim().is_empty()
            || definition.description.trim().is_empty()
            || definition.steps.is_empty()
            || definition.success_criteria.is_empty()
            || definition.rollback.is_empty()
        {
            return Err("Runbook is outside the M3 v1 bounds".into());
        }
        let mut parameter_names = HashSet::new();
        for parameter in &definition.parameters {
            validate_identifier(&parameter.name)?;
            if !parameter_names.insert(&parameter.name) {
                return Err("Runbook contains duplicate parameters".into());
            }
        }
        for step in definition.prechecks.iter().chain(definition.steps.iter()) {
            validate_identifier(&step.id)?;
            validate_required_tools(
                &step.required_tools,
                &[AgentTargetKindV3::Local, AgentTargetKindV3::Remote],
                registry,
            )?;
        }
        let catalog = RunbookCatalogEntryV3 {
            id: definition.id.clone(),
            name: definition.name.clone(),
            description: definition.description.clone(),
            version: definition.version,
            parameters: definition.parameters.clone(),
            step_count: definition.prechecks.len() + definition.steps.len(),
        };
        if runbooks
            .insert(
                definition.id.clone(),
                StoredRunbookV3 {
                    catalog,
                    definition,
                },
            )
            .is_some()
        {
            return Err("duplicate Runbook id".into());
        }
    }
    Ok(runbooks)
}

fn validate_required_tools(
    tools: &[String],
    targets: &[AgentTargetKindV3],
    registry: &ToolRegistryV3,
) -> Result<(), String> {
    if tools.is_empty() || targets.is_empty() {
        return Err("extension tool and target declarations cannot be empty".into());
    }
    let mut unique = HashSet::new();
    for name in tools {
        if !unique.insert(name) {
            return Err("extension declares a duplicate required tool".into());
        }
        let tool = registry
            .get(name)
            .map_err(|_| "extension references an unregistered tool".to_string())?;
        if tool.implementation_state != ToolImplementationStateV3::Implemented {
            return Err("extension requires a tool unavailable in the M3 runtime".into());
        }
        if !targets
            .iter()
            .any(|target| tool.descriptor.target_kinds.contains(target))
        {
            return Err("extension required tool does not support its declared targets".into());
        }
    }
    Ok(())
}

fn resolve_parameters(
    declarations: &[RunbookParameterV3],
    supplied: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    if supplied
        .keys()
        .any(|name| !declarations.iter().any(|parameter| &parameter.name == name))
    {
        return Err("Runbook received an undeclared parameter".into());
    }
    let mut resolved = HashMap::new();
    for declaration in declarations {
        let value = supplied
            .get(&declaration.name)
            .cloned()
            .or_else(|| declaration.default.clone());
        match value {
            Some(value)
                if !value.is_empty()
                    && value.len() <= 1_024
                    && !value.contains(['\0', '\r', '\n']) =>
            {
                resolved.insert(declaration.name.clone(), value);
            }
            Some(_) => return Err("Runbook parameter is outside the native bound".into()),
            None if declaration.required => {
                return Err(format!(
                    "Runbook parameter {} is required",
                    declaration.name
                ))
            }
            None => {}
        }
    }
    Ok(resolved)
}

fn substitute_parameters(
    value: &str,
    parameters: &HashMap<String, String>,
) -> Result<String, String> {
    let mut output = value.to_string();
    for (name, replacement) in parameters {
        output = output.replace(&format!("${{{name}}}"), replacement);
    }
    if output.contains("${") {
        return Err("Runbook contains an unresolved parameter reference".into());
    }
    Ok(output)
}

fn read_optional_directory(
    root: &Path,
    directory: &Path,
) -> Result<Option<Vec<fs::DirEntry>>, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("extension directory must be a real directory".into());
            }
            ensure_contained(root, directory)?;
            let mut entries = fs::read_dir(directory)
                .map_err(|error| format!("failed to read extension directory: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("failed to inspect extension entry: {error}"))?;
            entries.sort_by_key(fs::DirEntry::file_name);
            Ok(Some(entries))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect extension directory: {error}")),
    }
}

fn read_optional_extension_file(root: &Path, path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("extension file must be a real regular file".into());
            }
            if metadata.len() > MAX_EXTENSION_FILE_BYTES {
                return Err("extension file exceeded the native size limit".into());
            }
            ensure_contained(root, path)?;
            fs::read_to_string(path)
                .map(Some)
                .map_err(|error| format!("failed to read extension file as UTF-8: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to inspect extension file: {error}")),
    }
}

fn validate_workspace_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("failed to inspect extension workspace root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("extension workspace root must be a real directory".into());
    }
    let canonical = fs::canonicalize(root)
        .map_err(|error| format!("failed to canonicalize extension workspace: {error}"))?;
    if canonical.parent().is_none() {
        return Err("filesystem roots cannot be extension workspaces".into());
    }
    Ok(canonical)
}

fn ensure_contained(root: &Path, path: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("failed to canonicalize extension path: {error}"))?;
    if canonical == root || !canonical.starts_with(root) {
        return Err("extension path escaped the frozen workspace".into());
    }
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| "extension path escaped the frozen workspace".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("extension path contains a forbidden component".into());
        }
        current.push(component.as_os_str());
        if fs::symlink_metadata(&current)
            .map_err(|error| format!("failed to inspect extension path component: {error}"))?
            .file_type()
            .is_symlink()
        {
            return Err("symlinked extension paths are rejected".into());
        }
    }
    Ok(())
}

fn split_frontmatter(value: &str) -> Result<(&str, &str), String> {
    let normalized = value.strip_prefix('\u{feff}').unwrap_or(value);
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Err("Markdown extension requires YAML frontmatter".into());
    };
    let Some(index) = rest.find("\n---\n") else {
        return Err("Markdown extension frontmatter is not terminated".into());
    };
    Ok((&rest[..index], &rest[index + 5..]))
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("extension identifier is invalid".into());
    }
    Ok(())
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_contract_v3::{AgentPermissionModeV3, AgentRequestSourceV3};

    fn request(root: &Path) -> AgentRequestV3 {
        AgentRequestV3 {
            contract_version: 3,
            request_id: "req-ext".into(),
            user_session_id: "user-ext".into(),
            task_id: "task-ext".into(),
            goal: "test extensions".into(),
            success_criteria: vec!["safe".into()],
            targets: vec![AgentToolTargetV3::Local {
                target_id: "local-ext".into(),
                session_id: "session-ext".into(),
                cwd: Some(root.to_string_lossy().to_string()),
            }],
            permission_mode: AgentPermissionModeV3::RequestApproval,
            source_contract: AgentRequestSourceV3::V3,
        }
    }

    fn write_fixture(root: &Path) {
        fs::create_dir_all(root.join(".shellspan/skills/inspect")).unwrap();
        fs::create_dir_all(root.join(".shellspan/runbooks")).unwrap();
        fs::write(
            root.join(".shellspan/skills/inspect/SKILL.md"),
            "---\nversion: 1\nname: Inspect\ndescription: Inspect safely\nrequiredTools: [read_file]\ntargets: [local]\npermissions: [sensitiveRead]\n---\nRead only the requested file.",
        ).unwrap();
        fs::write(
            root.join(".shellspan/hooks.json"),
            r#"{"version":1,"hooks":[{"id":"limit-output","event":"beforeTool","mode":"sync","action":"modify","tool":"read_file","argumentOverrides":{"maxBytes":1024}}]}"#,
        ).unwrap();
        fs::write(
            root.join(".shellspan/runbooks/inspect.yaml"),
            r#"version: 1
id: inspect-config
name: Inspect config
description: Read and verify a config
parameters:
  - name: path
    required: true
prechecks:
  - id: precheck
    description: Check ${path}
    requiredTools: [read_file]
    expectedEffect: sensitiveRead
    successCriteria: [The file is readable]
    rollbackOrCompensation: No change
steps:
  - id: verify
    description: Verify ${path}
    dependencies: [precheck]
    requiredTools: [read_file]
    expectedEffect: sensitiveRead
    successCriteria: [Evidence is recorded]
    rollbackOrCompensation: No change
successCriteria: [Both reads succeed]
rollback: [No mutation was performed]
"#,
        )
        .unwrap();
    }

    #[test]
    fn skills_hooks_and_runbooks_are_progressive_and_never_grant_permissions() {
        let workspace = tempfile::tempdir().unwrap();
        write_fixture(workspace.path());
        let registry = ToolRegistryV3::from_builtin_manifest().unwrap();
        let runtime = ExtensionRuntimeV3::default();
        runtime.register_task(&request(workspace.path())).unwrap();
        let snapshot = runtime.refresh("task-ext", &registry).unwrap();
        assert_eq!(snapshot.skills.len(), 1);
        assert!(!snapshot.skills[0].loaded);
        assert_eq!(snapshot.runbooks.len(), 1);
        let skill = runtime
            .load_skill(
                LoadSkillRequestV3 {
                    task_id: "task-ext".into(),
                    skill_id: "inspect".into(),
                    target_id: "local-ext".into(),
                },
                &registry,
            )
            .unwrap();
        assert!(skill.instruction_eligible);
        assert!(!skill.grants_permissions);
        let applied = runtime
            .apply_before_tool(
                "task-ext",
                "read_file",
                &serde_json::json!({"path":"config.toml","encoding":"utf8"}),
            )
            .unwrap();
        assert_eq!(applied.effective_arguments["maxBytes"], 1024);
        assert!(applied.decisions[0].summary.contains("revalidation"));
        let plan = runtime
            .instantiate_runbook(
                InstantiateRunbookRequestV3 {
                    task_id: "task-ext".into(),
                    runbook_id: "inspect-config".into(),
                    target_id: "local-ext".into(),
                    parameters: HashMap::from([("path".into(), "config.toml".into())]),
                },
                0,
                &registry,
            )
            .unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert!(plan
            .explanation
            .unwrap()
            .contains("without granting permissions"));
    }

    #[test]
    fn skill_target_mismatch_and_hook_deny_fail_closed() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join(".shellspan/skills/remote")).unwrap();
        fs::write(
            workspace.path().join(".shellspan/skills/remote/SKILL.md"),
            "---\nversion: 1\nname: Remote\ndescription: Remote only\nrequiredTools: [read_file]\ntargets: [remote]\npermissions: [sensitiveRead]\n---\nInspect.",
        ).unwrap();
        fs::write(
            workspace.path().join(".shellspan/hooks.json"),
            r#"{"version":1,"hooks":[{"id":"deny-exec","event":"beforeTool","mode":"sync","action":"deny","tool":"exec_command","reason":"blocked"}]}"#,
        ).unwrap();
        let registry = ToolRegistryV3::from_builtin_manifest().unwrap();
        let runtime = ExtensionRuntimeV3::default();
        runtime.register_task(&request(workspace.path())).unwrap();
        runtime.refresh("task-ext", &registry).unwrap();
        assert!(runtime
            .load_skill(
                LoadSkillRequestV3 {
                    task_id: "task-ext".into(),
                    skill_id: "remote".into(),
                    target_id: "local-ext".into()
                },
                &registry,
            )
            .is_err());
        assert!(runtime
            .apply_before_tool("task-ext", "exec_command", &serde_json::json!({}))
            .unwrap_err()
            .contains("denied"));
    }
}
