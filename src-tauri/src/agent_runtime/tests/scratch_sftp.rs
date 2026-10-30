//! Opt-in integration against the repository's real loopback SSH/SFTP fixture.
use super::*;

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
        "host":connection.host, "port":connection.port, "username":connection.username, "rootPath":"/home/shellspan"
    })).unwrap();
    let store = ScratchStore::open(root.path()).unwrap();
    let services = ScratchServices {
        database: &database,
        credentials: &credentials,
        known_hosts: &known_hosts,
        engine: None,
    };
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
    assert!(parent.root.contains("/.shellspan-agent-scratch-"));
    let connected = crate::connection::connect_sftp(&connection, None, Some(&known_hosts)).unwrap();
    let connected = connected.lock().unwrap();
    let path = format!("{}/cwd.sh", parent.root);
    connected
        .sftp
        .create(Path::new(&path))
        .unwrap()
        .write_all(b"pwd\n")
        .unwrap();
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
    assert!(store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .is_err());
    assert!(connected.sftp.lstat(Path::new(&path)).is_ok());
    connected.sftp.unlink(Path::new(&link)).unwrap();
    store
        .cleanup_at(now() + FAILURE_TTL_MS * 2, &services)
        .unwrap();
    assert!(connected.sftp.lstat(Path::new(&parent_root)).is_err());
    assert!(connected.sftp.lstat(Path::new(&child_root)).is_err());
    let base = Path::new(&parent_root).parent().unwrap().parent().unwrap();
    connected.sftp.rmdir(base).unwrap();
}
