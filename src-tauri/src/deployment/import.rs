//! Explicit local-only configuration import. It never prepares or starts a run.
use super::applications::{ApplicationEntry, SaveApplicationInput};
use crate::db::{current_timestamp_ms, Database};
use crate::keychain::CredentialManager;
use crate::models::{ProfileAuthMethod, ProfileRow};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    entry: ApplicationEntry,
    #[serde(default)]
    expected_workflow_revision: u64,
    #[serde(default)]
    reconcile_managed_fields: bool,
    #[serde(default)]
    connection: Option<Connection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Connection {
    name: String,
    host: String,
    port: u16,
    username: String,
    private_key_file: PathBuf,
}

pub(crate) fn import(database_path: &Path, package_path: &Path) -> Result<String, String> {
    let directory = database_path
        .parent()
        .ok_or("DEPLOYMENT_IMPORT_DATABASE_INVALID")?;
    super::runtime::DeploymentWorkflowRuntime::initialize(directory)?
        .ensure(super::runtime::DeploymentWorkflowAdmission::Mutating)?;
    if !database_path.is_file() || !package_path.is_file() {
        return Err("DEPLOYMENT_IMPORT_FILE_REQUIRED".into());
    }
    let metadata =
        std::fs::metadata(package_path).map_err(|_| "DEPLOYMENT_IMPORT_FILE_REQUIRED")?;
    if metadata.len() > 64 * 1024 {
        return Err("DEPLOYMENT_IMPORT_TOO_LARGE".into());
    }
    let mut package: Package = serde_json::from_slice(
        &std::fs::read(package_path).map_err(|_| "DEPLOYMENT_IMPORT_READ_FAILED")?,
    )
    .map_err(|_| "DEPLOYMENT_IMPORT_INVALID")?;
    // The repository's actual identity is authoritative, never a copied ID.
    let source = super::source_binding::inspect(&package.entry.source.local_path)?;
    package.entry.source.repository_identity = source.binding.repository_identity;
    super::applications::validate(&package.entry)?;
    let database = Database::open(database_path)?;
    if package.entry.application.revision == 0
        && database
            .list_deployment_applications()?
            .iter()
            .any(|entry| {
                entry.application.id == package.entry.application.id
                    || entry.application.name == package.entry.application.name
            })
    {
        return Err("DEPLOYMENT_IMPORT_APPLICATION_EXISTS".into());
    }
    let profile_id = &package.entry.environment.config.connection_profile_id;
    let credentials = CredentialManager::new();
    let mut created_key = None;
    if let Some(connection) = package.connection {
        if package.entry.application.revision != 0 {
            return Err("DEPLOYMENT_IMPORT_CONNECTION_NEW_ONLY".into());
        }
        if database.get_profile(profile_id)?.is_some() {
            return Err("DEPLOYMENT_IMPORT_PROFILE_EXISTS".into());
        }
        if connection.port == 0
            || connection.host.is_empty()
            || connection.username.is_empty()
            || connection.name.is_empty()
            || !connection.private_key_file.is_absolute()
        {
            return Err("DEPLOYMENT_IMPORT_CONNECTION_INVALID".into());
        }
        let key_metadata = std::fs::metadata(&connection.private_key_file)
            .map_err(|_| "DEPLOYMENT_IMPORT_KEY_UNAVAILABLE")?;
        if !key_metadata.is_file() || key_metadata.len() > 64 * 1024 {
            return Err("DEPLOYMENT_IMPORT_KEY_INVALID".into());
        }
        let public = Command::new("ssh-keygen")
            .args(["-y", "-P", "", "-f"])
            .arg(&connection.private_key_file)
            .stdin(Stdio::null())
            .output()
            .map_err(|_| "DEPLOYMENT_IMPORT_KEY_INVALID")?;
        if !public.status.success() {
            return Err("DEPLOYMENT_IMPORT_KEY_REQUIRES_APP_IMPORT".into());
        }
        let public =
            String::from_utf8(public.stdout).map_err(|_| "DEPLOYMENT_IMPORT_KEY_INVALID")?;
        let private = std::fs::read_to_string(&connection.private_key_file)
            .map_err(|_| "DEPLOYMENT_IMPORT_KEY_INVALID")?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = current_timestamp_ms();
        let key_type = public.split_whitespace().next().unwrap_or("unknown");
        let payload = serde_json::json!({"kind":"keyFile", "label":connection.name, "privateKey":private,
            "publicKey":public, "keyType":key_type, "updatedAt":now});
        credentials.store_key_credential(&id, &payload.to_string())?;
        let result = database
            .upsert_key_credential(
                &id,
                &connection.name,
                key_type,
                "keyFile",
                crate::keychain::KEY_SERVICE,
                Some(&public),
                None,
                now,
            )
            .and_then(|_| {
                database.insert_profile(&ProfileRow {
                    id: profile_id.clone(),
                    name: connection.name,
                    host: connection.host,
                    port: connection.port,
                    username: connection.username,
                    auth_method: ProfileAuthMethod::Key,
                    keychain_key_id: Some(id.clone()),
                    jump_host_config: None,
                    organization_json: None,
                    created_at: now,
                    updated_at: now,
                })
            });
        if let Err(error) = result {
            let _ = database.delete_key_credential(&id);
            let _ = credentials.delete_key_credential(&id);
            return Err(error);
        }
        created_key = Some(id);
    }
    let saved = database.save_deployment_application(&SaveApplicationInput {
        reconcile_managed_fields: package.reconcile_managed_fields,
        entry: package.entry.clone(),
        expected_application_revision: package.entry.application.revision,
        expected_environment_revision: package.entry.environment.revision,
        expected_source_revision: if package.entry.application.revision == 0 {
            0
        } else {
            package.entry.source.revision
        },
        expected_workflow_revision: package.expected_workflow_revision,
        workflow_id: package.entry.environment.workflow_id.clone(),
    });
    match saved {
        Ok(saved) => {
            serde_json::to_string(&saved).map_err(|_| "DEPLOYMENT_IMPORT_ENCODE_FAILED".into())
        }
        Err(error) => {
            if let Some(id) = created_key {
                let _ = database.delete_profile(profile_id);
                let _ = database.delete_key_credential(&id);
                let _ = credentials.delete_key_credential(&id);
            }
            Err(error)
        }
    }
}

pub(crate) fn check(database_path: &Path, application_id: &str) -> Result<String, String> {
    if !database_path.is_file() {
        return Err("DEPLOYMENT_IMPORT_DATABASE_INVALID".into());
    }
    let directory = database_path
        .parent()
        .ok_or("DEPLOYMENT_IMPORT_DATABASE_INVALID")?;
    super::runtime::DeploymentWorkflowRuntime::initialize(directory)?
        .ensure(super::runtime::DeploymentWorkflowAdmission::ReadOnly)?;
    let database = Database::open(database_path)?;
    let entry = database
        .list_deployment_applications()?
        .into_iter()
        .find(|entry| entry.application.id == application_id)
        .ok_or("DEPLOYMENT_APPLICATION_NOT_FOUND")?;
    let mut report = super::readiness::check_local(&entry)?;
    super::readiness::check_remote(
        &entry,
        &mut report,
        &database,
        &CredentialManager::new(),
        &directory.join("known_hosts"),
        &crate::execution::ExecutionCancellationRegistry::default(),
    )?;
    database.store_deployment_readiness(&entry, &report)?;
    serde_json::to_string(&report).map_err(|_| "DEPLOYMENT_READINESS_ENCODE_FAILED".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_local_draft_with_revision_checks_and_never_creates_runs() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("project");
        std::fs::create_dir(&root).unwrap();
        for arguments in [
            vec!["init", "--quiet"],
            vec![
                "-c",
                "user.name=Deployment",
                "-c",
                "user.email=deployment@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "--quiet",
                "-m",
                "Initialize deployment import project",
            ],
        ] {
            assert!(Command::new("git")
                .args(arguments)
                .current_dir(&root)
                .status()
                .unwrap()
                .success());
        }
        let database_path = temporary.path().join("application.db");
        let database = Database::open(&database_path).unwrap();
        let source = super::super::source_binding::inspect(&root)
            .unwrap()
            .binding;
        let package_path = temporary.path().join("application.json");
        let package = serde_json::json!({"entry":{
            "application":{"id":"imported-app","name":"Imported application","sourceBindingId":source.id,"revision":0,"archived":false},
            "source":source,
            "environment":{"id":"imported-environment","applicationId":"imported-app","name":"Production","revision":0,"workflowId":null,"config":{
                "templateKind":"dockerCompose","connectionProfileId":"","remoteRoot":"","platform":"linux/amd64","projectName":"imported-app","service":"web",
                "composeFile":"compose.yaml","dockerfile":"Dockerfile","buildContext":".","accessUrl":"","basePath":"/","containerPort":3000,"hostPort":3000,
                "bindAddress":"127.0.0.1","dataDirectories":[],"nonSensitiveFiles":[],"existingService":false,"managementMethod":"","recoveryInstructions":""
            }}
        }});
        std::fs::write(&package_path, serde_json::to_vec(&package).unwrap()).unwrap();
        let saved: ApplicationEntry =
            serde_json::from_str(&import(&database_path, &package_path).unwrap()).unwrap();
        assert_eq!(saved.application.revision, 1);
        assert!(saved.environment.workflow_id.is_none());
        assert_eq!(
            import(&database_path, &package_path).unwrap_err(),
            "DEPLOYMENT_IMPORT_APPLICATION_EXISTS"
        );
        std::fs::write(
            &package_path,
            serde_json::to_vec(&serde_json::json!({"entry":saved})).unwrap(),
        )
        .unwrap();
        let updated: ApplicationEntry =
            serde_json::from_str(&import(&database_path, &package_path).unwrap()).unwrap();
        assert_eq!(updated.application.revision, 2);
        assert!(import(&database_path, &package_path).is_err());
        database
            .with_connection(|connection| {
                let runs: i64 = connection
                    .query_row("SELECT COUNT(*) FROM deployment_runs", [], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                assert_eq!(runs, 0);
                Ok(())
            })
            .unwrap();
    }
}
