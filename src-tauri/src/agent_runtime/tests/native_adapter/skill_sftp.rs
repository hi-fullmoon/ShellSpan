    use super::*;
    use crate::agent_runtime::{skill_runtime::SkillReadRequest, skills::*};
    #[test]
    #[ignore = "requires explicitly opted-in isolated SFTP fixture"]
    fn skill_isolated_sftp_production_provider_refresh_root_identity_and_drift() {
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
            .store_profile_password("skills-fixture", connection.password.as_deref().unwrap())
            .unwrap();
        database
            .insert_profile(&crate::models::ProfileRow {
                id: "skills-fixture".into(),
                name: "Skills isolated fixture".into(),
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
        let connected =
            crate::connection::connect_sftp(&connection, None, Some(&known_hosts)).unwrap();
        let connected = connected.lock().unwrap();
        let root = format!("/home/shellspan/skills-{}", Uuid::new_v4().simple());
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
            profile_id: Some("skills-fixture".into()),
            host: Some(connection.host.clone()),
            port: Some(connection.port),
            username: Some(connection.username.clone()),
            cwd: None,
            root_path: Some(root.clone()),
            local_root: Some(dir.path().to_str().unwrap().into()),
        };
        let request = |expected_scope| SkillReadRequest {
            target: target.clone(),
            expected_scope,
            cancellation: CancellationToken::new(),
        };
        let first = read_remote_skills(request(None), &database, &credentials, &known_hosts);
        assert_eq!(
            first.observation.status,
            SkillObservationStatus::Complete,
            "{:?}",
            first.observation
        );
        assert_eq!(first.definitions[0].instructions, "remote body");
        let scope = first.observation.snapshot.unwrap().scope;
        write(&format!("{root}/ordinary-business-file"), b"normal work");
        write(&path, b"---\nname: renamed\ndescription: changed\n---\nv2");
        let second = read_remote_skills(
            request(Some(scope.clone())),
            &database,
            &credentials,
            &known_hosts,
        );
        assert_eq!(
            second.observation.status,
            SkillObservationStatus::Complete,
            "{:?}",
            second.observation
        );
        assert_eq!(second.definitions[0].entry.name, "renamed");
        connected.sftp.unlink(std::path::Path::new(&path)).unwrap();
        assert!(read_remote_skills(
            request(Some(scope.clone())),
            &database,
            &credentials,
            &known_hosts
        )
        .definitions
        .is_empty());
        connected
            .sftp
            .symlink(
                std::path::Path::new("/etc/passwd"),
                std::path::Path::new(&path),
            )
            .unwrap();
        let link = read_remote_skills(
            request(Some(scope.clone())),
            &database,
            &credentials,
            &known_hosts,
        );
        assert!(link.definitions.is_empty());
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
        assert_eq!(
            read_remote_skills(request(Some(scope)), &database, &credentials, &known_hosts)
                .observation
                .status,
            SkillObservationStatus::Unavailable
        );
        database.delete_profile("skills-fixture").unwrap();
        assert_eq!(
            read_remote_skills(request(None), &database, &credentials, &known_hosts)
                .observation
                .status,
            SkillObservationStatus::Unavailable
        );
        // This disposable container owns all fixture files; the gate removes its volumes.
    }
