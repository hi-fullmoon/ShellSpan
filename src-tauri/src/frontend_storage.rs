use crate::agent_runtime::{
    images::{validate_upload_envelope, ImageUpload},
    CreateAgentSessionRequest,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::State;

pub(crate) const DATABASE_NAME: &str = "frontend-state.db";
const PREFERENCE_KEYS: &[&str] = &[
    "shellspan.focus.split",
    "shellspan.connections.sort",
    "shellspan.update.lastStartupCheckAt",
    "shellspan.aiPanelWidth.terminal",
    "shellspan.aiPanelWidth.workbench",
];

#[derive(Clone)]
pub(crate) struct FrontendStorage(Arc<Mutex<Connection>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum DraftCreate {
    Agent { request: CreateAgentSessionRequest },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftOperation {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_turn_id: Option<String>,
    session_id: String,
    mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    create: Option<DraftCreate>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin_owner: Option<String>,
    owner: String,
    revision: u64,
    text: String,
    images: Vec<ImageUpload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<DraftOperation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftRead {
    keys: Vec<String>,
    recovery_owner: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevisionCheck {
    owner: String,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftCommit {
    checks: Vec<RevisionCheck>,
    writes: Vec<ImageDraft>,
    deletes: Vec<String>,
}

fn validate_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("Invalid frontend storage key".into());
    }
    Ok(())
}

impl ImageDraft {
    fn validate(&self) -> Result<(), String> {
        validate_key(&self.owner)?;
        if let Some(origin) = &self.origin_owner {
            validate_key(origin)?;
        }
        if self.revision == 0
            || self.revision > 9_007_199_254_740_991
            || self.text.len() > 1024 * 1024
        {
            return Err("Invalid image draft revision or text size".into());
        }
        if !self.images.is_empty() {
            validate_upload_envelope(&self.images)?;
        }
        if let Some(operation) = &self.operation {
            validate_key(&operation.id)?;
            validate_key(&operation.session_id)?;
            if let Some(turn) = &operation.target_turn_id {
                validate_key(turn)?;
            }
            if operation
                .created_at_unix_ms
                .is_some_and(|value| value > 9_007_199_254_740_991)
            {
                return Err("Invalid operation timestamp".into());
            }
            if !matches!(operation.mode.as_str(), "start" | "nextTurn" | "nextStep") {
                return Err("Invalid image submission mode".into());
            }
            if let Some(DraftCreate::Agent { request }) = &operation.create {
                if request.session_id != operation.session_id {
                    return Err("IMAGE_OPERATION_MISMATCH".into());
                }
            }
        }
        Ok(())
    }
}

impl FrontendStorage {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let connection = Connection::open(root.join(DATABASE_NAME)).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS ui_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS image_drafts (
                owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, session_id TEXT,
                origin_owner TEXT, value TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS image_drafts_session ON image_drafts(session_id);
            CREATE INDEX IF NOT EXISTS image_drafts_origin ON image_drafts(origin_owner);",
            )
            .map_err(|e| e.to_string())?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub(crate) fn preferences(&self) -> Result<Vec<(String, String)>, String> {
        let connection = self.0.lock().map_err(|_| "Frontend storage unavailable")?;
        let mut statement = connection
            .prepare("SELECT key,value FROM ui_preferences ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub(crate) fn save_preferences(&self, entries: Vec<(String, String)>) -> Result<(), String> {
        if entries.len() > PREFERENCE_KEYS.len()
            || entries
                .iter()
                .any(|(key, value)| !PREFERENCE_KEYS.contains(&key.as_str()) || value.len() > 128)
        {
            return Err("Invalid frontend preference".into());
        }
        let mut connection = self.0.lock().map_err(|_| "Frontend storage unavailable")?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        for (key, value) in entries {
            transaction.execute("INSERT INTO ui_preferences VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value]).map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    pub(crate) fn read(&self, input: DraftRead) -> Result<Vec<ImageDraft>, String> {
        if input.keys.len() > 8 {
            return Err("Too many draft keys".into());
        }
        let connection = self.0.lock().map_err(|_| "Frontend storage unavailable")?;
        let mut records = BTreeMap::new();
        for key in input.keys {
            validate_key(&key)?;
            let raw: Option<String> = connection
                .query_row(
                    "SELECT value FROM image_drafts WHERE owner=?1",
                    [key.clone()],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(raw) = raw {
                records.insert(
                    key,
                    serde_json::from_str(&raw).map_err(|_| "Invalid stored image draft")?,
                );
            }
        }
        if let Some(owner) = input.recovery_owner {
            validate_key(&owner)?;
            let (query, key) = if let Some(session) = owner.strip_prefix("agent:") {
                (
                    "SELECT owner,value FROM image_drafts WHERE session_id=?1",
                    session,
                )
            } else {
                (
                    "SELECT owner,value FROM image_drafts WHERE origin_owner=?1",
                    owner.as_str(),
                )
            };
            let mut statement = connection.prepare(query).map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([key], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (key, raw) = row.map_err(|e| e.to_string())?;
                records.insert(
                    key,
                    serde_json::from_str(&raw).map_err(|_| "Invalid stored image draft")?,
                );
            }
        }
        Ok(records.into_values().collect())
    }

    pub(crate) fn commit(&self, input: DraftCommit) -> Result<(), String> {
        if input.checks.len() > 8 || input.writes.len() > 4 || input.deletes.len() > 4 {
            return Err("Too many draft mutations".into());
        }
        let mut checked = BTreeMap::new();
        for check in &input.checks {
            validate_key(&check.owner)?;
            if check.revision > 9_007_199_254_740_991
                || checked.insert(&check.owner, check.revision).is_some()
            {
                return Err("Invalid draft revision check".into());
            }
        }
        let mut mutations = std::collections::BTreeSet::new();
        let mut encoded = Vec::new();
        for draft in &input.writes {
            draft.validate()?;
            if !mutations.insert(&draft.owner) {
                return Err("Duplicate draft mutation".into());
            }
            if checked
                .get(&draft.owner)
                .and_then(|revision| revision.checked_add(1))
                != Some(draft.revision)
            {
                return Err("Invalid draft revision advance".into());
            }
            let raw = serde_json::to_string(draft).map_err(|_| "Could not encode image draft")?;
            if raw.len() > 32 * 1024 * 1024 {
                return Err("Image draft exceeds the storage limit".into());
            }
            encoded.push(raw);
        }
        for key in &input.deletes {
            validate_key(key)?;
            if !checked.contains_key(key) || !mutations.insert(key) {
                return Err("Unchecked or duplicate draft deletion".into());
            }
        }
        let mut connection = self.0.lock().map_err(|_| "Frontend storage unavailable")?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for check in input.checks {
            let current: Option<i64> = transaction
                .query_row(
                    "SELECT revision FROM image_drafts WHERE owner=?1",
                    [&check.owner],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if current.unwrap_or(0) != check.revision as i64 {
                return Err("IMAGE_DRAFT_CONFLICT: reopen this conversation".into());
            }
        }
        for (draft, raw) in input.writes.into_iter().zip(encoded) {
            transaction.execute("INSERT INTO image_drafts VALUES (?1,?2,?3,?4,?5) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,session_id=excluded.session_id,origin_owner=excluded.origin_owner,value=excluded.value",
                params![draft.owner, draft.revision as i64, draft.operation.as_ref().map(|operation| &operation.session_id), draft.origin_owner, raw]).map_err(|e| e.to_string())?;
        }
        for key in input.deletes {
            transaction
                .execute("DELETE FROM image_drafts WHERE owner=?1", [key])
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub(crate) async fn load_ui_preferences(
    storage: State<'_, FrontendStorage>,
) -> Result<Vec<(String, String)>, String> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage.preferences())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn save_ui_preferences(
    storage: State<'_, FrontendStorage>,
    entries: Vec<(String, String)>,
) -> Result<(), String> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage.save_preferences(entries))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn read_image_drafts(
    storage: State<'_, FrontendStorage>,
    input: DraftRead,
) -> Result<Vec<ImageDraft>, String> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage.read(input))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn commit_image_drafts(
    storage: State<'_, FrontendStorage>,
    input: DraftCommit,
) -> Result<(), String> {
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage.commit(input))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn draft(owner: &str) -> ImageDraft {
        ImageDraft {
            origin_owner: None,
            owner: owner.into(),
            revision: 1,
            text: include_str!("../../README.md").into(),
            images: vec![ImageUpload {
                media_type: "image/png".into(),
                name: "32x32.png".into(),
                data: base64::engine::general_purpose::STANDARD
                    .encode(include_bytes!("../icons/32x32.png")),
            }],
            operation: None,
        }
    }
    fn put(store: &FrontendStorage, value: ImageDraft, expected: u64) -> Result<(), String> {
        store.commit(DraftCommit {
            checks: vec![RevisionCheck {
                owner: value.owner.clone(),
                revision: expected,
            }],
            writes: vec![value],
            deletes: vec![],
        })
    }
    fn exact(store: &FrontendStorage, key: &str) -> ImageDraft {
        store
            .read(DraftRead {
                keys: vec![key.into()],
                recovery_owner: None,
            })
            .unwrap()
            .remove(0)
    }

    #[test]
    fn sqlite_preferences_and_image_bytes_survive_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let store = FrontendStorage::open(directory.path()).unwrap();
        store
            .save_preferences(vec![("shellspan.focus.split".into(), "0.65".into())])
            .unwrap();
        let original = draft("agent:storage-check");
        put(&store, original.clone(), 0).unwrap();
        drop(store);
        let reopened = FrontendStorage::open(directory.path()).unwrap();
        assert_eq!(
            reopened.preferences().unwrap(),
            vec![("shellspan.focus.split".into(), "0.65".into())]
        );
        let restored = exact(&reopened, &original.owner);
        assert_eq!(restored.text, original.text);
        assert_eq!(restored.images[0].data, original.images[0].data);
        assert!(directory.path().join(DATABASE_NAME).is_file());
    }

    #[test]
    fn simultaneous_writers_cannot_overwrite_a_newer_revision() {
        let directory = tempfile::tempdir().unwrap();
        let first = FrontendStorage::open(directory.path()).unwrap();
        let second = FrontendStorage::open(directory.path()).unwrap();
        let original = draft("agent:concurrent-storage");
        put(&first, original.clone(), 0).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut workers = vec![];
        for store in [first.clone(), second] {
            let mut next = original.clone();
            next.revision = 2;
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                put(&store, next, 1)
            }));
        }
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.starts_with("IMAGE_DRAFT_CONFLICT:")));
        assert_eq!(exact(&first, &original.owner).revision, 2);
    }

    #[test]
    fn detach_and_recovery_checks_commit_as_one_transaction() {
        let directory = tempfile::tempdir().unwrap();
        let store = FrontendStorage::open(directory.path()).unwrap();
        let mut original = draft("agent:transaction-storage");
        original.operation = Some(DraftOperation {
            id: "storage-submission".into(),
            created_at_unix_ms: None,
            target_turn_id: None,
            session_id: "transaction-storage".into(),
            mode: "nextTurn".into(),
            create: None,
        });
        put(&store, original.clone(), 0).unwrap();
        let mut detached = original.clone();
        detached.owner = "submission:storage-submission".into();
        detached.origin_owner = Some(original.owner.clone());
        let mut empty = original.clone();
        empty.revision = 2;
        empty.images.clear();
        empty.text.clear();
        empty.operation = None;
        let checks = || {
            vec![
                RevisionCheck {
                    owner: original.owner.clone(),
                    revision: 1,
                },
                RevisionCheck {
                    owner: detached.owner.clone(),
                    revision: 0,
                },
            ]
        };
        store
            .commit(DraftCommit {
                checks: checks(),
                writes: vec![empty.clone(), detached.clone()],
                deletes: vec![],
            })
            .unwrap();
        assert_eq!(
            store
                .read(DraftRead {
                    keys: vec![original.owner.clone()],
                    recovery_owner: Some(original.owner.clone())
                })
                .unwrap()
                .len(),
            2
        );
        assert!(exact(&store, &original.owner).images.is_empty());
        let mut newer = draft(&original.owner);
        newer.revision = 3;
        put(&store, newer.clone(), 2).unwrap();
        let failed = store.commit(DraftCommit {
            checks: vec![
                RevisionCheck {
                    owner: original.owner.clone(),
                    revision: 2,
                },
                RevisionCheck {
                    owner: detached.owner.clone(),
                    revision: 1,
                },
            ],
            writes: vec![],
            deletes: vec![detached.owner.clone()],
        });
        assert!(failed.unwrap_err().starts_with("IMAGE_DRAFT_CONFLICT:"));
        assert_eq!(exact(&store, &original.owner).revision, 3);
        assert_eq!(
            exact(&store, &detached.owner).images[0].data,
            original.images[0].data
        );
    }

    #[test]
    fn storage_rejects_unknown_preferences_unchecked_mutations_and_invalid_revisions() {
        let directory = tempfile::tempdir().unwrap();
        let store = FrontendStorage::open(directory.path()).unwrap();
        assert!(store
            .save_preferences(vec![("apiKey".into(), "not-a-credential".into())])
            .is_err());
        assert!(store
            .commit(DraftCommit {
                checks: vec![],
                writes: vec![draft("agent:unchecked")],
                deletes: vec![]
            })
            .is_err());
        let mut value = draft("agent:invalid-revision");
        value.revision = 0;
        assert!(put(&store, value, 0).is_err());
        assert!(store
            .read(DraftRead {
                keys: vec!["invalid\nkey".into()],
                recovery_owner: None
            })
            .is_err());
    }
}
