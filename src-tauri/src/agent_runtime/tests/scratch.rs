use super::*;
use serde_json::json;

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
fn scratch_roots_are_private_outside_project_and_isolated_by_session() {
    let work = Workspace::new();
    let first = work.acquire("parent");
    let child = work.acquire("child");
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
fn scratch_live_approval_survives_expiry_and_idle_files_go_to_system_trash() {
    let work = Workspace::new();
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
