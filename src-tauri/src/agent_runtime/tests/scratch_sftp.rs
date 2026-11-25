//! Opt-in integration against the repository's real loopback SSH/SFTP fixture.
use super::*;
use std::io::Read;

fn assert_missing(sftp: &ssh2::Sftp, path: &str) {
    let error = sftp
        .lstat(Path::new(path))
        .expect_err("collected scratch path still exists");
    assert!(
        matches!(error.code(), ssh2::ErrorCode::SFTP(2 | 10)),
        "{error}"
    );
}

#[test]
#[ignore = "requires explicitly opted-in isolated SSH/SFTP fixture"]
fn scratch_remote_account_roots_execute_and_collect_without_project_writes() {
    let connection = crate::execution::fixture::isolated_ssh_connection();
    let (_trust, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let root = tempfile::tempdir().unwrap();
    let database = crate::db::Database::open(&root.path().join("profiles.db")).unwrap();
    let credentials = crate::keychain::CredentialManager::in_memory_for_tests();
    credentials
        .store_profile_password("scratch-sftp", connection.password.as_deref().unwrap())
        .unwrap();
    database
        .insert_profile(&crate::models::ProfileRow {
            id: "scratch-sftp".into(),
            name: "Scratch SFTP fixture".into(),
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
    let target: AgentSessionTarget = serde_json::from_value(json!({
        "kind":"remote", "targetId":"remote-host", "sessionId":"remote-terminal", "profileId":"scratch-sftp",
        "host":connection.host, "port":connection.port, "username":connection.username, "rootPath":"/home/shellspan/upload"
    })).unwrap();
    let store = ScratchStore::open(root.path()).unwrap();
    let services = ScratchServices {
        database: &database,
        credentials: &credentials,
        known_hosts: &known_hosts,
        engine: None,
    };
    let connected = crate::connection::connect_sftp(&connection, None, Some(&known_hosts)).unwrap();
    let connected = connected.lock().unwrap();
    let project = Path::new(target.root_path.as_deref().unwrap());
    let project_before = connected
        .sftp
        .readdir(project)
        .unwrap()
        .into_iter()
        .map(|(path, _)| path)
        .collect::<std::collections::BTreeSet<_>>();
    let parent = store
        .acquire(
            "remote-parent",
            "remote-task",
            &target,
            now() + 600_000,
            true,
            Some(4),
            &services,
        )
        .unwrap();
    let child = store
        .acquire(
            "remote-child",
            "remote-child-task",
            &target,
            now() + 600_000,
            true,
            Some(4),
            &services,
        )
        .unwrap();
    assert_ne!(parent.root, child.root);
    assert!(parent.root.contains("/.shellspan-server/scratch/"));
    assert!(!Path::new(&parent.root).starts_with(project));
    for root in [&parent.root, &child.root] {
        assert_eq!(
            connected.sftp.lstat(Path::new(root)).unwrap().perm.unwrap() & 0o777,
            0o700
        );
    }
    let mut native_target = crate::agent_runtime::native_adapter::target_native(&target).unwrap();
    if let crate::agent_runtime::AgentToolTargetNative::Remote {
        target_id,
        root_path,
        ..
    } = &mut native_target
    {
        *target_id = format!("scratch-{}", key("remote-parent", &target).unwrap());
        *root_path = Some(parent.root.clone());
    }
    assert!(owns_target(root.path(), "remote-parent", &native_target).unwrap());
    assert!(!owns_target(root.path(), "remote-child", &native_target).unwrap());
    let path = format!("{}/cwd.sh", parent.root);
    connected
        .sftp
        .create(Path::new(&path))
        .unwrap()
        .write_all(b"pwd\n")
        .unwrap();
    let child_path = format!("{}/cwd.sh", child.root);
    connected
        .sftp
        .create(Path::new(&child_path))
        .unwrap()
        .write_all(b"pwd -P\n")
        .unwrap();
    for (file, expected) in [(&path, "pwd\n"), (&child_path, "pwd -P\n")] {
        let mut actual = String::new();
        connected
            .sftp
            .open(Path::new(file))
            .unwrap()
            .read_to_string(&mut actual)
            .unwrap();
        assert_eq!(actual, expected);
    }
    let second_root = tempfile::tempdir().unwrap();
    let second_store = ScratchStore::open(second_root.path()).unwrap();
    let second_lease = second_store
        .acquire(
            "remote-parent",
            "remote-task",
            &target,
            now() + 600_000,
            true,
            Some(0),
            &services,
        )
        .unwrap();
    assert_ne!(second_lease.root, parent.root);
    let second_files = second_lease.root.clone();
    store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .unwrap();
    assert!(connected.sftp.lstat(Path::new(&path)).is_ok());
    assert!(connected.sftp.lstat(Path::new(&child_path)).is_ok());
    let process = super::super::super::spawn_remote_process_native(
        super::super::super::RemoteProcessStartNative {
            task_id: "remote-task".into(),
            request_id: "remote-request".into(),
            owner_target_id: target.target_id.clone(),
            command: format!("/bin/sh {}", shlex::try_quote(&path).unwrap()),
            connection,
            known_hosts_path: known_hosts.clone(),
            timeout: std::time::Duration::from_secs(10),
        },
        database.clone(),
        crate::remote_sandbox::binding_for_target(&native_target, &database, &known_hosts)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let actual = process.wait(std::time::Duration::from_secs(10)).unwrap();
    let home = connected.sftp.realpath(Path::new(".")).unwrap();
    assert_eq!(actual.exit_code, Some(0));
    assert!(actual.termination_confirmed);
    assert_eq!(actual.stdout.trim(), home.to_str().unwrap());
    let link = format!("{}/outside", parent.root);
    connected.sftp.symlink(&home, Path::new(&link)).unwrap();
    let parent_root = parent.root.clone();
    let child_root = child.root.clone();
    drop(parent);
    drop(child);
    store
        .cleanup_at(now() + SUCCESS_TTL_MS / 2, &services)
        .unwrap();
    assert!(connected.sftp.lstat(Path::new(&path)).is_ok());
    assert!(connected.sftp.lstat(Path::new(&child_path)).is_ok());
    assert!(store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .is_err());
    assert!(connected.sftp.lstat(Path::new(&path)).is_ok());
    assert_missing(&connected.sftp, &child_root);
    assert!(connected.sftp.lstat(Path::new(&second_files)).is_ok());
    connected.sftp.unlink(Path::new(&link)).unwrap();
    store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .unwrap();
    assert_missing(&connected.sftp, &parent_root);
    assert_missing(&connected.sftp, &child_root);
    let base = Path::new(&parent_root).parent().unwrap().parent().unwrap();
    assert_missing(&connected.sftp, base.to_str().unwrap());
    drop(second_lease);
    second_store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .unwrap();
    assert_missing(&connected.sftp, &second_files);
    let second_instance = Path::new(&second_files).parent().unwrap().parent().unwrap();
    let scratch_root = second_instance.parent().unwrap();
    let server_root = scratch_root.parent().unwrap();
    assert_missing(&connected.sftp, second_instance.to_str().unwrap());
    assert_missing(&connected.sftp, scratch_root.to_str().unwrap());
    assert_missing(&connected.sftp, server_root.to_str().unwrap());
    let project_after = connected
        .sftp
        .readdir(project)
        .unwrap()
        .into_iter()
        .map(|(path, _)| path)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(project_before, project_after);
}
