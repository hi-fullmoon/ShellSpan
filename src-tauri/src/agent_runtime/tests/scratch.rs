use super::*;
use serde_json::json;
use std::io::Write;

#[path = "scratch_sftp.rs"]
mod sftp;

struct Workspace {
    root: tempfile::TempDir,
    store: ScratchStore,
    target: AgentSessionTarget,
    database: crate::db::Database,
    credentials: crate::keychain::CredentialManager,
}

impl Workspace {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().join("project");
        fs::create_dir(&work).unwrap();
        let store = ScratchStore::open(root.path()).unwrap();
        let target = serde_json::from_value(json!({
            "kind":"local", "targetId":"local", "sessionId":"terminal", "cwd":work
        }))
        .unwrap();
        let database = crate::db::Database::open(&root.path().join("profiles.db")).unwrap();
        Self {
            root,
            store,
            target,
            database,
            credentials: crate::keychain::CredentialManager::new(),
        }
    }

    fn services(&self) -> ScratchServices<'_> {
        ScratchServices {
            database: &self.database,
            credentials: &self.credentials,
            known_hosts: Path::new("unused-local-known-hosts"),
            engine: None,
        }
    }

    fn acquire(&self, session: &str) -> ScratchLease {
        self.store
            .acquire(
                session,
                session,
                &self.target,
                now() + 600_000,
                false,
                None,
                &self.services(),
            )
            .unwrap()
    }
}

#[test]
fn scratch_metadata_writes_do_not_break_concurrent_reopen() {
    let work = Workspace::new();
    let _lease = work.acquire("concurrent-reopen");
    let store = work.store.clone();
    let data = work.root.path().to_path_buf();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writer_barrier = barrier.clone();
    let writer = std::thread::spawn(move || {
        writer_barrier.wait();
        for _ in 0..500 {
            let state = store.state.lock().unwrap();
            let record = state.records.values().next().unwrap();
            persist(&state, record).unwrap();
        }
    });
    barrier.wait();
    let mut errors = Vec::new();
    for _ in 0..500 {
        if let Err(error) = ScratchStore::open(&data) {
            errors.push(error);
        }
    }
    writer.join().unwrap();
    assert!(
        errors.is_empty(),
        "Concurrent real scratch writes/reopen failed {}/500 times: {:?}",
        errors.len(),
        errors.iter().take(5).collect::<Vec<_>>()
    );
}

#[test]
fn scratch_roots_are_private_outside_project_and_isolated_by_session() {
    let work = Workspace::new();
    let first = work.acquire("parent");
    let child = work.acquire("child");
    let directory = work
        .root
        .path()
        .canonicalize()
        .unwrap()
        .join("agent-runtime/scratch");
    assert_eq!(
        Path::new(&first.root),
        work.root
            .path()
            .canonicalize()
            .unwrap()
            .join("tmp")
            .join(&key("parent", &work.target).unwrap()[..16])
    );
    assert_eq!(Path::new(&first.root).file_name().unwrap().len(), 16);
    assert_eq!(Path::new(&child.root).file_name().unwrap().len(), 16);
    assert!(!directory.join("workspaces").exists());
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(
            directory
                .join("records")
                .join(format!("{}.json", key("parent", &work.target).unwrap())),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(record["version"], 1);
    assert_eq!(record["key"].as_str().unwrap().len(), 64);
    assert_ne!(first.root, child.root);
    assert!(!Path::new(&first.root).starts_with(work.target.cwd.as_ref().unwrap()));
    assert!(!Path::new(&first.root).join("../records").exists());
    let mut target = super::super::native_adapter::target_native(&work.target).unwrap();
    if let super::super::AgentToolTargetNative::Local { target_id, cwd, .. } = &mut target {
        *target_id = format!("scratch-{}", key("parent", &work.target).unwrap());
        *cwd = Some(first.root.clone());
    }
    assert!(owns_target(work.root.path(), "parent", &target).unwrap());
    assert!(!owns_target(work.root.path(), "child", &target).unwrap());
    if let super::super::AgentToolTargetNative::Local { cwd, .. } = &mut target {
        *cwd = Some(child.root.clone());
    }
    assert!(!owns_target(work.root.path(), "parent", &target).unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&first.root).unwrap().permissions().mode() & 0o077,
            0
        );
    }
}

#[test]
fn scratch_short_directory_is_reused_after_reopen() {
    let work = Workspace::new();
    let lease = work.acquire("reopen-short-directory");
    let directory = PathBuf::from(&lease.root);
    fs::write(directory.join("check.sh"), "pwd\n").unwrap();
    drop(lease);

    let reopened = ScratchStore::open(work.root.path()).unwrap();
    let lease = reopened
        .acquire(
            "reopen-short-directory",
            "reopened-task",
            &work.target,
            now() + 600_000,
            false,
            None,
            &work.services(),
        )
        .unwrap();
    assert_eq!(Path::new(&lease.root), directory);
    assert_eq!(
        fs::read_to_string(directory.join("check.sh")).unwrap(),
        "pwd\n"
    );
}

#[test]
fn scratch_never_adopts_an_occupied_short_directory() {
    let work = Workspace::new();
    let key = key("occupied-short-directory", &work.target).unwrap();
    let directory = work
        .root
        .path()
        .canonicalize()
        .unwrap()
        .join("tmp")
        .join(&key[..16]);
    private_directory(&directory).unwrap();
    let script = directory.join("check.sh");
    fs::write(&script, "pwd\n").unwrap();

    let result = work.store.acquire(
        "occupied-short-directory",
        "occupied-task",
        &work.target,
        now() + 600_000,
        false,
        None,
        &work.services(),
    );
    assert!(matches!(result, Err(error) if error.starts_with("AGENT_SCRATCH_DIRECTORY_OCCUPIED")));
    work.store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &work.services())
        .unwrap();
    assert_eq!(fs::read_to_string(script).unwrap(), "pwd\n");
    assert!(work.store.state.lock().unwrap().records.is_empty());
}

#[cfg(unix)]
#[test]
fn scratch_metadata_staging_cannot_follow_symlinks() {
    let work = Workspace::new();
    let _lease = work.acquire("staging-links");
    let state = work.store.state.lock().unwrap();
    let pending = state.root.join("pending");
    fs::rename(&pending, state.root.join("pending-original")).unwrap();
    let project = Path::new(work.target.cwd.as_ref().unwrap());
    std::os::unix::fs::symlink(project, pending).unwrap();
    let record = state.records.values().next().unwrap();
    assert!(persist(&state, record).is_err());
    assert_eq!(fs::read_dir(project).unwrap().count(), 0);
}

#[test]
fn scratch_live_approval_survives_expiry_and_idle_files_go_to_system_trash() {
    let work = Workspace::new();
    let terminal = work
        .root
        .path()
        .join("tmp/shellspan-terminal-integration-test");
    fs::create_dir(&terminal).unwrap();
    fs::write(terminal.join("source.rs"), include_str!("../../lib.rs")).unwrap();
    let lease = work.acquire("pending");
    let root = PathBuf::from(&lease.root);
    fs::write(root.join("source.md"), include_str!("../../lib.rs")).unwrap();
    work.store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &work.services())
        .unwrap();
    assert!(root.join("source.md").exists());
    drop(lease);
    work.store
        .cleanup_at(now() + SUCCESS_TTL_MS * 2, &work.services())
        .unwrap();
    assert!(!root.exists());
    assert!(work.store.state.lock().unwrap().records.is_empty());
    assert!(Path::new(work.target.cwd.as_ref().unwrap()).exists());
    assert!(terminal.join("source.rs").exists());
}

#[cfg(unix)]
#[test]
fn scratch_accepts_readable_tmp_parent_but_rejects_writable_or_symlink_parents() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let temporary = root.path().join("tmp");
    fs::create_dir(&temporary).unwrap();
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ScratchStore::open(root.path()).is_ok());
    assert_eq!(
        fs::metadata(&temporary).unwrap().permissions().mode() & 0o777,
        0o755
    );

    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(ScratchStore::open(root.path()).is_err());

    fs::rename(&temporary, root.path().join("tmp-original")).unwrap();
    std::os::unix::fs::symlink(root.path().join("tmp-original"), &temporary).unwrap();
    assert!(ScratchStore::open(root.path()).is_err());
}

#[test]
fn scratch_unsettled_dispatch_stays_pinned_after_restart() {
    let work = Workspace::new();
    let mut lease = work.acquire("interrupted");
    let root = PathBuf::from(&lease.root);
    lease.dispatch().unwrap();
    drop(lease);
    let reopened = ScratchStore::open(work.root.path()).unwrap();
    reopened
        .cleanup_at(now() + FAILURE_TTL_MS * 10, &work.services())
        .unwrap();
    assert!(root.exists());
    assert!(reopened
        .state
        .lock()
        .unwrap()
        .records
        .values()
        .any(|r| r.uses.values().any(|u| matches!(u, Usage::Uncertain))));
}

#[test]
fn scratch_quota_does_not_block_process_observation_or_delete_live_files() {
    let work = Workspace::new();
    let lease = work.acquire("large");
    let path = Path::new(&lease.root).join("output.bin");
    fs::File::create(&path)
        .unwrap()
        .set_len(SESSION_BYTES)
        .unwrap();
    let result = work.store.acquire(
        "large",
        "large",
        &work.target,
        now() + 60_000,
        false,
        Some(1),
        &work.services(),
    );
    assert!(matches!(result, Err(error) if error.starts_with("AGENT_SCRATCH_QUOTA_EXCEEDED")));
    let observer = work.acquire("large");
    assert_eq!(observer.root, lease.root);
    assert!(path.exists());
}

#[cfg(unix)]
#[test]
fn scratch_collection_rejects_a_replaced_tmp_parent() {
    let work = Workspace::new();
    let lease = work.acquire("replaced-tmp-parent");
    let directory = PathBuf::from(&lease.root);
    fs::write(directory.join("check.sh"), "pwd\n").unwrap();
    drop(lease);

    let data = work.root.path().canonicalize().unwrap();
    fs::rename(data.join("tmp"), data.join("original-tmp")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside = outside.path().canonicalize().unwrap();
    let unrelated = outside.join(directory.file_name().unwrap());
    private_directory(&unrelated).unwrap();
    fs::write(unrelated.join("check.sh"), "pwd -P\n").unwrap();
    std::os::unix::fs::symlink(&outside, data.join("tmp")).unwrap();

    assert!(work
        .store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &work.services())
        .is_err());
    assert_eq!(
        fs::read_to_string(unrelated.join("check.sh")).unwrap(),
        "pwd -P\n"
    );
    assert!(data
        .join("original-tmp")
        .join(directory.file_name().unwrap())
        .join("check.sh")
        .exists());
    assert!(!work.store.state.lock().unwrap().records.is_empty());
}

#[cfg(unix)]
#[test]
fn scratch_rejects_symlink_roots_and_collection_never_follows_output_links() {
    let work = Workspace::new();
    let lease = work.acquire("links");
    let root = PathBuf::from(&lease.root);
    std::os::unix::fs::symlink(work.target.cwd.as_ref().unwrap(), root.join("project-link"))
        .unwrap();
    drop(lease);
    assert!(work
        .store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &work.services())
        .is_err());
    assert!(root.exists());
    assert!(Path::new(work.target.cwd.as_ref().unwrap()).exists());
    let data = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(work.root.path(), data.path().join("agent-runtime")).unwrap();
    assert!(ScratchStore::open(data.path()).is_err());
}

#[test]
fn scratch_scope_is_explicit_and_never_extends_non_file_tools() {
    let mut args = json!({"path":"check.py", "fileScope":"scratch"});
    assert!(take_scope("write_file", &mut args).unwrap());
    assert!(args.get("fileScope").is_none());
    assert!(!take_scope("write_file", &mut args).unwrap());
    assert!(take_scope("run_terminal_command", &mut json!({"fileScope":"scratch"})).is_err());
    assert!(take_scope("read_file", &mut json!({"fileScope":"other-session"})).is_err());
    for tool in super::super::default_model_tools() {
        assert_eq!(
            tool.input_schema.pointer("/properties/fileScope").is_some(),
            is_file_tool(&tool.name),
            "{}",
            tool.name
        );
    }
}
