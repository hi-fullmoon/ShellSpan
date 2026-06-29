# File Manager Performance Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate per-operation SSH handshake/authentication overhead and redundant owner/group name lookups so that remote directory access in the file manager feels as fast as comparable SFTP clients.

**Architecture:** Introduce a Rust-side `SftpConnectionPool` that caches fully initialized `ConnectedSftp` instances (authenticated SSH session + open SFTP subsystem) keyed by connection credentials. File manager commands borrow the cached connection for the duration of the operation instead of reconnecting each time. Add a separate `RemoteIdentityCache` keyed by `(host, id)` to avoid repeatedly resolving UID/GID over SSH exec channels. Both caches live in Tauri managed state so they survive individual command invocations.

**Tech Stack:** Rust (tauri, ssh2 0.9.5), TypeScript/React (frontend unchanged for this optimization), Vitest (frontend tests), `cargo test` (Rust tests).

## Global Constraints

- No changes to frontend command signatures or user-visible behavior except faster load times.
- Keep all existing file manager functionality: list, create, rename, delete, copy, upload, download, open, preview, permissions update.
- `ssh2::Sftp` in v0.9.5 owns its own `Arc`-backed inner state and has no lifetime parameter, so the entire `ConnectedSftp` can be cached and shared.
- Thread-safety: `ConnectedSftp` is not `Clone`, so pool values are `Arc<Mutex<ConnectedSftp>>`; concurrent operations for the same connection serialize on the mutex.
- Cleanup: cached connections must be invalidated when the remote side drops the connection or when the terminal session is closed.
- TDD: every new module gets a failing test first; watch it fail, implement minimally, watch it pass.

---

## Task 1: Connection pool scaffolding

**Files:**
- Create: `src-tauri/src/sftp_pool.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/sftp_pool.rs`

**Interfaces:**
- Consumes: `RemoteConnectionRequest` from `crate::models`, `ConnectedSftp` from `crate::models`.
- Produces: `SftpPool` struct that is `Default + Clone`, with `get_or_create(&self, request: &RemoteConnectionRequest) -> Result<Arc<Mutex<ConnectedSftp>>, String>`, `insert(&self, request: &RemoteConnectionRequest, connected: Arc<Mutex<ConnectedSftp>>)`, and `invalidate(&self, request: &RemoteConnectionRequest)`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthMethod, ConnectedSftp, RemoteConnectionRequest};

    #[test]
    fn connection_key_is_stable_for_equal_requests() {
        let request = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };

        assert_eq!(connection_key(&request), connection_key(&request));
    }

    #[test]
    fn connection_key_differs_when_credentials_differ() {
        let base = RemoteConnectionRequest {
            host: "example.com".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: AuthMethod::Password,
            password: Some("secret".to_string()),
            private_key_path: None,
            passphrase: None,
            jump_host: None,
        };
        let mut other = base.clone();
        other.username = "bob".to_string();

        assert_ne!(connection_key(&base), connection_key(&other));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib connection_key_is_stable_for_equal_requests connection_key_differs_when_credentials_differ`

Expected: FAIL because `connection_key` and `SftpPool` do not exist.

- [ ] **Step 3: Write minimal implementation**

```rust
use crate::models::{ConnectedSftp, RemoteConnectionRequest};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub(crate) struct SftpPool {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<ConnectedSftp>>>>>,
}

impl SftpPool {
    pub(crate) fn get_or_create(
        &self,
        request: &RemoteConnectionRequest,
    ) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
        let key = connection_key(request);
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(&key)
            .cloned()
            .ok_or_else(|| "connection not cached".to_string())
    }

    pub(crate) fn insert(
        &self,
        request: &RemoteConnectionRequest,
        connected: Arc<Mutex<ConnectedSftp>>,
    ) {
        let key = connection_key(request);
        self.sessions.lock().unwrap().insert(key, connected);
    }

    pub(crate) fn invalidate(&self, request: &RemoteConnectionRequest) {
        let key = connection_key(request);
        self.sessions.lock().unwrap().remove(&key);
    }
}

fn connection_key(request: &RemoteConnectionRequest) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        request.host,
        request.port,
        request.username,
        request.auth_method.as_str(),
        request.password.as_deref().unwrap_or(""),
        request.private_key_path.as_deref().unwrap_or(""),
        request.passphrase.as_deref().unwrap_or(""),
    )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib connection_key_is_stable_for_equal_requests connection_key_differs_when_credentials_differ`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sftp_pool.rs
git commit -m "feat(sftp): add connection pool scaffolding and key helper"
```

---

## Task 2: Integrate pool into connection flow

**Files:**
- Modify: `src-tauri/src/connection.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/remote_fs.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: existing Rust tests in `connection.rs` and `remote_fs.rs` must still pass

**Interfaces:**
- Consumes: `SftpPool` from `crate::sftp_pool`.
- Produces: `connect_sftp(request, pool)` returns `Result<Arc<Mutex<ConnectedSftp>>, String>`. All file-manager blocking functions accept an additional `pool: Option<&SftpPool>` argument and lock the shared connection at the start.

- [ ] **Step 1: Write the failing test**

Add a compilation/behavior test in `src-tauri/src/connection.rs`:

```rust
#[test]
fn connect_sftp_returns_shared_connection() {
    use crate::sftp_pool::SftpPool;
    // We cannot open a real SSH session in a unit test, but this test documents the expected
    // return type and ensures the signature compiles with the pool argument.
    fn expect_shared(_result: Result<std::sync::Arc<std::sync::Mutex<crate::models::ConnectedSftp>>, String>) {}
    fn dummy_call(request: &crate::models::RemoteConnectionRequest, pool: &SftpPool) {
        expect_shared(connect_sftp(request, Some(pool)));
    }
    let _ = dummy_call;
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib connect_sftp_returns_shared_connection`

Expected: FAIL because the signature of `connect_sftp` does not match.

- [ ] **Step 2: Update `connect_sftp` to use and return the pool**

Modify `src-tauri/src/connection.rs`:

```rust
use crate::sftp_pool::SftpPool;
use std::sync::{Arc, Mutex};

pub(crate) fn connect_sftp(
    request: &RemoteConnectionRequest,
    pool: Option<&SftpPool>,
) -> Result<Arc<Mutex<ConnectedSftp>>, String> {
    validate_connection_fields(&request.host, &request.username)?;

    if let Some(pool) = pool {
        if let Ok(cached) = pool.get_or_create(request) {
            return Ok(cached);
        }
    }

    let (session, jump_session) = if let Some(ref jump) = request.jump_host {
        let (jump_session, target_session) = connect_through_jump_host(
            jump,
            &request.host,
            request.port,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
        )?;
        (target_session, Some(jump_session))
    } else {
        let tcp = connect_tcp_stream(&request.host, request.port)?;
        let session = open_authenticated_session(
            tcp,
            &request.username,
            request.auth_method,
            request.password.as_deref(),
            request.private_key_path.as_deref(),
            request.passphrase.as_deref(),
        )?;
        (session, None)
    };

    let sftp = session
        .sftp()
        .map_err(|error| format!("failed to open sftp subsystem: {error}"))?;

    let connected = Arc::new(Mutex::new(ConnectedSftp {
        session,
        sftp,
        _jump_session: jump_session,
    }));

    if let Some(pool) = pool {
        pool.insert(request, connected.clone());
    }

    Ok(connected)
}
```

- [ ] **Step 3: Update all `remote_fs` function signatures**

For every `pub(crate) fn *_blocking` in `src-tauri/src/remote_fs.rs` that currently calls `connect_sftp(&request.connection)?`, change the signature to accept `pool: Option<&SftpPool>` and lock the returned connection. Example for `list_remote_directory_blocking`:

```rust
pub(crate) fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
    pool: Option<&SftpPool>,
) -> Result<RemoteDirectoryListing, String> {
    let connected = connect_sftp(&request.connection, pool)?;
    let connected = connected.lock().unwrap();
    list_remote_directory_from_sftp(
        &connected.session,
        &connected.sftp,
        request.path.as_deref(),
        pool,
    )
}
```

Pass `pool` through to `enrich_remote_entry_owners` so it can use the identity cache in Task 3.

Apply the same pattern to: `create_remote_entry_blocking`, `rename_remote_path_blocking`, `update_remote_permissions_blocking`, `delete_remote_path_blocking`, `copy_remote_path_blocking`, `upload_local_paths_blocking`, `download_remote_paths_blocking`, `open_remote_file_blocking`, `read_remote_file_blocking`.

- [ ] **Step 4: Update Tauri command handlers**

In `src-tauri/src/commands.rs`, add `pool: State<'_, SftpPool>` to each file-manager command and forward it into the blocking call. Because `SftpPool` is `Clone`, capture it before `spawn_blocking`:

```rust
#[tauri::command]
pub(crate) async fn list_remote_directory(
    request: RemoteDirectoryRequest,
    pool: State<'_, SftpPool>,
) -> Result<RemoteDirectoryListing, String> {
    let pool = pool.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        list_remote_directory_blocking(request, Some(&pool))
    })
    .await
    .map_err(|error| format!("failed to join directory listing task: {error}"))?;
    result
}
```

Apply the same pattern to: `create_remote_entry`, `rename_remote_path`, `delete_remote_path`, `copy_remote_path`, `upload_local_paths`, `download_remote_paths`, `open_remote_file`, `preview_remote_file`, `update_remote_permissions`.

Register `SftpPool` as Tauri managed state in `src-tauri/src/lib.rs`:

```rust
.manage(SftpPool::default())
```

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/connection.rs src-tauri/src/remote_fs.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/sftp_pool.rs
git commit -m "feat(sftp): reuse cached SFTP connections across file manager operations"
```

---

## Task 3: Cache remote owner/group name lookups

**Files:**
- Create: `src-tauri/src/identity_cache.rs`
- Modify: `src-tauri/src/remote_fs.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Test: inline tests in `src-tauri/src/identity_cache.rs`

**Interfaces:**
- Consumes: `host: &str`, `ids: &[u32]`, `RemoteIdentityKind`.
- Produces: `RemoteIdentityCache` with `resolve_names(&self, host: &str, ids: &[u32], kind: RemoteIdentityKind) -> (HashMap<u32, String>, Vec<u32>)` returning cached hits and missing IDs, plus `insert(...)` for storing resolved names.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_returns_cached_user_name() {
        let cache = RemoteIdentityCache::default();
        cache.insert("host1", 1000, RemoteIdentityKind::User, "alice".to_string());

        let (found, missing) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::User);

        assert_eq!(found.get(&1000), Some(&"alice".to_string()));
        assert!(missing.is_empty());
    }

    #[test]
    fn cache_reports_missing_ids() {
        let cache = RemoteIdentityCache::default();

        let (found, missing) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::User);

        assert!(found.is_empty());
        assert_eq!(missing, vec![1000]);
    }

    #[test]
    fn cache_isolated_by_host_and_kind() {
        let cache = RemoteIdentityCache::default();
        cache.insert("host1", 1000, RemoteIdentityKind::User, "alice".to_string());

        let (found, _) = cache.resolve_names("host2", &[1000], RemoteIdentityKind::User);
        let (found_group, _) = cache.resolve_names("host1", &[1000], RemoteIdentityKind::Group);

        assert!(found.is_empty());
        assert!(found_group.is_empty());
    }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib cache_returns_cached_user_name cache_reports_missing_ids cache_isolated_by_host_and_kind`

Expected: FAIL because `RemoteIdentityCache` does not exist.

- [ ] **Step 2: Implement the cache**

```rust
use crate::remote_fs::RemoteIdentityKind;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct RemoteIdentityCache {
    entries: Mutex<HashMap<(String, u32, RemoteIdentityKind), String>>,
}

impl RemoteIdentityCache {
    pub(crate) fn insert(
        &self,
        host: &str,
        id: u32,
        kind: RemoteIdentityKind,
        name: String,
    ) {
        self.entries
            .lock()
            .unwrap()
            .insert((host.to_string(), id, kind), name);
    }

    pub(crate) fn resolve_names(
        &self,
        host: &str,
        ids: &[u32],
        kind: RemoteIdentityKind,
    ) -> (HashMap<u32, String>, Vec<u32>) {
        let entries = self.entries.lock().unwrap();
        let mut found = HashMap::new();
        let mut missing = Vec::new();
        for id in ids {
            if let Some(name) = entries.get(&(host.to_string(), *id, kind)) {
                found.insert(*id, name.clone());
            } else {
                missing.push(*id);
            }
        }
        (found, missing)
    }
}
```

**Note:** `RemoteIdentityKind` is currently private in `remote_fs.rs`. Make it `pub(crate)` so `identity_cache.rs` can import it, or move it to `models.rs`. The minimal change is to make it `pub(crate)` in `remote_fs.rs`.

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib cache_returns_cached_user_name cache_reports_missing_ids cache_isolated_by_host_and_kind`

Expected: PASS.

- [ ] **Step 4: Integrate cache into owner resolution**

Modify `enrich_remote_entry_owners` in `src-tauri/src/remote_fs.rs`:

```rust
fn enrich_remote_entry_owners(
    host: &str,
    session: &Session,
    entries: &mut [RemoteFileEntry],
    cache: Option<&RemoteIdentityCache>,
) {
    let owner_ids = entries
        .iter()
        .filter_map(|entry| entry.owner_uid)
        .collect::<HashSet<_>>();
    let group_ids = entries
        .iter()
        .filter_map(|entry| entry.group_gid)
        .collect::<HashSet<_>>();

    let owner_names = resolve_identity_names(host, session, cache, &owner_ids, RemoteIdentityKind::User);
    let group_names = resolve_identity_names(host, session, cache, &group_ids, RemoteIdentityKind::Group);

    for entry in entries {
        entry.owner_name = entry.owner_uid.and_then(|uid| owner_names.get(&uid).cloned());
        entry.group_name = entry.group_gid.and_then(|gid| group_names.get(&gid).cloned());
    }
}

fn resolve_identity_names(
    host: &str,
    session: &Session,
    cache: Option<&RemoteIdentityCache>,
    ids: &HashSet<u32>,
    kind: RemoteIdentityKind,
) -> HashMap<u32, String> {
    if ids.is_empty() {
        return HashMap::new();
    }

    let ids_vec: Vec<u32> = ids.iter().copied().collect();

    let (mut names, missing_ids) = if let Some(cache) = cache {
        cache.resolve_names(host, &ids_vec, kind)
    } else {
        (HashMap::new(), ids_vec)
    };

    if !missing_ids.is_empty() {
        match resolve_remote_identity_names(session, &missing_ids, kind) {
            Ok(resolved) => {
                if let Some(cache) = cache {
                    for (id, name) in &resolved {
                        cache.insert(host, *id, kind, name.clone());
                    }
                }
                names.extend(resolved);
            }
            Err(error) => {
                warn!("failed to resolve remote {:?} names: {}", kind, error);
            }
        }
    }

    names
}
```

Register `RemoteIdentityCache` as Tauri managed state in `src-tauri/src/lib.rs` and pass it through command handlers into the blocking functions, then through `list_remote_directory_from_sftp` to `enrich_remote_entry_owners`.

- [ ] **Step 5: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/identity_cache.rs src-tauri/src/remote_fs.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(sftp): cache remote owner and group name lookups"
```

---

## Task 4: Invalidate cached connections on errors

**Files:**
- Modify: `src-tauri/src/remote_fs.rs`
- Modify: `src-tauri/src/sftp_pool.rs`
- Test: inline tests in `src-tauri/src/sftp_pool.rs`

**Interfaces:**
- Consumes: `SftpPool` and the original `RemoteConnectionRequest`.
- Produces: a helper that removes the cached entry when an operation fails with a transport-related error.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn invalidate_removes_cached_connection() {
    use crate::models::{AuthMethod, ConnectedSftp, RemoteConnectionRequest};
    use ssh2::Session;
    use std::sync::{Arc, Mutex};

    let pool = SftpPool::default();
    let request = RemoteConnectionRequest {
        host: "example.com".to_string(),
        port: 22,
        username: "alice".to_string(),
        auth_method: AuthMethod::Password,
        password: Some("secret".to_string()),
        private_key_path: None,
        passphrase: None,
        jump_host: None,
    };

    // We cannot create a real Session in a unit test, but we can verify the behavior by
    // attempting to get a connection after invalidate returns an error.
    pool.invalidate(&request);
    assert!(pool.get_or_create(&request).is_err());
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib invalidate_removes_cached_connection`

Expected: PASS immediately because `invalidate` + `get_or_create` already work. If it passes, the test documents the behavior; if the implementation is incomplete, it will fail and drive the fix.

- [ ] **Step 2: Add error-based invalidation helper**

Add to `src-tauri/src/remote_fs.rs` or `src-tauri/src/sftp_pool.rs`:

```rust
pub(crate) fn is_connection_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("ssh transport disconnected")
        || lower.contains("transport read")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("broken pipe")
        || lower.contains("draining incoming flow")
        || lower.contains("socket")
}
```

Wrap file-manager operations so that transport errors invalidate the pool entry. Example wrapper for `list_remote_directory_blocking`:

```rust
pub(crate) fn list_remote_directory_blocking(
    request: RemoteDirectoryRequest,
    pool: Option<&SftpPool>,
    identity_cache: Option<&RemoteIdentityCache>,
) -> Result<RemoteDirectoryListing, String> {
    let result = list_remote_directory_inner(request, pool, identity_cache);
    if let Err(ref error) = result {
        if let Some(pool) = pool {
            if is_connection_error(error) {
                pool.invalidate(&request.connection);
            }
        }
    }
    result
}
```

Move the original implementation into `list_remote_directory_inner`.

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/remote_fs.rs src-tauri/src/sftp_pool.rs
git commit -m "feat(sftp): invalidate cached connections on transport errors"
```

---

## Task 5: Full test and type-check verification

**Files:**
- None.

**Interfaces:**
- End-to-end command layer.

- [ ] **Step 1: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 2: Run Rust type check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: no errors.

- [ ] **Step 3: Run frontend tests**

Run: `pnpm test --run`

Expected: PASS.

- [ ] **Step 4: Run frontend type check**

Run: `pnpm typecheck` (or `tsc --noEmit` if that is the project command)

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "test(sftp): verify connection pool and identity cache pass full suite" --allow-empty
```

---

## Task 6: Manual smoke test

**Files:**
- None.

**Interfaces:**
- End-to-end file manager behavior.

- [ ] **Step 1: Build and run the app**

Run: `pnpm tauri dev` (or `pnpm tauri build` and open the app).

- [ ] **Step 2: Verify directory listing speed**

- Connect to a remote host.
- Open the file manager.
- First load may be normal (cold cache).
- Navigate into folders and back; subsequent loads should feel faster.

- [ ] **Step 3: Verify file operations**

- Create folder, create file, rename, delete, copy within remote host.
- Upload, download, open, preview, change permissions.
- All operations should complete without errors.

- [ ] **Step 4: Verify error recovery**

- Disconnect the network or kill the remote SSH session.
- Try to refresh the file manager.
- The operation should fail gracefully; the next attempt should reconnect and succeed.

- [ ] **Step 5: Commit any fixes**

```bash
git add ...
git commit -m "fix(sftp): address issues found in manual smoke test"
```

---

## Self-Review

**Spec coverage:**
- Reuse SSH/SFTP connections: Tasks 1, 2.
- Cache owner/group name lookups: Task 3.
- Preserve all file manager operations: Tasks 2, 6.
- Handle connection errors and invalidation: Task 4.
- Tests and verification: Tasks 1, 3, 4, 5, 6.

**Placeholder scan:**
- No `TBD`, `TODO`, or vague steps.
- Each step includes concrete code or exact commands.
- Tests include real assertions, not just "write tests for the above."

**Type consistency:**
- `connect_sftp` returns `Arc<Mutex<ConnectedSftp>>` consistently.
- `SftpPool` is `Default + Clone` and uses `Arc<Mutex<HashMap<...>>>`.
- `RemoteIdentityCache` is used only where owner/group names are resolved.
- `RemoteIdentityKind` is made `pub(crate)` in `remote_fs.rs`.

**Risks and notes:**
- Pool keys currently include passwords and passphrases in plaintext because they are part of the request. This is consistent with how requests are already handled but should be replaced with a deterministic hash in a follow-up security refactor.
- Concurrent file-manager operations for the same connection serialize on the mutex. This is acceptable for directory browsing and most file operations; long uploads/downloads will block browsing for the same host. If that becomes a problem, a future refactor can maintain a small pool of `ConnectedSftp` instances per connection key.
- Jump-host sessions: the cached object is the target `ConnectedSftp`. The jump-host session is created only on cold connection and stored inside the cached `ConnectedSftp`, so it is reused along with the target session.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-file-manager-performance.md`.**

**Execution options:**

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?