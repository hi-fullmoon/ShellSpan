//! Path-only discovery. One live directory per query; no content reads or background index.
use super::{
    native::scoped_read::*, skills::SkillScope, AgentSessionEventPayload, AgentSessionStore,
    AgentSessionTarget, NativeToolRuntime,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_ENTRIES: usize = 1024;
pub(crate) const MAX_RESULTS: usize = 40;
pub(crate) const MAX_PATH: usize = 2048;
pub(crate) const MAX_DEPTH: usize = 32;
pub(crate) const MAX_BYTES: usize = 64 * 1024;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileReferenceInput {
    pub(crate) session_id: String,
    pub(crate) request_id: String,
    pub(crate) query: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileReferenceCancel {
    pub(crate) session_id: String,
    pub(crate) request_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileCandidate {
    pub(crate) path: String,
    pub(crate) kind: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReferenceList {
    pub(crate) entries: Vec<FileCandidate>,
    pub(crate) scope: Option<SkillScope>,
    pub(crate) status: String,
    pub(crate) code: Option<String>,
    pub(crate) excluded: usize,
}
impl FileReferenceList {
    pub(crate) fn failed(code: impl Into<String>) -> Self {
        Self {
            entries: vec![],
            scope: None,
            status: "error".into(),
            code: Some(code.into()),
            excluded: 0,
        }
    }
}
pub(crate) struct FileReferenceRequest {
    pub(crate) target: AgentSessionTarget,
    pub(crate) expected_scope: Option<SkillScope>,
    pub(crate) query: String,
    pub(crate) cancellation: CancellationToken,
    pub(crate) deadline: Instant,
}
pub(crate) fn bound_scope(event: &super::AgentSessionEvent) -> Option<&SkillScope> {
    match &event.payload {
        AgentSessionEventPayload::FileReferenceScopeBound { scope } => Some(scope),
        AgentSessionEventPayload::SkillCatalogObserved { observation } => observation
            .snapshot
            .as_ref()
            .map(|s| &s.scope)
            .filter(|scope| !super::builtin_skills::is_builtin_scope(scope)),
        _ => None,
    }
}
fn representable(path: &str) -> bool {
    !path.chars().any(|c| {
        c.is_control() || c == '"' || c == '\\' || c == ':' || matches!(c, '\u{2028}' | '\u{2029}')
    })
}
pub(crate) fn query_parts(query: &str) -> Result<(&str, &str), ScopeReadError> {
    if query.len() > MAX_PATH
        || !representable(query)
        || query.starts_with('/')
        || query.split('/').count() > MAX_DEPTH
    {
        return Err(ScopeReadError::Denied);
    }
    let (directory, prefix) = query.rsplit_once('/').unwrap_or(("", query));
    if query
        .split('/')
        .enumerate()
        .any(|(i, p)| p == "." || p == ".." || (p.is_empty() && i + 1 != query.split('/').count()))
    {
        return Err(ScopeReadError::Denied);
    }
    Ok((directory, prefix))
}
pub(crate) fn discover(
    reader: &dyn ScopedReader,
    request: &FileReferenceRequest,
) -> FileReferenceList {
    let run = || -> Result<FileReferenceList, ScopeReadError> {
        let control = ReadControl {
            cancellation: request.cancellation.clone(),
            deadline: request.deadline,
        };
        control.check()?;
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
            return Err(ScopeReadError::Drift);
        }
        reader.check_root()?;
        let (directory, prefix) = query_parts(&request.query)?;
        // An over-budget enumeration is an explicit refusal; never return an arbitrary OS-order prefix.
        let entries = reader.list_paths(directory, MAX_ENTRIES, &control)?;
        let mut result = FileReferenceList {
            entries: vec![],
            scope: Some(scope),
            status: "ready".into(),
            code: None,
            excluded: 0,
        };
        let mut bytes = 0;
        for entry in entries {
            control.check()?;
            let path = if directory.is_empty() {
                entry.name.clone()
            } else {
                format!("{directory}/{}", entry.name)
            };
            if (!entry.directory && !entry.file)
                || !representable(&entry.name)
                || entry.name.contains('/')
                || path.len() > MAX_PATH
                || entry.name == "."
                || entry.name == ".."
            {
                result.excluded += 1;
                continue;
            }
            if !entry
                .name
                .to_lowercase()
                .starts_with(&prefix.to_lowercase())
            {
                continue;
            }
            bytes += path.len();
            if bytes > MAX_BYTES {
                return Err(ScopeReadError::Limit);
            }
            result.entries.push(FileCandidate {
                path,
                kind: if entry.directory { "directory" } else { "file" }.into(),
            });
        }
        // Directories first, then UTF-8 lexical order. No locale or filesystem-order dependency.
        result
            .entries
            .sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.path.cmp(&b.path)));
        if result.entries.len() > MAX_RESULTS {
            result.status = "truncated".into();
            result.entries.truncate(MAX_RESULTS);
        }
        reader.check_root()?;
        control.check()?;
        Ok(result)
    };
    run().unwrap_or_else(|e| FileReferenceList::failed(e.to_string()))
}
pub(crate) fn read_local(request: FileReferenceRequest) -> FileReferenceList {
    if request.target.kind != "local" {
        return FileReferenceList::failed("Unavailable");
    }
    let Some(root) = request.target.cwd.as_deref() else {
        return FileReferenceList::failed("RootRequired");
    };
    match LocalScopedReader::open(root) {
        Ok(reader) => discover(&reader, &request),
        Err(e) => FileReferenceList::failed(e.to_string()),
    }
}
struct QueryLease {
    id: String,
    token: CancellationToken,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
}
impl Drop for QueryLease {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(&self.id);
        }
    }
}
struct Operation {
    session: String,
    token: CancellationToken,
    created: Instant,
    running: bool,
}
#[derive(Clone)]
pub(crate) struct FileReferenceRuntime {
    sessions: AgentSessionStore,
    native: Arc<dyn NativeToolRuntime>,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
    permits: Arc<tokio::sync::Semaphore>,
}
impl FileReferenceRuntime {
    pub(crate) fn new(sessions: AgentSessionStore, native: Arc<dyn NativeToolRuntime>) -> Self {
        Self {
            sessions,
            native,
            operations: Arc::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
    fn validate_ids(session: &str, request: &str) -> Result<(), String> {
        if session.is_empty() || session.len() > 256 || uuid::Uuid::parse_str(request).is_err() {
            return Err("InvalidRequest".into());
        }
        Ok(())
    }
    pub(crate) fn cancel(&self, input: FileReferenceCancel) -> Result<(), String> {
        Self::validate_ids(&input.session_id, &input.request_id)?;
        self.sessions.snapshot(&input.session_id)?;
        let mut operations = self.operations.lock().map_err(|_| "Unavailable")?;
        operations.retain(|_, op| op.running || op.created.elapsed() < Duration::from_secs(30));
        if let Some(op) = operations.get(&input.request_id) {
            if op.session != input.session_id {
                return Err("InvalidRequest".into());
            }
            op.token.cancel();
        } else {
            if operations.len() >= 256 {
                return Err("Busy".into());
            }
            let token = CancellationToken::new();
            token.cancel();
            // Cancellation can arrive before list IPC; keep a bounded, expiring tombstone.
            operations.insert(
                input.request_id,
                Operation {
                    session: input.session_id,
                    token,
                    created: Instant::now(),
                    running: false,
                },
            );
        }
        Ok(())
    }
    pub(crate) async fn list(
        &self,
        input: FileReferenceInput,
    ) -> Result<FileReferenceList, String> {
        Self::validate_ids(&input.session_id, &input.request_id)?;
        query_parts(&input.query).map_err(|e| e.to_string())?;
        let header = self.sessions.snapshot(&input.session_id)?.header;
        let target = header.target.ok_or("RootRequired")?;
        if !matches!(target.kind.as_str(), "local" | "remote")
            || header.capability_scope.is_some_and(|s| {
                !s.effects.contains(&super::AgentSessionEffect::ReadOnly)
                    || !s.target_ids.contains(&target.target_id)
                    || !s
                        .tool_names
                        .iter()
                        .any(|n| n == "list_directory" || n == "read_file")
            })
        {
            return Err("Unavailable".into());
        }
        let cancellation = CancellationToken::new();
        {
            let mut operations = self.operations.lock().map_err(|_| "Unavailable")?;
            operations.retain(|_, op| op.running || op.created.elapsed() < Duration::from_secs(30));
            if let Some(op) = operations.get(&input.request_id) {
                if op.session != input.session_id {
                    return Err("InvalidRequest".into());
                }
                return Err(if op.token.is_cancelled() {
                    "Cancelled"
                } else {
                    "InvalidRequest"
                }
                .into());
            }
            if operations.len() >= 256 {
                return Err("Busy".into());
            }
            operations.insert(
                input.request_id.clone(),
                Operation {
                    session: input.session_id.clone(),
                    token: cancellation.clone(),
                    created: Instant::now(),
                    running: true,
                },
            );
        }
        let _lease = QueryLease {
            id: input.request_id.clone(),
            token: cancellation.clone(),
            operations: self.operations.clone(),
        };
        self.run(&input, target, cancellation).await
    }
    async fn run(
        &self,
        input: &FileReferenceInput,
        target: AgentSessionTarget,
        cancellation: CancellationToken,
    ) -> Result<FileReferenceList, String> {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Busy")?;
        let expected_scope = self
            .sessions
            .all_events(&input.session_id)?
            .iter()
            .find_map(bound_scope)
            .cloned();
        let request = FileReferenceRequest {
            target,
            expected_scope: expected_scope.clone(),
            query: input.query.clone(),
            cancellation: cancellation.clone(),
            deadline: Instant::now() + TIMEOUT,
        };
        let native = self.native.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            native.list_file_references(request)
        })
        .await
        .map_err(|_| "Unavailable")?;
        if cancellation.is_cancelled() {
            return Err("Cancelled".into());
        }
        if let Some(scope) = &result.scope {
            if expected_scope.is_none() {
                // Session-store validation serializes competing first observations and pins identity durably.
                self.sessions.append(
                    &input.session_id,
                    None,
                    None,
                    AgentSessionEventPayload::FileReferenceScopeBound {
                        scope: scope.clone(),
                    },
                )?;
            }
        }
        Ok(result)
    }
}
