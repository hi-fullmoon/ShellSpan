//! Real-project onboarding acceptance against SQLite, Git, Docker Compose and
//! the isolated Linux SSH/SFTP fixture. No simulated command responses.
use super::applications::*;
use super::{deployment_files, readiness, source_binding};
use crate::db::Database;
use rusqlite::params;
use std::path::Path;

fn git(root: &Path, arguments: &[&str]) {
    let output = super::docker_compose_executor::safe_local_command("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn input(entry: ApplicationEntry, workflow_revision: u64) -> SaveApplicationInput {
    SaveApplicationInput {
        expected_application_revision: entry.application.revision,
        expected_environment_revision: entry.environment.revision,
        expected_source_revision: if entry.application.revision == 0 {
            0
        } else {
            entry.source.revision
        },
        expected_workflow_revision: workflow_revision,
        workflow_id: entry.environment.workflow_id.clone(),
        entry,
    }
}

#[test]
#[ignore = "requires SHELLSPAN_PHASE2_PROJECT and the isolated Linux SSH fixture"]
fn real_application_onboarding_acceptance() {
    let project = std::env::var("SHELLSPAN_PHASE2_PROJECT").expect("real project path required");
    let inspected = readiness::inspect_project(Path::new(&project)).unwrap();
    assert!(inspected
        .detected_files
        .iter()
        .any(|file| file == "package.json"));
    let mut original_binding = inspected.source.binding.clone();
    original_binding.included_untracked = serde_json::from_str(
        &std::env::var("SHELLSPAN_PHASE2_INCLUDED_UNTRACKED").unwrap_or_else(|_| "[]".into()),
    )
    .unwrap();
    for file in &original_binding.included_untracked {
        assert!(inspected.source.untracked_files.contains(file));
    }
    original_binding.excluded_paths = vec![
        ".claude".into(),
        ".agents".into(),
        ".codex".into(),
        "data".into(),
        ".env.example".into(),
    ];
    let original = source_binding::capture(&original_binding).unwrap();
    let copy = source_binding::materialize(original.directory.path()).unwrap();
    // Git metadata is initialized only inside the disposable acceptance copy.
    git(copy.path(), &["init", "--quiet"]);
    git(copy.path(), &["add", "."]);
    git(
        copy.path(),
        &[
            "-c",
            "user.name=ShellSpan acceptance",
            "-c",
            "user.email=acceptance@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            "Real project acceptance baseline",
        ],
    );
    let source = source_binding::inspect(copy.path()).unwrap().binding;
    let storage = tempfile::tempdir().unwrap();
    let database_path = storage.path().join("onboarding.db");
    let database = Database::open(&database_path).unwrap();
    assert!(database.list_deployment_applications().unwrap().is_empty());
    let mut entry = ApplicationEntry {
        application: Application {
            id: uuid::Uuid::new_v4().to_string(),
            name: "for-you".into(),
            source_binding_id: source.id.clone(),
            revision: 0,
            archived: false,
        },
        source,
        environment: Environment {
            id: uuid::Uuid::new_v4().to_string(),
            application_id: String::new(),
            name: "Production".into(),
            revision: 0,
            workflow_id: None,
            config: EnvironmentConfig {
                template_kind: "dockerCompose".into(),
                connection_profile_id: String::new(),
                remote_root: String::new(),
                platform: "linux/arm64".into(),
                project_name: "for-you".into(),
                service: "web".into(),
                compose_file: "compose.yaml".into(),
                dockerfile: "Dockerfile".into(),
                build_context: ".".into(),
                access_url: String::new(),
                base_path: "/for-you/".into(),
                container_port: 3000,
                host_port: 3000,
                bind_address: "127.0.0.1".into(),
                data_directories: vec![],
                non_sensitive_files: vec![],
                existing_service: false,
                management_method: String::new(),
                recovery_instructions: String::new(),
            },
        },
    };
    entry.environment.application_id = entry.application.id.clone();
    let draft_input = input(entry, 0);
    entry = database.save_deployment_application(&draft_input).unwrap();
    assert!(entry.environment.workflow_id.is_none());
    assert!(database
        .save_deployment_application(&draft_input)
        .unwrap_err()
        .contains("REVISION_CONFLICT"));
    assert_eq!(database.list_deployment_applications().unwrap().len(), 1);
    assert!(!copy.path().join("node_modules").exists());
    assert!(!copy.path().join(".next").exists());

    let plan = deployment_files::preview(&entry).unwrap();
    assert!(plan.files.iter().all(|file| !file.exists));
    assert!(
        !copy.path().join("Dockerfile").exists(),
        "preview must not apply files"
    );
    assert!(deployment_files::apply(&entry, "outdated-preview").is_err());
    let files = deployment_files::apply(&entry, &plan.digest).unwrap();
    let content = std::fs::read(copy.path().join("Dockerfile")).unwrap();
    assert!(deployment_files::apply(&entry, &plan.digest).is_err());
    assert_eq!(
        content,
        std::fs::read(copy.path().join("Dockerfile")).unwrap()
    );
    let after_generation = readiness::inspect_project(copy.path()).unwrap();
    for file in &files {
        assert!(after_generation.source.untracked_files.contains(file));
    }
    entry.source.included_untracked = files;

    let connection = crate::execution::fixture::isolated_ssh_connection();
    assert_eq!(
        connection.host, "127.0.0.1",
        "acceptance must never target production"
    );
    let profile_id = format!("phase2-{}", uuid::Uuid::new_v4());
    database.with_connection(|connection_db| {
        connection_db.execute("INSERT INTO profiles (id,name,host,port,username,auth_method,created_at,updated_at) VALUES (?1,'Isolated Linux',?2,?3,?4,'password',1,1)",
            params![profile_id,connection.host,connection.port,connection.username]).map_err(|e|e.to_string())?;
        Ok(())
    }).unwrap();
    entry.environment.config.connection_profile_id = profile_id.clone();
    entry.environment.config.remote_root =
        format!("/srv/shellspan-deployment/missing-{}", uuid::Uuid::new_v4());
    entry = database
        .save_deployment_application(&input(entry, 0))
        .unwrap();
    let workflow_id = entry.environment.workflow_id.clone().unwrap();
    let workflow = database
        .get_deployment_workflow(&workflow_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        workflow
            .definition
            .application_binding
            .as_ref()
            .unwrap()
            .environment_revision,
        entry.environment.revision
    );
    assert_eq!(
        workflow
            .definition
            .nodes
            .iter()
            .find(|node| node.type_name == "source.snapshot")
            .unwrap()
            .config["binding"]["id"],
        entry.source.id
    );
    let local = readiness::check_local(&entry).unwrap();
    assert!(
        local
            .items
            .iter()
            .filter(|item| matches!(
                item.key.as_str(),
                "docker" | "buildx" | "source" | "lockfile" | "dockerfile" | "compose"
            ))
            .all(|item| item.status == readiness::CheckStatus::Passed),
        "{local:?}"
    );
    assert!(local
        .items
        .iter()
        .any(|item| item.status == readiness::CheckStatus::Unchecked));
    assert!(
        !copy.path().join("node_modules").exists(),
        "readiness must not install dependencies"
    );
    assert!(
        !copy.path().join(".next").exists(),
        "readiness must not build the project"
    );
    database.store_deployment_readiness(&entry, &local).unwrap();
    assert!(database
        .ensure_deployment_application_ready(&workflow_id, workflow.revision)
        .is_err());

    let (_known_hosts_directory, known_hosts) =
        crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
    let session = crate::execution::open_ssh_execution_session(&connection, &known_hosts).unwrap();
    let sftp = session.target.sftp().unwrap();
    assert!(sftp
        .lstat(Path::new(&entry.environment.config.remote_root))
        .is_err());
    let credentials = crate::keychain::CredentialManager::isolated_native_for_tests();
    credentials
        .store_profile_password(&profile_id, connection.password.as_deref().unwrap())
        .unwrap();
    let mut remote = local;
    let result = readiness::check_remote(
        &entry,
        &mut remote,
        &database,
        &credentials,
        &known_hosts,
        &crate::execution::ExecutionCancellationRegistry::default(),
    );
    result.unwrap();
    let mut with_data = entry.clone();
    with_data
        .environment
        .config
        .data_directories
        .push(DataDirectory {
            host_path: "/tmp".into(),
            container_path: "/app/data".into(),
            read_only: false,
            container_user: "65534:65534".into(),
            backup_policy: "Manual backup before release".into(),
        });
    let mut data_report = remote.clone();
    data_report.items.retain(|item| item.key != "mounts");
    readiness::check_remote(
        &with_data,
        &mut data_report,
        &database,
        &credentials,
        &known_hosts,
        &crate::execution::ExecutionCancellationRegistry::default(),
    )
    .unwrap();
    credentials.delete_profile_password(&profile_id).unwrap();
    assert!(
        data_report.items.iter().any(|item| item.key == "mounts"
            && item.status == readiness::CheckStatus::Notice
            && item.evidence == "DEPLOYMENT_CONTAINER_ACCESS_PROBE_REQUIRES_RELEASE_APPROVAL"),
        "SSH-user directory access must not certify container-user access: {data_report:?}"
    );
    assert!(
        remote
            .items
            .iter()
            .filter(|item| matches!(
                item.key.as_str(),
                "ssh" | "sftp" | "remoteDocker" | "remoteCompose" | "architecture"
            ))
            .all(|item| item.status == readiness::CheckStatus::Passed),
        "{remote:?}"
    );
    assert!(remote
        .items
        .iter()
        .any(|item| item.key == "directory" && item.status == readiness::CheckStatus::Blocked));
    assert!(remote
        .items
        .iter()
        .any(|item| item.key == "disk" && item.status == readiness::CheckStatus::Blocked));
    assert!(
        sftp.lstat(Path::new(&entry.environment.config.remote_root))
            .is_err(),
        "read-only checks must not create missing directories"
    );
    database
        .store_deployment_readiness(&entry, &remote)
        .unwrap();
    assert!(database
        .get_deployment_readiness(&entry.environment.id)
        .unwrap()
        .is_some());

    let mut changed = entry.clone();
    changed.environment.config.remote_root.push_str("-changed");
    let changed = database
        .save_deployment_application(&input(changed, workflow.revision))
        .unwrap();
    assert!(database
        .get_deployment_readiness(&entry.environment.id)
        .unwrap()
        .is_none());
    assert!(database
        .ensure_deployment_application_ready(&workflow_id, workflow.revision)
        .is_err());
    let historical = database
        .get_deployment_workflow_revision(&workflow_id, workflow.revision)
        .unwrap()
        .unwrap();
    assert_eq!(historical.definition, workflow.definition);
    assert_eq!(
        source_binding::capture(&original_binding)
            .unwrap()
            .snapshot
            .snapshot_digest,
        original.snapshot.snapshot_digest,
        "original project must remain unchanged"
    );
    drop(database);
    let reopened = Database::open(&database_path).unwrap();
    assert_eq!(
        reopened.list_deployment_applications().unwrap()[0].environment,
        changed.environment
    );
    let mut another = changed.clone();
    another.environment.id = uuid::Uuid::new_v4().to_string();
    another.environment.name = "Second environment".into();
    another.environment.revision = 0;
    another.environment.workflow_id = None;
    another.environment.config.remote_root.push_str("-second");
    let another = reopened
        .save_deployment_application(&input(another, 0))
        .unwrap();
    assert_eq!(reopened.list_deployment_applications().unwrap().len(), 2);
    let synchronized = reopened
        .get_deployment_workflow(&workflow_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        synchronized
            .definition
            .application_binding
            .as_ref()
            .unwrap()
            .source_revision,
        another.source.revision
    );
    assert_eq!(
        synchronized.definition.targets[0].remote_root,
        changed.environment.config.remote_root
    );
    assert_eq!(
        reopened
            .get_deployment_workflow_revision(&workflow_id, workflow.revision)
            .unwrap()
            .unwrap()
            .definition,
        workflow.definition
    );

    // Explicit association preserves custom nodes, input bindings, and outputs.
    let mut advanced = workflow.definition.clone();
    advanced.application_binding = None;
    let mut additional = advanced
        .nodes
        .iter()
        .find(|node| node.type_name == "verify.http")
        .unwrap()
        .clone();
    additional.id = "secondary-verification".into();
    additional.config["path"] = serde_json::json!("/for-you/");
    advanced.outputs.insert(
        "secondaryVerification".into(),
        super::workflow_schema::PortBinding {
            from_node_id: additional.id.clone(),
            from_port: "evidence".into(),
        },
    );
    advanced.nodes.push(additional);
    let legacy = reopened
        .create_deployment_workflow(&super::repository::CreateDeploymentWorkflowInput {
            name: "Explicit association".into(),
            definition: advanced.clone(),
            layout: None,
            enabled: true,
        })
        .unwrap();
    assert!(reopened
        .ensure_deployment_application_ready(&legacy.id, legacy.revision)
        .unwrap_err()
        .contains("ASSOCIATION_REQUIRED"));
    let mut association = another.clone();
    association.environment.id = uuid::Uuid::new_v4().to_string();
    association.environment.name = "Explicit association".into();
    association.environment.revision = 0;
    association.environment.workflow_id = Some(legacy.id.clone());
    let association = reopened
        .save_deployment_application(&input(association, legacy.revision))
        .unwrap();
    let associated = reopened
        .get_deployment_workflow(&legacy.id)
        .unwrap()
        .unwrap();
    assert_eq!(associated.definition.nodes.len(), advanced.nodes.len());
    assert_eq!(associated.definition.outputs, advanced.outputs);
    assert_eq!(associated.definition.nodes.last(), advanced.nodes.last());
    assert_eq!(
        reopened
            .get_deployment_workflow_revision(&legacy.id, legacy.revision)
            .unwrap()
            .unwrap()
            .definition,
        advanced
    );
    let mut managed_edit = associated.definition.clone();
    managed_edit
        .nodes
        .iter_mut()
        .find(|node| node.type_name == "build.docker-buildx")
        .unwrap()
        .config["dockerfile"] = serde_json::json!("Advanced.Dockerfile");
    let edited = reopened
        .update_deployment_workflow(
            &associated.id,
            associated.revision,
            &super::repository::UpdateDeploymentWorkflowInput {
                name: associated.name.clone(),
                definition: managed_edit.clone(),
                enabled: true,
            },
        )
        .unwrap();
    assert!(reopened
        .save_deployment_application(&input(association.clone(), edited.revision))
        .unwrap_err()
        .contains("managedFieldsChangedInAdvancedEditor"));
    assert_eq!(
        reopened
            .get_deployment_workflow(&associated.id)
            .unwrap()
            .unwrap()
            .definition,
        managed_edit
    );
    let mut unsupported = associated.definition.clone();
    unsupported
        .nodes
        .iter_mut()
        .find(|node| node.type_name == "artifact.bundle-compose")
        .unwrap()
        .config["composeFiles"] = serde_json::json!(["compose.yaml", "production.yaml"]);
    let custom = reopened
        .update_deployment_workflow(
            &associated.id,
            edited.revision,
            &super::repository::UpdateDeploymentWorkflowInput {
                name: associated.name,
                definition: unsupported.clone(),
                enabled: true,
            },
        )
        .unwrap();
    let before = reopened.list_deployment_applications().unwrap();
    assert!(reopened
        .save_deployment_application(&input(association, custom.revision))
        .unwrap_err()
        .contains("READ_ONLY"));
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(reopened.list_deployment_applications().unwrap()).unwrap(),
        "unmappable configuration must roll back the complete transaction"
    );
    assert_eq!(
        reopened
            .get_deployment_workflow(&custom.id)
            .unwrap()
            .unwrap()
            .definition,
        unsupported
    );
    if let Ok(path) = std::env::var("SHELLSPAN_PHASE2_REPORT") {
        std::fs::write(path,serde_json::to_vec_pretty(&serde_json::json!({
            "project":project,"originalSourceDigest":original.snapshot.snapshot_digest,"inspection":inspected,
            "entry":entry,"report":remote,"workflow":workflow,"draftSaved":true,"revisionConflictRejected":true,
            "profile":reopened.get_profile(&profile_id).unwrap(),"multipleEnvironmentsSynchronized":true,"customNodesPreserved":true,"unmappableGraphTransactionRolledBack":true,
            "previewDidNotWrite":true,"existingFilesPreserved":true,"projectScriptsExecuted":false,
            "missingRemoteDirectoryNotCreated":true,"productionServerTouched":false,"savedConfigurationReopened":true
        })).unwrap()).unwrap();
    }
}
