use super::*;
use crate::agent_runtime::{file_references::*, native::scoped_read::*};
use std::{
    fs,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
fn input(session: &str, query: &str) -> FileReferenceInput {
    FileReferenceInput {
        session_id: session.into(),
        request_id: uuid::Uuid::new_v4().to_string(),
        query: query.into(),
    }
}
fn setup() -> (tempfile::TempDir, tempfile::TempDir, AgentRuntime) {
    let storage = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let runtime = AgentRuntime::default();
    runtime.configure(storage.path().into()).unwrap();
    skill_tests::create_skill_session(&runtime, "files", project.path());
    (storage, project, runtime)
}
#[tokio::test]
async fn file_reference_live_tree_navigation_empty_and_deterministic_truncation() {
    let (_s, p, runtime) = setup();
    fs::create_dir(p.path().join("space dir")).unwrap();
    fs::create_dir(p.path().join("empty")).unwrap();
    fs::write(p.path().join("space dir/file name.txt"), "UNREAD CONTENT").unwrap();
    for i in (0..60).rev() {
        fs::write(p.path().join(format!("entry{i:03}")), "data").unwrap();
    }
    let first = runtime
        .file_references
        .list(input("files", ""))
        .await
        .unwrap();
    assert_eq!(first.status, "truncated");
    assert_eq!(first.entries.len(), 40);
    assert_eq!(first.entries[0].path, "empty");
    assert_eq!(first.entries[1].path, "space dir");
    let again = runtime
        .file_references
        .list(input("files", ""))
        .await
        .unwrap();
    assert_eq!(
        again.entries, first.entries,
        "root directory handles must not share enumeration offset"
    );
    assert_eq!(
        runtime
            .file_references
            .list(input("files", "space dir/fi"))
            .await
            .unwrap()
            .entries[0]
            .path,
        "space dir/file name.txt"
    );
    assert!(runtime
        .file_references
        .list(input("files", "empty/"))
        .await
        .unwrap()
        .entries
        .is_empty());
    fs::write(p.path().join("empty/new.txt"), "new").unwrap();
    assert_eq!(
        runtime
            .file_references
            .list(input("files", "empty/"))
            .await
            .unwrap()
            .entries
            .len(),
        1,
        "every query observes fresh directory state"
    );
    let events = all_events(&runtime, "files");
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(
                e.payload,
                AgentSessionEventPayload::FileReferenceScopeBound { .. }
            ))
            .count(),
        1
    );
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("UNREAD CONTENT"));
    assert!(!events.iter().any(|e| matches!(
        e.payload,
        AgentSessionEventPayload::ToolCall { .. } | AgentSessionEventPayload::RequestStart { .. }
    )));
}
#[tokio::test]
async fn file_reference_session_identity_survives_restart_and_is_shared_with_skills() {
    let (storage, project, runtime) = setup();
    runtime
        .file_references
        .list(input("files", ""))
        .await
        .unwrap();
    drop(runtime);
    let runtime = AgentRuntime::default();
    runtime.configure(storage.path().into()).unwrap();
    assert_eq!(
        runtime
            .file_references
            .list(input("files", ""))
            .await
            .unwrap()
            .status,
        "ready"
    );
    let old = project.path().with_extension("moved");
    fs::rename(project.path(), &old).unwrap();
    fs::create_dir(project.path()).unwrap();
    assert_eq!(
        runtime
            .file_references
            .list(input("files", ""))
            .await
            .unwrap()
            .code
            .as_deref(),
        Some("Drift")
    );
    assert_ne!(runtime.list_skills("files").await.unwrap().status, "fresh");
    fs::remove_dir_all(old).unwrap();
}
#[tokio::test]
async fn file_reference_skills_first_and_cancel_before_ipc_fail_closed() {
    let (_s, p, runtime) = setup();
    runtime.list_skills("files").await.unwrap();
    let request = input("files", "");
    runtime
        .file_references
        .cancel(FileReferenceCancel {
            session_id: "files".into(),
            request_id: request.request_id.clone(),
        })
        .unwrap();
    assert_eq!(
        runtime.file_references.list(request).await.unwrap_err(),
        "Cancelled"
    );
    assert_eq!(
        runtime
            .file_references
            .list(input("files", ""))
            .await
            .unwrap()
            .status,
        "ready"
    );
    fs::create_dir(p.path().join("unrelated")).unwrap();
    for query in [
        "../", "/etc", "a/../../", "a//", "a\\b", "a\0", "a\"b", "C:/", "./",
    ] {
        assert!(
            runtime
                .file_references
                .list(input("files", query))
                .await
                .is_err(),
            "{query:?}"
        );
    }
    assert!(runtime
        .file_references
        .list(input("files", &"a/".repeat(33)))
        .await
        .is_err());
}
#[tokio::test]
#[cfg(unix)]
async fn file_reference_links_invalid_utf8_permission_and_entry_budget_are_distinct() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (_s, p, runtime) = setup();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret"), "SECRET").unwrap();
    symlink(outside.path(), p.path().join("link")).unwrap();
    fs::write(p.path().join("quote\"name"), "not read").unwrap();
    fs::write(p.path().join("control\nname"), "not read").unwrap();
    let result = runtime
        .file_references
        .list(input("files", ""))
        .await
        .unwrap();
    assert_eq!(result.excluded, 3);
    assert!(result.entries.is_empty());
    assert_eq!(
        runtime
            .file_references
            .list(input("files", "link/"))
            .await
            .unwrap()
            .status,
        "error"
    );
    assert_eq!(
        runtime
            .file_references
            .list(input("files", "absent/"))
            .await
            .unwrap()
            .code
            .as_deref(),
        Some("Absent")
    );
    fs::create_dir(p.path().join("denied")).unwrap();
    fs::set_permissions(p.path().join("denied"), fs::Permissions::from_mode(0o0)).unwrap();
    assert_eq!(
        runtime
            .file_references
            .list(input("files", "denied/"))
            .await
            .unwrap()
            .code
            .as_deref(),
        Some("Denied")
    );
    fs::set_permissions(p.path().join("denied"), fs::Permissions::from_mode(0o700)).unwrap();
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStringExt;
        let bad = p.path().join(std::ffi::OsString::from_vec(vec![0xff]));
        fs::write(&bad, "unread").unwrap();
        assert_eq!(
            runtime
                .file_references
                .list(input("files", ""))
                .await
                .unwrap()
                .code
                .as_deref(),
            Some("Denied")
        );
        fs::remove_file(bad).unwrap();
    }
    fs::create_dir(p.path().join("many")).unwrap();
    for i in 0..1025 {
        fs::write(p.path().join(format!("many/{i}")), "").unwrap();
    }
    let result = runtime
        .file_references
        .list(input("files", "many/"))
        .await
        .unwrap();
    assert_eq!(result.code.as_deref(), Some("Limit"));
    assert!(result.entries.is_empty());
}
#[test]
fn file_reference_discovery_never_invokes_content_read_and_honors_mid_list_cancel() {
    struct Reader {
        token: CancellationToken,
        cancel: bool,
    }
    impl ScopedReader for Reader {
        fn root(&self) -> &str {
            "/root"
        }
        fn identity(&self) -> &str {
            "1:2"
        }
        fn check_root(&self) -> Result<(), ScopeReadError> {
            Ok(())
        }
        fn list(
            &self,
            _: &str,
            _: usize,
            _: &ReadControl,
        ) -> Result<Vec<ScopedEntry>, ScopeReadError> {
            if self.cancel {
                self.token.cancel();
            }
            Ok(vec![ScopedEntry {
                name: "file".into(),
                directory: false,
                file: true,
            }])
        }
        fn read(&self, _: &str, _: usize, _: &ReadControl) -> Result<Vec<u8>, ScopeReadError> {
            panic!("path discovery must not read content")
        }
    }
    let (_s, _p, runtime) = setup();
    for cancel in [false, true] {
        let token = CancellationToken::new();
        let request = FileReferenceRequest {
            target: runtime.session("files").unwrap().header.target.unwrap(),
            expected_scope: None,
            query: "".into(),
            cancellation: token.clone(),
            deadline: Instant::now() + Duration::from_secs(1),
        };
        let result = discover(&Reader { token, cancel }, &request);
        assert_eq!(result.status, if cancel { "error" } else { "ready" });
        if cancel {
            assert_eq!(result.code.as_deref(), Some("Cancelled"));
        }
    }
}
#[test]
fn file_reference_target_kind_never_falls_back_local_and_deadline_is_enforced() {
    let (_s, _p, runtime) = setup();
    let mut target = runtime.session("files").unwrap().header.target.unwrap();
    let request = |target| FileReferenceRequest {
        target,
        expected_scope: None,
        query: "".into(),
        cancellation: CancellationToken::new(),
        deadline: Instant::now() - Duration::from_secs(1),
    };
    assert_eq!(
        read_local(request(target.clone())).code.as_deref(),
        Some("Limit")
    );
    target.kind = "remote".into();
    assert_eq!(
        read_local(request(target)).code.as_deref(),
        Some("Unavailable")
    );
}

#[tokio::test]
async fn file_reference_inflight_cancellation_and_worker_permits_are_bounded() {
    struct Slow {
        started: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl NativeToolRuntime for Slow {
        fn list_file_references(&self, request: FileReferenceRequest) -> FileReferenceList {
            self.started
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            while !request.cancellation.is_cancelled() && Instant::now() < request.deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            FileReferenceList::failed("Cancelled")
        }
        fn prepare(&self, _: NativeToolRequest) -> Result<NativeToolPreparation, String> {
            unreachable!()
        }
        fn execute(
            &self,
            _: &str,
            _: bool,
            _: CancellationToken,
        ) -> Result<NativeToolResult, String> {
            unreachable!()
        }
        fn abandon(&self, _: &str) {
            unreachable!()
        }
    }
    let started = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let runtime = AgentRuntimeBuilder::new()
        .native_tool_runtime(Arc::new(Slow {
            started: started.clone(),
        }))
        .build();
    let storage = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    runtime.configure(storage.path().into()).unwrap();
    skill_tests::create_skill_session(&runtime, "files", project.path());
    let mut operations = Vec::new();
    for _ in 0..4 {
        let request = input("files", "");
        let worker = runtime.clone();
        let copy = request.clone();
        operations.push((
            request,
            tokio::spawn(async move { worker.file_references.list(copy).await }),
        ));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while started.load(std::sync::atomic::Ordering::SeqCst) != 4 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runtime
            .file_references
            .list(input("files", ""))
            .await
            .unwrap_err(),
        "Busy"
    );
    for (request, _) in &operations {
        runtime
            .file_references
            .cancel(FileReferenceCancel {
                session_id: request.session_id.clone(),
                request_id: request.request_id.clone(),
            })
            .unwrap();
    }
    for (_, operation) in operations {
        assert_eq!(operation.await.unwrap().unwrap_err(), "Cancelled");
    }
    assert!(!all_events(&runtime, "files").iter().any(|e| matches!(
        e.payload,
        AgentSessionEventPayload::FileReferenceScopeBound { .. }
    )));
}
