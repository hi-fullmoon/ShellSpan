use super::{
    native::scoped_read::*, skills::*, AgentEntry, AgentSessionEffect, AgentSessionEventPayload,
    AgentSessionHeader, AgentSessionStore,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(crate) struct SkillReadRequest {
    pub(crate) target: super::AgentSessionTarget,
    pub(crate) expected_scope: Option<SkillScope>,
    pub(crate) cancellation: CancellationToken,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillReadResult {
    pub(crate) observation: SkillObservation,
    pub(crate) definitions: Vec<SkillDefinition>,
}
impl SkillReadResult {
    pub(crate) fn failed(error: ScopeReadError) -> Self {
        Self {
            definitions: Vec::new(),
            observation: SkillObservation {
                protocol_version: SKILL_PROTOCOL,
                status: if matches!(
                    error,
                    ScopeReadError::Drift | ScopeReadError::Denied | ScopeReadError::Unavailable
                ) {
                    SkillObservationStatus::Unavailable
                } else {
                    SkillObservationStatus::Incomplete
                },
                snapshot: None,
                diagnostics: vec![SkillDiagnostic::new(
                    ".agents/skills",
                    "readFailure",
                    error.to_string(),
                )],
            },
        }
    }
    pub(crate) fn unavailable(reason: &str) -> Self {
        Self {
            definitions: Vec::new(),
            observation: SkillObservation {
                protocol_version: SKILL_PROTOCOL,
                status: SkillObservationStatus::Unavailable,
                snapshot: None,
                diagnostics: vec![SkillDiagnostic::new("", "unavailable", reason)],
            },
        }
    }
}

pub(crate) fn discover(
    reader: &dyn ScopedReader,
    request: &SkillReadRequest,
    control: &ReadControl,
) -> SkillReadResult {
    let scope = SkillScope {
        target: request.target.clone(),
        root: reader.root().into(),
        root_identity: reader.identity().into(),
    };
    if request
        .expected_scope
        .as_ref()
        .is_some_and(|expected| expected != &scope)
    {
        return SkillReadResult::failed(ScopeReadError::Drift);
    }
    let run = || -> Result<SkillReadResult, ScopeReadError> {
        control.check()?;
        reader.check_root()?;
        let entries = match reader.list(".agents/skills", MAX_SKILL_ENTRIES, control) {
            Ok(entries) => entries,
            Err(ScopeReadError::Absent) => Vec::new(),
            Err(e) => return Err(e),
        };
        let mut paths = Vec::new();
        for entry in &entries {
            if entry.directory {
                paths.push(format!(".agents/skills/{}/SKILL.md", entry.name));
            } else if entry.file && entry.name.ends_with(".md") {
                paths.push(format!(".agents/skills/{}", entry.name));
            }
        }
        paths.sort();
        let mut definitions = Vec::new();
        let mut diagnostics = Vec::new();
        let mut names = BTreeSet::new();
        let mut total = 0;
        for path in paths {
            let bytes = match reader.read(&path, MAX_SKILL_FILE, control) {
                Ok(bytes) => bytes,
                Err(ScopeReadError::Absent) if path.ends_with("/SKILL.md") => continue,
                Err(e) => return Err(e),
            };
            total += bytes.len();
            if total > MAX_SKILL_READ {
                return Err(ScopeReadError::Limit);
            }
            match parse_skill(&path, &bytes) {
                Ok((definition, mut notes)) => {
                    diagnostics.append(&mut notes);
                    if names.insert(definition.entry.name.clone()) {
                        definitions.push(definition);
                        if definitions.len() > MAX_SKILLS {
                            return Err(ScopeReadError::Limit);
                        }
                    } else {
                        let winner = definitions
                            .iter()
                            .find(|d| d.entry.name == definition.entry.name)
                            .expect("winner");
                        diagnostics.push(SkillDiagnostic::new(
                            &path,
                            "shadowed",
                            format!("first path wins: {}", winner.entry.relative_path),
                        ));
                    }
                }
                Err(message) => diagnostics.push(SkillDiagnostic::new(&path, "malformed", message)),
            }
            if diagnostics.len() > MAX_SKILL_ENTRIES
                || serde_json::to_vec(&diagnostics)
                    .map_err(|_| ScopeReadError::Limit)?
                    .len()
                    > 32 * 1024
            {
                return Err(ScopeReadError::Limit);
            }
        }
        // No partial replacement if enumeration changed while reading files.
        let after = match reader.list(".agents/skills", MAX_SKILL_ENTRIES, control) {
            Ok(e) => e,
            Err(ScopeReadError::Absent) => Vec::new(),
            Err(e) => return Err(e),
        };
        if entries != after {
            return Err(ScopeReadError::Io);
        }
        reader.check_root()?;
        control.check()?;
        definitions.sort_by(|a, b| a.entry.name.cmp(&b.entry.name));
        let snapshot = SkillSnapshot::new(scope.clone(), &definitions);
        if unchanged_by_redaction(&snapshot).is_err() {
            return Err(ScopeReadError::Denied);
        }
        let observation = SkillObservation {
            protocol_version: SKILL_PROTOCOL,
            status: SkillObservationStatus::Complete,
            snapshot: Some(snapshot),
            diagnostics,
        };
        // Leave room for the durable event envelope; never publish a partial catalogue.
        if serde_json::to_vec(&observation)
            .map_err(|_| ScopeReadError::Limit)?
            .len()
            > 192 * 1024
        {
            return Err(ScopeReadError::Limit);
        }
        Ok(SkillReadResult {
            observation,
            definitions,
        })
    };
    run().unwrap_or_else(|error| {
        let mut result = SkillReadResult::failed(error);
        // A denied Skills entry is a failed observation, not revocation of the root.
        if error == ScopeReadError::Denied {
            result.observation.status = SkillObservationStatus::Incomplete;
        }
        result
    })
}

pub(crate) fn read_local(request: SkillReadRequest) -> SkillReadResult {
    if request.target.kind != "local" {
        return SkillReadResult::unavailable("remote Skills require configured native provider");
    }
    let Some(root) = request.target.cwd.as_deref() else {
        return SkillReadResult::unavailable("frozen local root is absent");
    };
    let reader = match LocalScopedReader::open(root) {
        Ok(r) => r,
        Err(e) => return SkillReadResult::failed(e),
    };
    let control = ReadControl {
        cancellation: request.cancellation.clone(),
        deadline: Instant::now() + Duration::from_secs(15),
    };
    discover(&reader, &request, &control)
}

pub(crate) fn scope_enabled(header: &AgentSessionHeader) -> bool {
    let Some(target) = &header.target else {
        return false;
    };
    matches!(target.kind.as_str(), "local" | "remote")
        && header.capability_scope.as_ref().is_none_or(|scope| {
            scope.tool_names.iter().any(|n| n == SKILL_TOOL)
                && scope.effects.contains(&AgentSessionEffect::ReadOnly)
                && scope.target_ids.contains(&target.target_id)
        })
}

#[derive(Clone)]
pub(crate) struct SkillRuntime {
    sessions: AgentSessionStore,
    native: Arc<dyn super::NativeToolRuntime>,
}
impl SkillRuntime {
    pub(crate) fn new(
        sessions: AgentSessionStore,
        native: Arc<dyn super::NativeToolRuntime>,
    ) -> Self {
        Self { sessions, native }
    }
    async fn observe(
        &self,
        session_id: &str,
        cancellation: CancellationToken,
    ) -> Result<SkillReadResult, String> {
        let header = self.sessions.snapshot(session_id)?.header;
        if !scope_enabled(&header) {
            let result = SkillReadResult::unavailable(
                "Skills are outside the frozen target or capability scope",
            );
            self.sessions.append(
                session_id,
                None,
                None,
                AgentSessionEventPayload::SkillCatalogObserved {
                    observation: result.observation.clone(),
                },
            )?;
            return Ok(result);
        }
        let events = self.sessions.all_events(session_id)?;
        // Root identity stays pinned across refreshes, including empty directories and retirement.
        let expected_scope = events
            .iter()
            .find_map(super::file_references::bound_scope)
            .cloned();
        let request = SkillReadRequest {
            target: header.target.expect("validated target"),
            expected_scope,
            cancellation: cancellation.clone(),
        };
        let native = self.native.clone();
        let root = if request.target.kind == "local" {
            request.target.cwd.as_deref()
        } else {
            request.target.root_path.as_deref()
        };
        // Always join native work, also on cancellation. No detached I/O thread may outlive a load.
        let mut result = if root.is_none_or(|root| root.trim().is_empty()) {
            let definitions = super::builtin_skills::definitions();
            let snapshot =
                SkillSnapshot::new(super::builtin_skills::scope(request.target), &definitions);
            SkillReadResult {
                observation: SkillObservation {
                    protocol_version: SKILL_PROTOCOL,
                    status: SkillObservationStatus::Complete,
                    snapshot: Some(snapshot),
                    diagnostics: vec![],
                },
                definitions,
            }
        } else {
            tokio::task::spawn_blocking(move || native.read_skills(request))
                .await
                .map_err(|e| format!("Skills provider failed: {e}"))?
        };
        if let Some(snapshot) = &result.observation.snapshot {
            // Existing directory definitions keep precedence for previously bound sessions.
            let names: BTreeSet<_> = result
                .definitions
                .iter()
                .map(|d| d.entry.name.clone())
                .collect();
            result.definitions.extend(
                super::builtin_skills::definitions()
                    .into_iter()
                    .filter(|d| !names.contains(&d.entry.name)),
            );
            result.observation.snapshot = Some(SkillSnapshot::new(
                snapshot.scope.clone(),
                &result.definitions,
            ));
        }
        if cancellation.is_cancelled() {
            return Err("Skills cancelled".into());
        }
        self.sessions.append(
            session_id,
            None,
            None,
            AgentSessionEventPayload::SkillCatalogObserved {
                observation: result.observation.clone(),
            },
        )?;
        Ok(result)
    }
    fn last_good(&self, session_id: &str) -> Result<Option<SkillSnapshot>, String> {
        for event in self.sessions.all_events(session_id)?.iter().rev() {
            if let AgentSessionEventPayload::SkillCatalogObserved { observation } = &event.payload {
                match observation.status {
                    SkillObservationStatus::Complete => return Ok(observation.snapshot.clone()),
                    SkillObservationStatus::Unavailable => return Ok(None),
                    SkillObservationStatus::Incomplete => {}
                }
            }
        }
        Ok(None)
    }
    pub(crate) async fn list(
        &self,
        session_id: &str,
        cancellation: CancellationToken,
    ) -> Result<SkillUserList, String> {
        let observed = self.observe(session_id, cancellation).await?;
        let snapshot = self.last_good(session_id)?;
        Ok(SkillUserList {
            session_id: session_id.into(),
            status: match observed.observation.status {
                SkillObservationStatus::Complete => "fresh",
                SkillObservationStatus::Incomplete => "stale",
                SkillObservationStatus::Unavailable => "unavailable",
            }
            .into(),
            revision: snapshot.as_ref().map(|s| s.snapshot_revision.clone()),
            entries: snapshot
                .into_iter()
                .flat_map(|s| s.entries)
                .filter(|e| e.user_invocable)
                .collect(),
            diagnostics: observed.observation.diagnostics,
        })
    }
    pub(crate) async fn load(
        &self,
        session_id: &str,
        name: &str,
        invocation: SkillInvocationKind,
        message_ids: Vec<String>,
        model_identity: Option<(String, String)>,
        cancellation: CancellationToken,
    ) -> Result<LoadedSkill, String> {
        if !valid_name(name) {
            return Err("invalid Skill name".into());
        }
        let result = self.observe(session_id, cancellation.clone()).await?;
        if result.observation.status != SkillObservationStatus::Complete {
            return Err("current Skill definition is unavailable; historical catalogue does not authorize loading".into());
        }
        let snapshot = result
            .observation
            .snapshot
            .ok_or("Skill snapshot missing")?;
        let definition = result
            .definitions
            .into_iter()
            .find(|d| d.entry.name == name)
            .ok_or("Skill no longer exists")?;
        if !match invocation {
            SkillInvocationKind::Model => definition.entry.model_invocable,
            SkillInvocationKind::User => definition.entry.user_invocable,
        } {
            return Err("Skill invocation is disabled by current definition".into());
        }
        if cancellation.is_cancelled()
            || !scope_enabled(&self.sessions.snapshot(session_id)?.header)
        {
            return Err("Skills cancelled or scope revoked".into());
        }
        let (request_id, call_id) =
            model_identity.map_or((None, None), |(r, c)| (Some(r), Some(c)));
        LoadedSkill::new(
            name.into(),
            definition.instructions,
            SkillProvenance {
                protocol_version: SKILL_PROTOCOL,
                renderer_version: 1,
                provider_identity: if definition.entry.resource_base == "builtin" {
                    super::builtin_skills::PROVIDER.into()
                } else {
                    format!("shellspan.frozen-{}.v1", snapshot.scope.target.kind)
                },
                scope: if definition.entry.resource_base == "builtin" {
                    super::builtin_skills::scope(snapshot.scope.target)
                } else {
                    snapshot.scope
                },
                relative_path: definition.entry.relative_path,
                resource_base: definition.entry.resource_base,
                invocation,
                catalog_revision: snapshot.snapshot_revision,
                file_hash: definition.entry.file_hash,
                instruction_hash: definition.entry.instruction_hash,
                message_ids,
                request_id,
                call_id,
            },
        )
    }
    pub(crate) async fn prepare_step(
        &self,
        entry: &AgentEntry,
        turn_id: &str,
        step_id: &str,
    ) -> Result<(), String> {
        if self
            .sessions
            .all_events(&entry.session_id)?
            .iter()
            .any(|e| {
                e.step_id.as_deref() == Some(step_id)
                    && matches!(
                        e.payload,
                        AgentSessionEventPayload::SkillStepPrepared { .. }
                    )
            })
        {
            return Ok(());
        }
        let messages = self
            .sessions
            .claimed_step(&entry.session_id, step_id)?
            .messages;
        let candidates = slash_candidates(&messages)?;
        self.observe(&entry.session_id, entry.cancellation())
            .await?;
        let snapshot = self.last_good(&entry.session_id)?;
        let catalog = self.publication(&entry.session_id, snapshot.as_ref())?;
        let mut outcomes = Vec::new();
        for (name, message_ids) in candidates {
            let (loaded, error) = if snapshot
                .as_ref()
                .is_some_and(|s| s.entries.iter().any(|e| e.name == name && e.user_invocable))
            {
                match self
                    .load(
                        &entry.session_id,
                        &name,
                        SkillInvocationKind::User,
                        message_ids.clone(),
                        None,
                        entry.cancellation(),
                    )
                    .await
                {
                    Ok(loaded) => (Some(loaded), None),
                    Err(e) => (None, Some(e)),
                }
            } else {
                (
                    None,
                    Some("unknown or user-disabled Skill; text preserved".into()),
                )
            };
            outcomes.push(SkillSlashOutcome {
                name,
                message_ids,
                loaded,
                error,
            });
        }
        let prepared = SkillStepPrepared {
            protocol_version: SKILL_PROTOCOL,
            message_ids: messages
                .iter()
                .filter(|m| direct_skill_input(m))
                .map(|m| m.message_id.clone())
                .collect(),
            catalog,
            outcomes,
        };
        prepared.validate()?;
        if entry.cancellation().is_cancelled() {
            return Err("Skills cancelled before commit".into());
        }
        self.sessions.append(
            &entry.session_id,
            Some(turn_id.into()),
            Some(step_id.into()),
            AgentSessionEventPayload::SkillStepPrepared { prepared },
        )?;
        Ok(())
    }
    pub(crate) fn republish_if_missing(
        &self,
        session_id: &str,
        turn_id: &str,
        step_id: &str,
    ) -> Result<(), String> {
        let snapshot = self.last_good(session_id)?;
        if let Some(catalog) = self.publication(session_id, snapshot.as_ref())? {
            self.sessions.append(
                session_id,
                Some(turn_id.into()),
                Some(step_id.into()),
                AgentSessionEventPayload::SkillCatalogPublished { catalog },
            )?;
        }
        Ok(())
    }
    fn publication(
        &self,
        session_id: &str,
        snapshot: Option<&SkillSnapshot>,
    ) -> Result<Option<SkillCatalogPublication>, String> {
        let state = self.sessions.snapshot(session_id)?;
        let current = SkillCatalogPublication::new(snapshot, scope_enabled(&state.header));
        let previous = state
            .surface
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                super::AgentSurfaceMessage::User { source, .. }
                    if source.producer_id == "shellspan.skills.v1"
                        && source.kind == super::AgentMessageSourceKind::SkillCatalog =>
                {
                    source
                        .metadata
                        .get("digest")
                        .and_then(serde_json::Value::as_str)
                }
                _ => None,
            });
        // A never-available Session does not need an empty Skills advertisement.
        let ever_published = self
            .sessions
            .all_events(session_id)?
            .iter()
            .any(|event| match &event.payload {
                AgentSessionEventPayload::SkillStepPrepared { prepared } => {
                    prepared.catalog.is_some()
                }
                AgentSessionEventPayload::SkillCatalogPublished { .. } => true,
                _ => false,
            });
        if previous == Some(current.model_catalog_digest.as_str())
            || (previous.is_none() && snapshot.is_none() && !ever_published)
        {
            Ok(None)
        } else {
            Ok(Some(current))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillUserList {
    pub(crate) session_id: String,
    pub(crate) status: String,
    pub(crate) revision: Option<String>,
    pub(crate) entries: Vec<SkillEntry>,
    pub(crate) diagnostics: Vec<SkillDiagnostic>,
}

pub(crate) fn resumable_skill_queue(
    events: &[super::AgentSessionEvent],
) -> Option<(String, String, String)> {
    let assistant = events.iter().rev().find(|e| matches!(&e.payload, AgentSessionEventPayload::AssistantMessage { content, .. } if super::assistant_tool_calls(content).iter().any(|c| c.name == SKILL_TOOL)))?;
    let turn = assistant.turn_id.clone()?;
    let step = assistant.step_id.clone()?;
    if events.iter().any(|e| e.seq > assistant.seq && (matches!(e.payload, AgentSessionEventPayload::TurnEnd { .. } | AgentSessionEventPayload::StepStart) || matches!(&e.payload, AgentSessionEventPayload::TaskState { recovery: Some(r), .. } if r.status == super::AgentRecoveryStatus::Required))) { return None; }
    // Native side effects keep their original explicit recovery/approval boundary.
    for event in events
        .iter()
        .filter(|e| e.step_id.as_deref() == Some(&step))
    {
        if let AgentSessionEventPayload::ToolCall { call } = &event.payload {
            if call.name != SKILL_TOOL && events.iter().any(|e| e.step_id.as_deref() == Some(&step) && matches!(&e.payload, AgentSessionEventPayload::ToolApproval { call_id, .. } | AgentSessionEventPayload::ToolExecution { call_id, .. } if call_id == &call.call_id))
                && !events.iter().any(|e| e.step_id.as_deref() == Some(&step) && matches!(&e.payload, AgentSessionEventPayload::ToolResult { call_id, .. } if call_id == &call.call_id)) { return None; }
        }
    }
    let request = events.iter().rev().find_map(|e| {
        if e.step_id.as_deref() == Some(&step) {
            match &e.payload {
                AgentSessionEventPayload::RequestHeader { request_id, .. } => {
                    Some(request_id.clone())
                }
                _ => None,
            }
        } else {
            None
        }
    })?;
    Some((turn, step, request))
}

#[cfg(test)]
mod tests {
    include!("tests/skill_runtime.rs");
}
