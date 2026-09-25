//! Read-only onboarding checks. No build, install, mkdir, service control, or
//! production-write capability is exposed by this interface.
use super::applications::ApplicationEntry;
use super::canonicalization::canonical_sha256;
use super::compose_release::{BundleComposeConfig, RegisteredBindMount};
use super::docker_compose_executor::fixed_command;
use super::source_binding::{inspect, SourceBindingInspection};
use crate::db::current_timestamp_ms;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInspection {
    pub source: SourceBindingInspection,
    pub detected_files: Vec<String>,
    pub compose_services: Vec<String>,
    pub suggested_template: String,
}

pub(crate) fn inspect_project(path: &Path) -> Result<ProjectInspection, String> {
    let source = inspect(path)?;
    let root = &source.binding.local_path;
    let detected_files = [
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "bun.lock",
        "Dockerfile",
        "compose.yml",
        "compose.yaml",
        "docker-compose.yml",
        "docker-compose.yaml",
        "next.config.ts",
        "next.config.js",
        "vite.config.ts",
    ]
    .into_iter()
    .filter(|file| root.join(file).is_file())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let mut compose_services = Vec::new();
    for name in [
        "compose.yml",
        "compose.yaml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ] {
        if !detected_files.iter().any(|file| file == name) {
            continue;
        }
        let path = root.join(name);
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 {
            return Err("DEPLOYMENT_SOURCE_SYMLINK_OR_SIZE_UNSUPPORTED".into());
        }
        let document: serde_json::Value =
            serde_yaml::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|_| "DEPLOYMENT_COMPOSE_YAML_INVALID")?;
        if let Some(services) = document
            .get("services")
            .and_then(serde_json::Value::as_object)
        {
            compose_services.extend(services.keys().cloned());
        }
    }
    compose_services.sort();
    compose_services.dedup();
    let suggested_template = if compose_services.is_empty()
        && detected_files.iter().any(|file| file == "vite.config.ts")
    {
        "staticSite"
    } else {
        "dockerCompose"
    }
    .to_string();
    Ok(ProjectInspection {
        source,
        detected_files,
        compose_services,
        suggested_template,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CheckStatus {
    Passed,
    Blocked,
    Notice,
    Unchecked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadinessItem {
    pub key: String,
    pub status: CheckStatus,
    pub location: String,
    pub evidence: String,
    pub checked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadinessReport {
    pub config_digest: String,
    pub checked_at: i64,
    pub items: Vec<ReadinessItem>,
}

impl ReadinessReport {
    fn record(&mut self, key: &str, location: impl Into<String>, result: Result<(), String>) {
        let (status, evidence) = match result {
            Ok(()) => (CheckStatus::Passed, String::new()),
            Err(error) => (CheckStatus::Blocked, error),
        };
        self.items.push(ReadinessItem {
            key: key.into(),
            status,
            location: location.into(),
            evidence,
            checked_at: Some(current_timestamp_ms()),
        });
    }
}

pub(crate) fn check_local(entry: &ApplicationEntry) -> Result<ReadinessReport, String> {
    let config = &entry.environment.config;
    let mut report = ReadinessReport {
        config_digest: canonical_sha256(entry).map_err(|e| e.to_string())?,
        checked_at: current_timestamp_ms(),
        items: Vec::new(),
    };
    let cancellation = CancellationToken::new();
    if config.template_kind == "dockerCompose" {
        for (key, args) in [
            ("docker", vec!["info", "--format", "{{.OSType}}"]),
            ("buildx", vec!["buildx", "version"]),
        ] {
            report.record(
                key,
                "Docker",
                fixed_command(
                    "docker",
                    &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
                    &entry.source.local_path,
                    &cancellation,
                    Duration::from_secs(15),
                )
                .map(|_| ())
                .map_err(|e| e.message),
            );
        }
    }
    let captured = super::source_binding::capture_ref(
        &entry.source,
        config.git_ref.as_deref().unwrap_or("workspace"),
        &cancellation,
    );
    report.record(
        "source",
        entry.source.local_path.display().to_string(),
        captured.as_ref().map(|_| ()).map_err(Clone::clone),
    );
    if let Ok(captured) = captured {
        let root = captured.directory.path();
        report.record(
            "lockfile",
            "package.json",
            if !root.join("package.json").exists()
                || [
                    "pnpm-lock.yaml",
                    "package-lock.json",
                    "yarn.lock",
                    "bun.lock",
                ]
                .iter()
                .any(|file| root.join(file).is_file())
            {
                Ok(())
            } else {
                Err("DEPLOYMENT_LOCKFILE_MISSING".into())
            },
        );
        if config.template_kind == "dockerCompose" {
            report.record(
                "dockerfile",
                &config.dockerfile,
                if root.join(&config.dockerfile).is_file() {
                    Ok(())
                } else {
                    Err("DEPLOYMENT_DOCKERFILE_MISSING".into())
                },
            );
            let bundle = BundleComposeConfig {
                host_compose: config.host_compose.clone(),
                compose_files: vec![config.compose_file.clone()],
                project_name: config.project_name.clone(),
                services: vec![config.service.clone()],
                registered_mounts: config
                    .data_directories
                    .iter()
                    .map(|directory| RegisteredBindMount {
                        source: directory.host_path.clone(),
                        target: directory.container_path.clone(),
                        read_only: directory.read_only,
                    })
                    .collect(),
                non_sensitive_files: config.non_sensitive_files.clone(),
            };
            // This only asks the official Compose parser to validate configuration.
            // The resulting temporary directory is discarded and is not an artifact.
            report.record(
                "compose",
                &config.compose_file,
                super::compose_release::compile(
                    root,
                    &bundle,
                    "shellspan/readiness:configuration-only",
                    &cancellation,
                )
                .map_err(|e| e.message)
                .and_then(|compiled| {
                    if config.host_compose.is_some() {
                        return Ok(());
                    }
                    let document: serde_json::Value = serde_yaml::from_slice(
                        &std::fs::read(compiled.path().join("compose.yaml"))
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    let service = &document["services"][&config.service];
                    let ports = service["ports"]
                        .as_array()
                        .ok_or("DEPLOYMENT_COMPOSE_PORT_MAPPING_REQUIRED")?;
                    if ports.len() != 1
                        || ports[0]["target"].as_u64() != Some(u64::from(config.container_port))
                        || ports[0]["published"].as_str()
                            != Some(config.host_port.to_string().as_str())
                        || ports[0]["host_ip"].as_str() != Some(config.bind_address.as_str())
                    {
                        return Err("DEPLOYMENT_COMPOSE_PORT_CONFIGURATION_MISMATCH".into());
                    }
                    if config.data_directories.iter().any(|directory| {
                        service["user"].as_str() != Some(directory.container_user.as_str())
                    }) {
                        return Err("DEPLOYMENT_COMPOSE_CONTAINER_USER_MISMATCH".into());
                    }
                    Ok(())
                }),
            );
        } else {
            report.record(
                "staticBuild",
                "package.json",
                std::fs::read(root.join("package.json"))
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| {
                        let package: serde_json::Value =
                            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                        if package
                            .pointer("/scripts/build")
                            .and_then(serde_json::Value::as_str)
                            .is_none()
                        {
                            return Err("DEPLOYMENT_BUILD_SCRIPT_REQUIRED".into());
                        }
                        Ok(())
                    }),
            );
        }
    }
    report.record(
        "configuration",
        &entry.environment.name,
        if config.connection_profile_id.is_empty()
            || config.remote_root.is_empty()
            || !matches!(config.platform.as_str(), "linux/amd64" | "linux/arm64")
            || config.host_port == 0
            || config.container_port == 0
            || !matches!(config.bind_address.as_str(), "127.0.0.1" | "::1")
        {
            Err("DEPLOYMENT_ENVIRONMENT_INCOMPLETE".into())
        } else {
            Ok(())
        },
    );
    report.record(
        "takeover",
        &config.management_method,
        if config.existing_service && config.host_compose.is_none() {
            Err("DEPLOYMENT_EXISTING_SERVICE_REQUIRES_TAKEOVER_PLAN".into())
        } else {
            Ok(())
        },
    );
    for directory in &config.data_directories {
        report.record(
            "dataPolicy",
            &directory.host_path,
            if !super::compose_release::numeric_container_user(&directory.container_user)
                || (!directory.read_only && directory.backup_policy.is_empty())
            {
                Err("DEPLOYMENT_DATA_POLICY_REQUIRED".into())
            } else {
                Ok(())
            },
        );
    }
    for key in [
        "ssh",
        "sftp",
        "remoteDocker",
        "remoteCompose",
        "architecture",
        "port",
        "disk",
        "directory",
        "ownership",
        "mounts",
        "proxy",
    ] {
        if config.template_kind == "staticSite"
            && matches!(
                key,
                "remoteDocker" | "remoteCompose" | "architecture" | "port"
            )
        {
            continue;
        }
        report.items.push(ReadinessItem {
            key: key.into(),
            status: CheckStatus::Unchecked,
            location: config.remote_root.clone(),
            evidence: String::new(),
            checked_at: None,
        });
    }
    Ok(report)
}

pub(crate) fn check_remote(
    entry: &ApplicationEntry,
    report: &mut ReadinessReport,
    database: &crate::db::Database,
    credentials: &crate::keychain::CredentialManager,
    known_hosts: &Path,
    cancellations: &crate::execution::ExecutionCancellationRegistry,
) -> Result<(), String> {
    use super::docker_compose_executor::posix_quote;
    use crate::execution::{
        execute_reviewed_ssh_command_with_handle, ExecutionOutputPolicy, ExecutionStatus,
        FrozenTargetIdentity, ReviewedSshCommand, ReviewedSshExecutionRequest,
    };
    let config = &entry.environment.config;
    let connection = (|| {
        let profile = database
            .get_profile(&config.connection_profile_id)?
            .ok_or("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND")?;
        let mut connection =
            super::target_connection::connection_for_profile(credentials, &profile)?;
        crate::commands::resolve_keychain_key_for_remote(credentials, &mut connection)?;
        Ok::<_, String>(connection)
    })();
    let connection = match connection {
        Ok(connection) => connection,
        Err(error) => {
            report.items.retain(|item| item.key != "ssh");
            report.record("ssh", &config.connection_profile_id, Err(error));
            return Ok(());
        }
    };
    let sftp = crate::execution::open_ssh_execution_session(&connection, known_hosts)
        .map_err(|e| e.message)
        .and_then(|session| session.target.sftp().map(|_| ()).map_err(|e| e.to_string()));
    report
        .items
        .retain(|item| item.key != "ssh" && item.key != "sftp");
    report.record("ssh", &config.connection_profile_id, sftp.clone());
    report.record("sftp", &config.connection_profile_id, sftp.clone());
    if sftp.is_err() {
        return Ok(());
    }
    let root = posix_quote(&config.remote_root);
    let architecture = match config.platform.as_str() {
        "linux/amd64" => "x86_64",
        "linux/arm64" => "aarch64",
        _ => return Ok(()),
    };
    let mut checks = vec![
        ("remoteDocker", "docker info >/dev/null 2>&1".to_string()),
        ("remoteCompose", "docker compose version >/dev/null 2>&1".to_string()),
        ("architecture", format!("test \"$(uname -s)\" = Linux && test \"$(uname -m)\" = {architecture}")),
        ("directory", format!("test -d {root} && test ! -L {root} && test -r {root} && test -w {root} && test -x {root}")),
        ("disk", format!("test -d {root} && df -Pk {root} | awk 'NR==2 {{ enough=($4 >= 1048576) }} END {{ exit !(NR >= 2 && enough) }}'")),
        ("port", format!("listeners=$(ss -H -ltn 'sport = :{}') && test -z \"$listeners\"", config.host_port)),
        ("ownership", format!("test -d {root} && contents=$(find {root} -mindepth 1 -maxdepth 1 -print -quit) && test -z \"$contents\"")),
    ];
    if let Some(host) = &config.host_compose {
        let bundle = super::host_compose::HostBundle {
            config: host.clone(),
            project_name: config.project_name.clone(),
            service: config.service.clone(),
            compose_files: vec![config.compose_file.clone()],
            files: Vec::new(),
        };
        for (key, command) in &mut checks {
            if matches!(*key, "port" | "ownership") {
                *command = format!(
                    "bash -c {}",
                    posix_quote(&bundle.preflight(&config.remote_root))
                );
            }
        }
    } else if let Some(managed) = managed_compose_check(entry, database)? {
        for (key, command) in &mut checks {
            if matches!(*key, "port" | "ownership") {
                *command = managed.command().to_string();
            }
        }
    }
    for directory in &config.data_directories {
        checks.push((
            "mounts",
            format!(
                "test -d {} && test ! -L {} && test -r {}{}",
                posix_quote(&directory.host_path),
                posix_quote(&directory.host_path),
                posix_quote(&directory.host_path),
                if directory.read_only {
                    String::new()
                } else {
                    format!(" && test -w {}", posix_quote(&directory.host_path))
                }
            ),
        ));
    }
    if config.data_directories.is_empty() {
        report.items.retain(|item| item.key != "mounts");
        report.record("mounts", &config.remote_root, Ok(()));
    }
    // These are fixed read checks, audited through the existing execution path.
    // No shell program or arbitrary command is accepted from the front end.
    for (key, command) in checks {
        if config.template_kind == "staticSite"
            && matches!(
                key,
                "remoteDocker" | "remoteCompose" | "architecture" | "port"
            )
        {
            continue;
        }
        let operation_id = format!("deployment-readiness-{}", uuid::Uuid::new_v4());
        let target = FrozenTargetIdentity::from_connection(
            config.connection_profile_id.clone(),
            &connection,
        )
        .map_err(|e| e.message)?;
        let handle = cancellations
            .register(operation_id.clone())
            .map_err(|e| e.to_string())?;
        let request = ReviewedSshExecutionRequest {
            operation_id,
            target,
            connection: connection.clone(),
            command: ReviewedSshCommand::new(
                command,
                format!("ShellSpan read-only onboarding: {key}"),
                Vec::new(),
            )
            .map_err(|e| e.message)?,
            timeout: Duration::from_secs(15),
            output_policy: ExecutionOutputPolicy::new(4096, 4096, 8192).map_err(|e| e.message)?,
        };
        let result = execute_reviewed_ssh_command_with_handle(
            database,
            credentials,
            known_hosts,
            request,
            handle,
            current_timestamp_ms(),
        );
        report
            .items
            .retain(|item| !(item.key == key && item.status == CheckStatus::Unchecked));
        if key == "mounts"
            && result.status == ExecutionStatus::Completed
            && result.exit_code == Some(0)
        {
            report.items.push(ReadinessItem {
                key: key.into(),
                status: CheckStatus::Notice,
                location: config.remote_root.clone(),
                evidence: "DEPLOYMENT_CONTAINER_ACCESS_PROBE_REQUIRES_RELEASE_APPROVAL".into(),
                checked_at: Some(current_timestamp_ms()),
            });
            continue;
        }
        report.record(
            key,
            &config.remote_root,
            if result.status == ExecutionStatus::Completed && result.exit_code == Some(0) {
                Ok(())
            } else {
                Err(format!("DEPLOYMENT_READINESS_{}", key.to_uppercase()))
            },
        );
    }
    // Before the first release the upstream may legitimately return 404/503.
    // Establish HTTP/TLS reachability here; availability is post-release evidence.
    report.items.retain(|item| item.key != "proxy");
    if config.access_url.is_empty() {
        report.items.push(ReadinessItem {
            key: "proxy".into(),
            status: CheckStatus::Notice,
            location: config.remote_root.clone(),
            evidence: "DEPLOYMENT_NO_PUBLIC_ENTRY_CONFIGURED".into(),
            checked_at: Some(current_timestamp_ms()),
        });
    } else {
        let result = fixed_command(
            "curl",
            &[
                "--head".into(),
                "--silent".into(),
                "--show-error".into(),
                "--max-time".into(),
                "15".into(),
                "--proto".into(),
                "=http,https".into(),
                "--".into(),
                config.access_url.clone(),
            ],
            &entry.source.local_path,
            &CancellationToken::new(),
            Duration::from_secs(20),
        );
        match result {
            Ok(()) => report.items.push(ReadinessItem {
                key: "proxy".into(),
                status: CheckStatus::Notice,
                location: config.access_url.clone(),
                evidence: "DEPLOYMENT_ENTRY_REACHABLE_AVAILABILITY_NOT_VERIFIED".into(),
                checked_at: Some(current_timestamp_ms()),
            }),
            Err(error) => report.record("proxy", &config.access_url, Err(error.message)),
        }
    }
    Ok(())
}

/// Bind nonempty-root admissions to a successful local release and its exact
/// remote image/configuration. Docker's creation-time config_files label is not
/// a path authority after staging is committed to the immutable release folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ManagedComposeCheck(String);
impl ManagedComposeCheck {
    pub(super) fn command(&self) -> &str {
        &self.0
    }
}

pub(super) fn managed_compose_check(
    entry: &ApplicationEntry,
    database: &crate::db::Database,
) -> Result<Option<ManagedComposeCheck>, String> {
    use super::docker_compose_executor::posix_quote;
    use super::workflow_schema::{ArtifactBundleManifest, ImmutableRunPlan};
    let Some(workflow_id) = &entry.environment.workflow_id else {
        return Ok(None);
    };
    let Some(release) = database
        .list_deployment_releases(workflow_id)?
        .into_iter()
        .find(|release| release.position == "current")
    else {
        return Ok(None);
    };
    let Some(run) = database.get_deployment_run(release.source_run_id.as_deref().unwrap_or(""))?
    else {
        return Ok(None);
    };
    let plan: ImmutableRunPlan =
        serde_json::from_value(run.plan).map_err(|error| error.to_string())?;
    let config = &entry.environment.config;
    if plan.target.remote_root != config.remote_root
        || plan.target.connection_profile_id != config.connection_profile_id
    {
        return Ok(None);
    }
    let manifest: String = database.with_connection(|connection| {
        connection
            .query_row(
                "SELECT manifest_json FROM deployment_artifacts WHERE artifact_reference=?1",
                [&release.artifact_reference],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    })?;
    let manifest: ArtifactBundleManifest =
        serde_json::from_str(&manifest).map_err(|error| error.to_string())?;
    if canonical_sha256(&manifest).map_err(|error| error.to_string())? != release.manifest_digest
        || manifest.annotations.get("projectName") != Some(&config.project_name)
    {
        return Err("DEPLOYMENT_MANAGED_RELEASE_EVIDENCE_MISMATCH".into());
    }
    let compose = manifest
        .components
        .iter()
        .find(|component| component.name == "compose.yaml")
        .ok_or("DEPLOYMENT_MANAGED_COMPOSE_MISSING")?;
    let image = manifest
        .components
        .iter()
        .find(|component| component.name == "image.tar")
        .ok_or("DEPLOYMENT_MANAGED_IMAGE_MISSING")?;
    let reference = image
        .annotations
        .get("imageReference")
        .ok_or("DEPLOYMENT_MANAGED_IMAGE_MISSING")?;
    let image_id = image
        .annotations
        .get("imageId")
        .ok_or("DEPLOYMENT_MANAGED_IMAGE_MISSING")?;
    let manifest_id = image
        .annotations
        .get("imageManifestId")
        .map(String::as_str)
        .unwrap_or("");
    let root = posix_quote(&config.remote_root);
    let path = posix_quote(&format!(
        "{}/releases/{}/compose.yaml",
        config.remote_root, release.release_id
    ));
    Ok(Some(ManagedComposeCheck(format!(
        "set -eu; root={root}; test \"$(readlink -f \"$root\")\" = \"$root\"; test ! -L \"$root/.shellspan/current.release\"; test \"$(sed -n '1p' \"$root/.shellspan/current.release\")\" = {marker}; test \"$(sed -n '2p' \"$root/.shellspan/current.release\")\" = {content}; test ! -L {path}; digest=$(sha256sum {path}); test \"${{digest%% *}}\" = {digest}; ids=$(docker ps -aq --filter {project}); test -n \"$ids\"; test \"$(printf '%s\\n' \"$ids\" | wc -l)\" -eq 1; test \"$(docker inspect --format '{{{{.Config.Image}}}}' \"$ids\")\" = {reference}; actual=$(docker inspect --format '{{{{.Image}}}}' \"$ids\"); test \"$actual\" = {image_id} || test \"$actual\" = {manifest_id}; test \"$(docker inspect --format '{{{{index .Config.Labels \"com.docker.compose.service\"}}}}' \"$ids\")\" = {service}; test \"$(docker inspect --format '{{{{.State.Running}}}}' \"$ids\")\" = true",
        marker=posix_quote(&format!("releaseId={}", release.release_id)), content=posix_quote(&format!("artifactContentDigest={}", release.content_digest)),
        digest=posix_quote(compose.digest.strip_prefix("sha256:").ok_or("DEPLOYMENT_MANAGED_DIGEST_INVALID")?),
        project=posix_quote(&format!("label=com.docker.compose.project={}", config.project_name)), reference=posix_quote(reference), image_id=posix_quote(image_id), manifest_id=posix_quote(manifest_id), service=posix_quote(&config.service),
    ))))
}
