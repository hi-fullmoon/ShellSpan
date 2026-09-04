use super::*;
use crate::agent_runtime::file_references::*;
#[test]
#[ignore = "requires isolated Stage 6D SSH fixture"]
fn file_reference_isolated_ssh_production_listing() {
    use std::io::Write;
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _entered = rt.enter();
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let dir = tempfile::tempdir().unwrap();
    let database = Database::open(&dir.path().join("fixture.db")).unwrap();
    let credentials = CredentialManager::in_memory_for_tests();
    credentials
        .store_profile_password("files-fixture", connection.password.as_deref().unwrap())
        .unwrap();
    database
        .insert_profile(&crate::models::ProfileRow {
            id: "files-fixture".into(),
            name: "Files isolated fixture".into(),
            host: connection.host.clone(),
            port: connection.port,
            username: connection.username.clone(),
            auth_method: crate::models::ProfileAuthMethod::Password,
            keychain_key_id: None,
            jump_host_config: None,
            organization_json: None,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
    let connected = crate::connection::connect_sftp(&connection, None, Some(&known_hosts)).unwrap();
    let connected = connected.lock().unwrap();
    let root = format!("/home/shellspan/files-{}", Uuid::new_v4().simple());
    for p in [
        &root,
        &format!("{root}/.agents"),
        &format!("{root}/.agents/skills"),
    ] {
        connected
            .sftp
            .mkdir(std::path::Path::new(p), 0o700)
            .unwrap();
    }
    let path = format!("{root}/.agents/skills/remote.md");
    let write = |path: &str, bytes: &[u8]| {
        connected
            .sftp
            .create(std::path::Path::new(path))
            .unwrap()
            .write_all(bytes)
            .unwrap();
    };
    write(
        &path,
        b"---\nname: remote\ndescription: remote instructions\n---\nremote body",
    );
    let target = AgentSessionTarget {
        kind: "remote".into(),
        target_id: "remote-target".into(),
        session_id: "remote-terminal".into(),
        label: None,
        profile_id: Some("files-fixture".into()),
        host: Some(connection.host.clone()),
        port: Some(connection.port),
        username: Some(connection.username.clone()),
        cwd: None,
        root_path: Some(root.clone()),
        local_root: Some(dir.path().to_str().unwrap().into()),
    };

    let request = |query: &str, expected_scope| FileReferenceRequest {
        target: target.clone(),
        query: query.into(),
        expected_scope,
        cancellation: CancellationToken::new(),
        deadline: std::time::Instant::now() + TIMEOUT,
    };
    let list = |query: &str, scope| {
        list_remote_file_references(request(query, scope), &database, &credentials, &known_hosts)
    };
    if std::env::var("SHELLSPAN_FILES_NO_PYTHON").as_deref() == Ok("1") {
        assert_eq!(list("", None).code.as_deref(), Some("Unavailable"));
        return;
    }
    connected
        .sftp
        .mkdir(std::path::Path::new(&format!("{root}/space dir")), 0o700)
        .unwrap();
    write(
        &format!("{root}/space dir/file name.txt"),
        b"CONTENT NOT READ",
    );
    let first = list("", None);
    assert_eq!(first.status, "ready", "{first:?}");
    let scope = first.scope.unwrap();
    assert!(first.entries.iter().any(|e| e.path == "space dir"));
    let files = list("space dir/fi", Some(scope.clone()));
    assert_eq!(files.entries[0].path, "space dir/file name.txt");
    // Remove file read permission: metadata-only listing still succeeds.
    connected
        .sftp
        .setstat(
            std::path::Path::new(&format!("{root}/space dir/file name.txt")),
            ssh2::FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(0),
                atime: None,
                mtime: None,
            },
        )
        .unwrap();
    assert_eq!(list("space dir/", Some(scope.clone())).entries.len(), 1);
    for q in ["../", "/etc/", "a/../../", "a//", "a\\b", "space dir/../"] {
        assert_eq!(list(q, Some(scope.clone())).status, "error");
    }
    connected
        .sftp
        .mkdir(std::path::Path::new(&format!("{root}/empty")), 0o700)
        .unwrap();
    assert!(list("empty/", Some(scope.clone())).entries.is_empty());
    assert_eq!(
        list("absent/", Some(scope.clone())).code.as_deref(),
        Some("Absent")
    );
    connected
        .sftp
        .mkdir(std::path::Path::new(&format!("{root}/denied")), 0)
        .unwrap();
    assert_eq!(
        list("denied/", Some(scope.clone())).code.as_deref(),
        Some("Denied")
    );
    connected
        .sftp
        .symlink(
            std::path::Path::new("/etc"),
            std::path::Path::new(&format!("{root}/escape")),
        )
        .unwrap();
    assert!(list("", Some(scope.clone())).excluded > 0);
    assert_eq!(list("escape/", Some(scope.clone())).status, "error");
    write(&format!("{root}/bad\"quote"), b"not read");
    assert!(list("", Some(scope.clone())).excluded > 1);
    // Linux server can represent non-UTF8 names even when macOS local APFS cannot.
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let mut bytes = format!("{root}/").into_bytes();
        bytes.push(0xff);
        let bad = std::path::PathBuf::from(std::ffi::OsString::from_vec(bytes));
        connected.sftp.create(&bad).unwrap();
        assert_eq!(
            list("", Some(scope.clone())).code.as_deref(),
            Some("Denied")
        );
        connected.sftp.unlink(&bad).unwrap();
    }
    for i in 0..45 {
        write(&format!("{root}/match{i:03}"), b"");
    }
    let truncated = list("match", Some(scope.clone()));
    assert_eq!(truncated.status, "truncated");
    assert_eq!(truncated.entries.len(), MAX_RESULTS);
    let cancelled = request("", Some(scope.clone()));
    cancelled.cancellation.cancel();
    assert_eq!(
        list_remote_file_references(cancelled, &database, &credentials, &known_hosts)
            .code
            .as_deref(),
        Some("Cancelled")
    );
    connected
        .sftp
        .rename(
            std::path::Path::new(&root),
            std::path::Path::new(&format!("{root}-old")),
            None,
        )
        .unwrap();
    connected
        .sftp
        .mkdir(std::path::Path::new(&root), 0o700)
        .unwrap();
    assert_eq!(list("", Some(scope)).code.as_deref(), Some("Drift"));
    database.delete_profile("files-fixture").unwrap();
    assert_eq!(
        list("", None).code.as_deref(),
        Some("Drift"),
        "missing remote profile never falls back to localRoot"
    );
}
