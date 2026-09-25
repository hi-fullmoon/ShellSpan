//! Application configuration is a projection onto the existing workflow engine.
//! Saving a draft performs local database writes only; it never executes a node.
use super::compiler::compile_workflow_definition;
use super::node_registry::DeploymentNodeRegistry;
use super::source_binding::{inspect_repository, SourceBinding};
use super::workflow_schema::DeploymentWorkflowDefinition;
use crate::db::{current_timestamp_ms, Database};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Application {
    pub id: String,
    pub name: String,
    pub source_binding_id: String,
    pub revision: u64,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DataDirectory {
    pub host_path: String,
    pub container_path: String,
    pub read_only: bool,
    pub container_user: String,
    pub backup_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvironmentConfig {
    pub template_kind: String,
    pub connection_profile_id: String,
    pub remote_root: String,
    pub platform: String,
    pub project_name: String,
    pub service: String,
    pub compose_file: String,
    pub dockerfile: String,
    pub build_context: String,
    pub access_url: String,
    pub base_path: String,
    pub container_port: u16,
    pub host_port: u16,
    pub bind_address: String,
    pub data_directories: Vec<DataDirectory>,
    pub non_sensitive_files: Vec<String>,
    pub existing_service: bool,
    pub management_method: String,
    pub recovery_instructions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Environment {
    pub id: String,
    pub application_id: String,
    pub name: String,
    pub revision: u64,
    pub workflow_id: Option<String>,
    pub config: EnvironmentConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApplicationEntry {
    pub application: Application,
    pub source: SourceBinding,
    pub environment: Environment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveApplicationInput {
    pub entry: ApplicationEntry,
    pub expected_application_revision: u64,
    pub expected_environment_revision: u64,
    pub expected_source_revision: u64,
    pub expected_workflow_revision: u64,
    /// An explicit existing workflow selection. Omitted for a new template.
    pub workflow_id: Option<String>,
}

fn encode<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

fn sql_revision(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "DEPLOYMENT_APPLICATION_REVISION_CONFLICT".into())
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 200
        && !value.chars().any(char::is_control)
}

fn absolute_directory(value: &str) -> bool {
    value.starts_with('/')
        && value != "/"
        && !value.contains('\0')
        && !value.split('/').any(|part| matches!(part, "." | ".."))
}

pub(crate) fn validate(entry: &ApplicationEntry) -> Result<(), String> {
    super::security::validate_bounded_safe_json(
        entry,
        64 * 1024,
        "DEPLOYMENT_APPLICATION_TOO_LARGE",
    )?;
    if !valid_name(&entry.application.name)
        || !valid_name(&entry.environment.name)
        || entry.application.id.is_empty()
        || entry.environment.id.is_empty()
        || entry.application.source_binding_id != entry.source.id
        || entry.environment.application_id != entry.application.id
        || encode(entry)?.len() > 64 * 1024
    {
        return Err("DEPLOYMENT_APPLICATION_INVALID".into());
    }
    let config = &entry.environment.config;
    for value in [
        &config.dockerfile,
        &config.compose_file,
        &config.build_context,
    ] {
        if !value.is_empty()
            && (std::path::Path::new(value).is_absolute()
                || std::path::Path::new(value).components().any(|component| {
                    !matches!(
                        component,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                }))
        {
            return Err("DEPLOYMENT_SOURCE_PATH_BOUNDARY".into());
        }
    }
    if !matches!(
        config.template_kind.as_str(),
        "dockerCompose" | "staticSite"
    ) {
        return Err("DEPLOYMENT_APPLICATION_TEMPLATE_INVALID".into());
    }
    if !config.remote_root.is_empty() && !absolute_directory(&config.remote_root) {
        return Err("DEPLOYMENT_APPLICATION_ROOT_INVALID".into());
    }
    if !config.access_url.is_empty() {
        let url = url::Url::parse(&config.access_url)
            .map_err(|_| "DEPLOYMENT_APPLICATION_URL_INVALID")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("DEPLOYMENT_APPLICATION_URL_INVALID".into());
        }
    }
    for directory in &config.data_directories {
        if !absolute_directory(&directory.host_path)
            || !absolute_directory(&directory.container_path)
            || directory.host_path == "/var/run/docker.sock"
            || (!config.remote_root.is_empty()
                && std::path::Path::new(&directory.host_path).starts_with(&config.remote_root)
                && !std::path::Path::new(&directory.host_path)
                    .starts_with(format!("{}/shared", config.remote_root)))
        {
            return Err("DEPLOYMENT_APPLICATION_DATA_PATH_INVALID".into());
        }
    }
    let (path, identity) = inspect_repository(&entry.source.local_path)?;
    if path != entry.source.local_path || identity != entry.source.repository_identity {
        return Err("DEPLOYMENT_SOURCE_REPOSITORY_CHANGED".into());
    }
    Ok(())
}

/// Only unique roles can be managed. The graph, bindings, and all unrelated
/// configuration stay intact, including advanced custom nodes.
fn synchronize(
    definition: &mut DeploymentWorkflowDefinition,
    entry: &ApplicationEntry,
) -> Result<(), String> {
    let config = &entry.environment.config;
    let compose = definition
        .nodes
        .iter()
        .any(|node| node.type_name == "deploy.compose");
    let static_site = definition
        .nodes
        .iter()
        .any(|node| node.type_name == "deploy.static-switch");
    if compose != (config.template_kind == "dockerCompose") || (!compose && !static_site) {
        return Err("DEPLOYMENT_APPLICATION_READ_ONLY:deploymentStrategy".into());
    }
    if definition.targets.len() != 1 {
        return Err("DEPLOYMENT_APPLICATION_READ_ONLY:targets".into());
    }
    let sources: Vec<_> = definition
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.type_name == "source.snapshot")
        .map(|(i, _)| i)
        .collect();
    if sources.len() != 1 {
        return Err("DEPLOYMENT_APPLICATION_READ_ONLY:source.snapshot".into());
    }
    definition.targets[0].connection_profile_id = config.connection_profile_id.clone();
    definition.targets[0].remote_root = config.remote_root.clone();
    definition.nodes[sources[0]].config["binding"] =
        serde_json::to_value(&entry.source).map_err(|e| e.to_string())?;
    for role in [
        "build.docker-buildx",
        "artifact.bundle-compose",
        "deploy.compose",
    ] {
        let indices: Vec<_> = definition
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.type_name == role)
            .map(|(i, _)| i)
            .collect();
        if indices.len() > 1 {
            return Err(format!("DEPLOYMENT_APPLICATION_READ_ONLY:{role}"));
        }
        if let Some(index) = indices.first() {
            let fields = &mut definition.nodes[*index].config;
            match role {
                "build.docker-buildx" => {
                    fields["platform"] = json!(config.platform);
                    fields["dockerfile"] = json!(config.dockerfile);
                    fields["context"] = json!(config.build_context);
                }
                "artifact.bundle-compose" => {
                    if fields
                        .get("composeFiles")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|files| files.len() != 1)
                        || fields
                            .get("services")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|services| services.len() != 1)
                    {
                        return Err(format!("DEPLOYMENT_APPLICATION_READ_ONLY:nodes/{}/config/composeFiles,services",definition.nodes[*index].id));
                    }
                    fields["composeFiles"] = json!([config.compose_file]);
                    fields["projectName"] = json!(config.project_name);
                    fields["services"] = json!([config.service]);
                    fields["nonSensitiveFiles"] = json!(config.non_sensitive_files);
                    fields["registeredMounts"] = json!(config.data_directories.iter().map(|directory| json!({
                        "source": directory.host_path, "target": directory.container_path, "readOnly": directory.read_only
                    })).collect::<Vec<_>>());
                }
                "deploy.compose" => {
                    fields["projectName"] = json!(config.project_name);
                    fields["services"] = json!([config.service]);
                }
                _ => unreachable!(),
            }
        }
    }
    definition.application_binding = Some(super::workflow_schema::WorkflowApplicationBinding {
        application_id: entry.application.id.clone(),
        application_revision: entry.application.revision,
        environment_id: entry.environment.id.clone(),
        environment_revision: entry.environment.revision,
        source_binding_id: entry.source.id.clone(),
        source_revision: entry.source.revision,
    });
    Ok(())
}

impl Database {
    pub(crate) fn list_deployment_applications(&self) -> Result<Vec<ApplicationEntry>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.id,a.name,a.source_binding_id,a.revision,a.archived,s.binding_json,
                 e.id,e.name,e.revision,e.workflow_id,e.config_json
                 FROM deployment_applications a JOIN deployment_source_bindings s ON s.id=a.source_binding_id
                 JOIN deployment_environments e ON e.application_id=a.id ORDER BY a.name,e.name")
                .map_err(|e| e.to_string())?;
            let rows = statement.query_map([], |row| {
                Ok((Application { id: row.get(0)?, name: row.get(1)?, source_binding_id: row.get(2)?,
                    revision: row.get::<_, i64>(3)? as u64, archived: row.get(4)? }, row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, i64>(8)? as u64,
                    row.get::<_, Option<String>>(9)?, row.get::<_, String>(10)?))
            }).map_err(|e| e.to_string())?;
            rows.map(|row| {
                let (application, source, id, name, revision, workflow_id, config) = row.map_err(|e| e.to_string())?;
                let environment = Environment { id, application_id: application.id.clone(), name, revision,
                    workflow_id, config: serde_json::from_str(&config).map_err(|e| e.to_string())? };
                Ok(ApplicationEntry { application, environment, source: serde_json::from_str(&source).map_err(|e| e.to_string())? })
            }).collect()
        })
    }

    pub(crate) fn save_deployment_application(
        &self,
        input: &SaveApplicationInput,
    ) -> Result<ApplicationEntry, String> {
        validate(&input.entry)?;
        let mut entry = input.entry.clone();
        entry.application.revision = input
            .expected_application_revision
            .checked_add(1)
            .ok_or("DEPLOYMENT_APPLICATION_REVISION_CONFLICT")?;
        entry.environment.revision = input
            .expected_environment_revision
            .checked_add(1)
            .ok_or("DEPLOYMENT_APPLICATION_REVISION_CONFLICT")?;
        entry.source.revision = input
            .expected_source_revision
            .checked_add(1)
            .ok_or("DEPLOYMENT_APPLICATION_REVISION_CONFLICT")?;
        let now = current_timestamp_ms();
        self.with_transaction(|tx| {
            for (table, id, expected) in [
                ("deployment_applications", &entry.application.id, input.expected_application_revision),
                ("deployment_environments", &entry.environment.id, input.expected_environment_revision),
                ("deployment_source_bindings", &entry.source.id, input.expected_source_revision),
            ] {
                let revision: Option<i64> = tx.query_row(&format!("SELECT revision FROM {table} WHERE id=?1"), [id], |row| row.get(0))
                    .optional().map_err(|e| e.to_string())?;
                if revision.unwrap_or(0) != sql_revision(expected)? { return Err("DEPLOYMENT_APPLICATION_REVISION_CONFLICT".into()); }
            }
            let source_id: Option<String> = tx.query_row("SELECT source_binding_id FROM deployment_applications WHERE id=?1", [&entry.application.id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
            if source_id.as_ref().is_some_and(|id| *id != entry.source.id) { return Err("DEPLOYMENT_APPLICATION_ASSOCIATION_CHANGED".into()); }
            let previous_source: Option<String> = tx.query_row("SELECT binding_json FROM deployment_source_bindings WHERE id=?1",[&entry.source.id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
            if let Some(previous_source)=&previous_source {
                let previous: SourceBinding=serde_json::from_str(previous_source).map_err(|e|e.to_string())?;
                if previous.repository_identity!=entry.source.repository_identity { return Err("DEPLOYMENT_SOURCE_REPOSITORY_CHANGED".into()); }
            }
            // A shared source revision cannot leave other environments with stale
            // workflow projections. Synchronize every related definition below.
            let existing: Option<(String, Option<String>)> = tx.query_row(
                "SELECT application_id,workflow_id FROM deployment_environments WHERE id=?1", [&entry.environment.id],
                |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
            if let Some((application_id, workflow_id)) = existing {
                if application_id != entry.application.id || workflow_id != input.workflow_id {
                    return Err("DEPLOYMENT_APPLICATION_ASSOCIATION_CHANGED".into());
                }
            }
            let mut definition: DeploymentWorkflowDefinition = if let Some(id) = &input.workflow_id {
                let (revision, text): (i64, String) = tx.query_row(
                    "SELECT w.head_revision,r.definition_json FROM deployment_workflows w JOIN deployment_workflow_revisions r
                     ON r.workflow_id=w.id AND r.revision=w.head_revision WHERE w.id=?1 AND w.archived=0", [id],
                    |row| Ok((row.get(0)?,row.get(1)?))).map_err(|_| "DEPLOYMENT_WORKFLOW_NOT_FOUND")?;
                if revision != sql_revision(input.expected_workflow_revision)? { return Err("DEPLOYMENT_WORKFLOW_REVISION_CONFLICT".into()); }
                let definition: DeploymentWorkflowDefinition = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if input.expected_environment_revision > 0 {
                    let stored_config: String = tx.query_row("SELECT config_json FROM deployment_environments WHERE id=?1", [&entry.environment.id], |row| row.get(0)).map_err(|e|e.to_string())?;
                    let mut previous = input.entry.clone();
                    previous.application.revision = input.expected_application_revision;
                    previous.environment.revision = input.expected_environment_revision;
                    previous.environment.config = serde_json::from_str(&stored_config).map_err(|e|e.to_string())?;
                    previous.source = serde_json::from_str(previous_source.as_deref().ok_or("DEPLOYMENT_APPLICATION_ASSOCIATION_CHANGED")?).map_err(|e|e.to_string())?;
                    let mut projected = definition.clone();
                    synchronize(&mut projected, &previous)?;
                    if projected != definition { return Err("DEPLOYMENT_APPLICATION_READ_ONLY:managedFieldsChangedInAdvancedEditor".into()); }
                }
                definition
            } else if entry.environment.config.template_kind == "staticSite" {
                super::static_site_template::static_site_template(&entry.environment.config.connection_profile_id,&entry.environment.config.remote_root)?.0
            } else {
                serde_json::from_str(include_str!("../../../protocol/deployment/fixtures/docker-compose-workflow.json")).map_err(|e| e.to_string())?
            };
            // Incomplete drafts stay local and cannot be admitted to preparation.
            let config = &entry.environment.config;
            let complete = !config.connection_profile_id.is_empty() && !config.remote_root.is_empty()
                && !config.service.is_empty() && !config.project_name.is_empty();
            if complete {
                let profile: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM profiles WHERE id=?1)", [&config.connection_profile_id], |row| row.get(0)).map_err(|e| e.to_string())?;
                if !profile { return Err("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND".into()); }
                synchronize(&mut definition, &entry)?;
                if input.workflow_id.is_none() && entry.environment.config.template_kind == "dockerCompose" {
                    if let Some(verification) = definition.nodes.iter_mut().find(|node|node.type_name=="verify.http") {
                        verification.config["scheme"] = json!("http");
                        verification.config["port"] = json!(config.host_port);
                        verification.config["path"] = json!(config.base_path);
                    }
                }
                let compiled = compile_workflow_definition(&definition, &DeploymentNodeRegistry::mvp()).map_err(|e| e.to_string())?;
                let id = input.workflow_id.clone().unwrap_or_else(|| format!("workflow-{}", uuid::Uuid::new_v4()));
                let revision = if input.workflow_id.is_some() { sql_revision(input.expected_workflow_revision)?.checked_add(1).ok_or("DEPLOYMENT_WORKFLOW_REVISION_CONFLICT")? } else { 1 };
                tx.execute("INSERT INTO deployment_workflows (id,name,enabled,archived,head_revision,head_layout_revision,created_at,updated_at)
                    VALUES (?1,?2,1,0,?3,0,?4,?4) ON CONFLICT(id) DO UPDATE SET head_revision=excluded.head_revision,updated_at=excluded.updated_at",
                    params![id,entry.application.name,revision,now]).map_err(|e| e.to_string())?;
                tx.execute("INSERT INTO deployment_workflow_revisions (workflow_id,revision,schema_version,definition_json,definition_digest,created_at)
                    VALUES (?1,?2,3,?3,?4,?5)", params![id,revision,encode(&definition)?,compiled.definition_digest,now]).map_err(|e| e.to_string())?;
                entry.environment.workflow_id = Some(id);
            } else if input.workflow_id.is_some() {
                return Err("DEPLOYMENT_APPLICATION_LINKED_FIELDS_REQUIRED".into());
            } else { entry.environment.workflow_id = None; }
            tx.execute("INSERT INTO deployment_source_bindings VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,binding_json=excluded.binding_json",
                params![entry.source.id,sql_revision(entry.source.revision)?,encode(&entry.source)?]).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO deployment_applications VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,archived=excluded.archived",
                params![entry.application.id,entry.application.name,entry.source.id,sql_revision(entry.application.revision)?,entry.application.archived]).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO deployment_environments VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,workflow_id=excluded.workflow_id,config_json=excluded.config_json,updated_at=excluded.updated_at",
                params![entry.environment.id,entry.application.id,entry.environment.name,sql_revision(entry.environment.revision)?,entry.environment.workflow_id,encode(config)?,now]).map_err(|e| e.to_string())?;
            let mut statement = tx.prepare("SELECT e.id,e.name,e.revision,e.config_json,w.id,w.head_revision,r.definition_json
                FROM deployment_environments e JOIN deployment_workflows w ON w.id=e.workflow_id
                JOIN deployment_workflow_revisions r ON r.workflow_id=w.id AND r.revision=w.head_revision
                WHERE e.application_id=?1 AND e.id<>?2").map_err(|e| e.to_string())?;
            let others = statement.query_map(params![entry.application.id,entry.environment.id], |row| Ok((
                row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, i64>(2)?,row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,row.get::<_, i64>(5)?,row.get::<_, String>(6)?
            ))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
            drop(statement);
            for (id,name,revision,config,workflow_id,workflow_revision,definition) in others {
                let related = ApplicationEntry { application: entry.application.clone(), source: entry.source.clone(), environment: Environment {
                    id,name,revision: revision as u64,application_id: entry.application.id.clone(),workflow_id: Some(workflow_id.clone()),
                    config: serde_json::from_str(&config).map_err(|e| e.to_string())? } };
                let mut definition: DeploymentWorkflowDefinition = serde_json::from_str(&definition).map_err(|e| e.to_string())?;
                let mut previous = related.clone();
                previous.application.revision = input.expected_application_revision;
                previous.source = serde_json::from_str(previous_source.as_deref().ok_or("DEPLOYMENT_APPLICATION_ASSOCIATION_CHANGED")?).map_err(|e|e.to_string())?;
                let mut projected = definition.clone();
                synchronize(&mut projected, &previous)?;
                if projected != definition { return Err(format!("DEPLOYMENT_APPLICATION_READ_ONLY:workflows/{workflow_id}/managedFieldsChangedInAdvancedEditor")); }
                synchronize(&mut definition,&related)?;
                let compiled = compile_workflow_definition(&definition,&DeploymentNodeRegistry::mvp()).map_err(|e| e.to_string())?;
                let next = workflow_revision.checked_add(1).ok_or("DEPLOYMENT_WORKFLOW_REVISION_CONFLICT")?;
                tx.execute("UPDATE deployment_workflows SET head_revision=?2,updated_at=?3 WHERE id=?1", params![workflow_id,next,now]).map_err(|e| e.to_string())?;
                tx.execute("INSERT INTO deployment_workflow_revisions VALUES (?1,?2,3,?3,?4,?5)",params![workflow_id,next,encode(&definition)?,compiled.definition_digest,now]).map_err(|e| e.to_string())?;
            }
            Ok(())
        })?;
        Ok(entry)
    }

    pub(crate) fn store_deployment_readiness(
        &self,
        entry: &ApplicationEntry,
        report: &super::readiness::ReadinessReport,
    ) -> Result<(), String> {
        self.with_transaction(|tx| {
            let revision: Option<(i64,i64,i64)> = tx.query_row("SELECT e.revision,s.revision,w.head_revision FROM deployment_environments e
                JOIN deployment_applications a ON a.id=e.application_id JOIN deployment_source_bindings s ON s.id=a.source_binding_id
                JOIN deployment_workflows w ON w.id=e.workflow_id WHERE e.id=?1", [&entry.environment.id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
                .optional().map_err(|e| e.to_string())?;
            let Some((environment_revision,source_revision,workflow_revision)) = revision else { return Ok(()); };
            if environment_revision != sql_revision(entry.environment.revision)? || source_revision != sql_revision(entry.source.revision)? {
                return Err("DEPLOYMENT_APPLICATION_REVISION_CONFLICT".into());
            }
            // Compare the exact persisted configuration; an unsaved form cannot
            // inject a readiness report for a different saved environment.
            let stored: String = tx.query_row("SELECT config_json FROM deployment_environments WHERE id=?1",[&entry.environment.id],|row|row.get(0)).map_err(|e|e.to_string())?;
            if stored != encode(&entry.environment.config)? { return Ok(()); }
            tx.execute("INSERT INTO deployment_readiness_reports VALUES (?1,?2,?3,?4,?5,?6,?7)",params![uuid::Uuid::new_v4().to_string(),entry.environment.id,
                environment_revision,source_revision,workflow_revision,report.checked_at,encode(report)?]).map_err(|e|e.to_string())?;
            Ok(())
        })
    }

    pub(crate) fn get_deployment_readiness(
        &self,
        environment_id: &str,
    ) -> Result<Option<super::readiness::ReadinessReport>, String> {
        self.with_connection(|connection| {
            let report: Option<String> = connection.query_row("SELECT r.report_json FROM deployment_readiness_reports r
                JOIN deployment_environments e ON e.id=r.environment_id AND e.revision=r.environment_revision
                JOIN deployment_applications a ON a.id=e.application_id JOIN deployment_source_bindings s ON s.id=a.source_binding_id AND s.revision=r.source_revision
                JOIN deployment_workflows w ON w.id=e.workflow_id AND w.head_revision=r.workflow_revision
                WHERE e.id=?1 ORDER BY r.checked_at DESC LIMIT 1",[environment_id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
            report.map(|text| serde_json::from_str(&text).map_err(|e|e.to_string())).transpose()
        })
    }

    pub(crate) fn ensure_deployment_application_ready(
        &self,
        workflow_id: &str,
        workflow_revision: u64,
    ) -> Result<(), String> {
        let entry = self
            .list_deployment_applications()?
            .into_iter()
            .find(|entry| entry.environment.workflow_id.as_deref() == Some(workflow_id))
            .ok_or("DEPLOYMENT_APPLICATION_ASSOCIATION_REQUIRED")?;
        let workflow = self
            .get_deployment_workflow(workflow_id)?
            .ok_or("DEPLOYMENT_WORKFLOW_NOT_FOUND")?;
        if workflow.revision != workflow_revision || entry.application.archived {
            return Err("DEPLOYMENT_APPLICATION_REVISION_CONFLICT".into());
        }
        let mut synchronized = workflow.definition.clone();
        synchronize(&mut synchronized, &entry)?;
        if synchronized != workflow.definition {
            return Err("DEPLOYMENT_APPLICATION_MANAGED_FIELDS_CHANGED".into());
        }
        let report = self
            .get_deployment_readiness(&entry.environment.id)?
            .ok_or("DEPLOYMENT_APPLICATION_READINESS_REQUIRED")?;
        if report.config_digest
            != super::canonicalization::canonical_sha256(&entry).map_err(|e| e.to_string())?
            || current_timestamp_ms().saturating_sub(report.checked_at) > 15 * 60 * 1000
            || report.items.iter().any(|item| {
                matches!(
                    item.status,
                    super::readiness::CheckStatus::Blocked
                        | super::readiness::CheckStatus::Unchecked
                )
            })
        {
            return Err("DEPLOYMENT_APPLICATION_READINESS_REQUIRED".into());
        }
        Ok(())
    }
}
