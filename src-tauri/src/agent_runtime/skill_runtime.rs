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
    use super::*;
    fn target(root: &std::path::Path) -> super::super::AgentSessionTarget {
        super::super::AgentSessionTarget {
            kind: "local".into(),
            target_id: "target".into(),
            session_id: "terminal".into(),
            label: None,
            profile_id: None,
            host: None,
            port: None,
            username: None,
            cwd: Some(
                std::fs::canonicalize(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into(),
            ),
            root_path: None,
            local_root: None,
        }
    }
    fn write(root: &std::path::Path, path: &str, name: &str, extra: &str) {
        let path = root.join(".agents/skills").join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!("---\nname: {name}\ndescription: useful\n{extra}---\ncomplete instructions\n"),
        )
        .unwrap();
    }
    fn read(root: &std::path::Path, expected_scope: Option<SkillScope>) -> SkillReadResult {
        read_local(SkillReadRequest {
            target: target(root),
            expected_scope,
            cancellation: CancellationToken::new(),
        })
    }
    #[test]
    fn skill_real_local_discovery_duplicates_shadcn_and_shallow_scope() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "a.md",
            "same",
            "disable-model-invocation: true\n",
        );
        write(root.path(), "z/SKILL.md", "same", "");
        write(root.path(), "nested/deeper/SKILL.md", "hidden", "");
        let shadcn = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.agents/skills/shadcn/SKILL.md");
        std::fs::copy(shadcn, root.path().join(".agents/skills/shadcn.md")).unwrap();
        let result = read(root.path(), None);
        assert_eq!(result.observation.status, SkillObservationStatus::Complete);
        assert_eq!(result.definitions.len(), 2);
        assert!(!result.definitions[0].entry.model_invocable);
        assert!(result
            .observation
            .diagnostics
            .iter()
            .any(|d| d.code == "shadowed" && d.message.contains("a.md")));
        assert!(result
            .observation
            .diagnostics
            .iter()
            .any(|d| d.code == "unknownMetadata"));
    }
    #[test]
    fn skill_refresh_empty_rebuild_body_and_root_drift() {
        let root = tempfile::tempdir().unwrap();
        let first = read(root.path(), None);
        assert_eq!(first.observation.status, SkillObservationStatus::Complete);
        let scope = first.observation.snapshot.unwrap().scope;
        write(root.path(), "one.md", "one", "");
        let second = read(root.path(), Some(scope.clone()));
        assert_eq!(second.definitions.len(), 1);
        std::fs::write(root.path().join("ordinary-file"), "normal work").unwrap();
        assert_eq!(
            read(root.path(), Some(scope.clone())).observation.status,
            SkillObservationStatus::Complete
        );
        std::fs::remove_dir_all(root.path().join(".agents/skills")).unwrap();
        assert_eq!(read(root.path(), Some(scope.clone())).definitions.len(), 0);
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            read(other.path(), Some(scope)).observation.status,
            SkillObservationStatus::Unavailable
        );
    }
    #[test]
    fn skill_local_symlinks_limits_and_cancellation_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "one.md", "one", "");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("link")).unwrap();
            let mut t = target(root.path());
            t.cwd = Some(root.path().join("link").to_str().unwrap().into());
            assert_eq!(
                read_local(SkillReadRequest {
                    target: t,
                    expected_scope: None,
                    cancellation: CancellationToken::new()
                })
                .observation
                .status,
                SkillObservationStatus::Unavailable
            );
        }
        std::fs::write(
            root.path().join(".agents/skills/one.md"),
            vec![b'x'; MAX_SKILL_FILE + 1],
        )
        .unwrap();
        assert_eq!(
            read(root.path(), None).observation.status,
            SkillObservationStatus::Incomplete
        );
        let token = CancellationToken::new();
        token.cancel();
        let r = read_local(SkillReadRequest {
            target: target(root.path()),
            expected_scope: None,
            cancellation: token,
        });
        assert_eq!(r.observation.status, SkillObservationStatus::Incomplete);
        let mut remote = target(root.path());
        remote.kind = "remote".into();
        remote.local_root = remote.cwd.clone();
        assert!(read_local(SkillReadRequest {
            target: remote,
            expected_scope: None,
            cancellation: CancellationToken::new()
        })
        .definitions
        .is_empty());
    }
    #[test]
    fn skill_partial_enumeration_permission_deadline_and_total_limits_are_incomplete() {
        use std::cell::Cell;
        struct Failing {
            local: LocalScopedReader,
            mode: u8,
            lists: Cell<usize>,
        }
        impl ScopedReader for Failing {
            fn root(&self) -> &str {
                self.local.root()
            }
            fn identity(&self) -> &str {
                self.local.identity()
            }
            fn check_root(&self) -> Result<(), ScopeReadError> {
                self.local.check_root()
            }
            fn list(
                &self,
                p: &str,
                n: usize,
                c: &ReadControl,
            ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
                self.lists.set(self.lists.get() + 1);
                if self.mode == 0 || self.mode == 3 && self.lists.get() > 1 {
                    Err(ScopeReadError::Io)
                } else {
                    self.local.list(p, n, c)
                }
            }
            fn read(&self, p: &str, n: usize, c: &ReadControl) -> Result<Vec<u8>, ScopeReadError> {
                match self.mode {
                    1 => Err(ScopeReadError::Io),
                    2 => Err(ScopeReadError::Denied),
                    _ => self.local.read(p, n, c),
                }
            }
        }
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "one.md", "one", "");
        let request = SkillReadRequest {
            target: target(root.path()),
            expected_scope: None,
            cancellation: CancellationToken::new(),
        };
        for mode in 0..5 {
            let reader = Failing {
                local: LocalScopedReader::open(request.target.cwd.as_deref().unwrap()).unwrap(),
                mode,
                lists: Cell::new(0),
            };
            let control = ReadControl {
                cancellation: CancellationToken::new(),
                deadline: Instant::now()
                    + if mode == 4 {
                        Duration::ZERO
                    } else {
                        Duration::from_secs(5)
                    },
            };
            let result = discover(&reader, &request, &control);
            assert_eq!(
                result.observation.status,
                SkillObservationStatus::Incomplete
            );
            assert!(result.observation.snapshot.is_none());
        }
        for count in [64, 65] {
            let total = tempfile::tempdir().unwrap();
            let directory = total.path().join(".agents/skills");
            std::fs::create_dir_all(&directory).unwrap();
            for i in 0..count {
                let mut bytes =
                    format!("---\nname: skill-{i}\ndescription: short\n---\n").into_bytes();
                bytes.resize(MAX_SKILL_FILE, b'x');
                std::fs::write(directory.join(format!("{i}.md")), bytes).unwrap();
            }
            assert_eq!(
                read(total.path(), None).observation.status,
                if count == 64 {
                    SkillObservationStatus::Complete
                } else {
                    SkillObservationStatus::Incomplete
                }
            );
        }
        for (count, files) in [(256, true), (257, true), (1024, false), (1025, false)] {
            let many = tempfile::tempdir().unwrap();
            let directory = many.path().join(".agents/skills");
            std::fs::create_dir_all(&directory).unwrap();
            for i in 0..count {
                if files {
                    write(many.path(), &format!("{i}.md"), &format!("s-{i}"), "");
                } else {
                    std::fs::create_dir(directory.join(i.to_string())).unwrap();
                }
            }
            assert_eq!(
                read(many.path(), None).observation.status,
                if count == 256 || count == 1024 {
                    SkillObservationStatus::Complete
                } else {
                    SkillObservationStatus::Incomplete
                }
            );
        }
    }
}
