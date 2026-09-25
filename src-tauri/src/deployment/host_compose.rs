//! Updating an explicitly selected, existing Compose project. Host-owned
//! configuration is referenced by path and is never copied into local artifacts.
use super::compose_release::BundleComposeConfig;
use super::docker_compose_executor::posix_quote;
use super::node_executor::NodeFailure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostCompose {
    pub environment_file: String,
    #[serde(default)]
    pub override_files: Vec<String>,
    #[serde(default)]
    pub recreate_services: Vec<String>,
    pub backup: BackupProgram,
    pub checks: Vec<HttpCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BackupProgram {
    pub script: String,
    #[serde(default)]
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpCheck {
    pub url: String,
    pub status: u16,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub json_fields: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostBundle {
    pub config: HostCompose,
    pub project_name: String,
    pub service: String,
    pub compose_files: Vec<String>,
    pub files: Vec<HostFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostFile {
    pub component: String,
    pub destination: String,
    pub executable: bool,
}

fn failure(message: &str) -> NodeFailure {
    NodeFailure::definite("hostCompose", message)
}

pub(crate) fn relative_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('-')
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".." | ".shellspan" | ".git"))
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("DEPLOYMENT_HOST_COMPOSE_PATH_INVALID".into());
    }
    Ok(())
}

impl HostCompose {
    pub(crate) fn validate(&self) -> Result<(), String> {
        relative_path(&self.environment_file)?;
        relative_path(&self.backup.script)?;
        if self.override_files.len() > 8
            || self.recreate_services.len() > 16
            || self.backup.arguments.len() > 16
            || self.checks.is_empty()
            || self.checks.len() > 16
        {
            return Err("DEPLOYMENT_HOST_COMPOSE_LIMIT".into());
        }
        for path in &self.override_files {
            relative_path(path)?;
        }
        for service in &self.recreate_services {
            super::node_registry::validate_identifier("recreateServices", service)?;
        }
        for argument in &self.backup.arguments {
            if argument.len() > 512 || argument.chars().any(char::is_control) {
                return Err("DEPLOYMENT_HOST_COMPOSE_ARGUMENT_INVALID".into());
            }
        }
        for check in &self.checks {
            let url =
                url::Url::parse(&check.url).map_err(|_| "DEPLOYMENT_HOST_COMPOSE_URL_INVALID")?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || !(200..400).contains(&check.status)
            {
                return Err("DEPLOYMENT_HOST_COMPOSE_URL_INVALID".into());
            }
            if check.json_fields.len() > 16
                || check
                    .json_fields
                    .iter()
                    .any(|(key, value)| key.is_empty() || key.len() > 128 || value.len() > 1024)
            {
                return Err("DEPLOYMENT_HOST_COMPOSE_HTTP_FIELDS_INVALID".into());
            }
            if let Some(location) = &check.location {
                let location =
                    url::Url::parse(location).map_err(|_| "DEPLOYMENT_HOST_COMPOSE_URL_INVALID")?;
                if !matches!(location.scheme(), "http" | "https")
                    || !location.username().is_empty()
                    || location.password().is_some()
                {
                    return Err("DEPLOYMENT_HOST_COMPOSE_URL_INVALID".into());
                }
            }
        }
        Ok(())
    }

    fn protected(&self, path: &str) -> bool {
        path == self.environment_file
            || self.override_files.iter().any(|item| item == path)
            || path.split('/').any(|part| {
                matches!(part, "license" | "tls" | "wellknown" | "acme")
                    || part == ".env"
                    || part.starts_with(".env.")
                    || part.ends_with(".pem")
                    || part.ends_with(".key")
            })
    }
}

/// Each file becomes one immutable component, avoiding remote tar extraction.
pub(crate) fn compile(
    root: &Path,
    config: &BundleComposeConfig,
    image: &str,
) -> Result<tempfile::TempDir, NodeFailure> {
    let host = config
        .host_compose
        .as_ref()
        .ok_or_else(|| failure("host configuration missing"))?;
    host.validate().map_err(|e| failure(&e))?;
    if config.services.len() != 1 || config.compose_files.is_empty() {
        return Err(failure(
            "select one image service and at least one Compose file",
        ));
    }
    let output = tempfile::tempdir().map_err(|_| failure("cannot stage host Compose files"))?;
    let paths = config
        .compose_files
        .iter()
        .chain(&config.non_sensitive_files)
        .collect::<BTreeSet<_>>();
    if paths.len() > 60 {
        return Err(failure("too many release files"));
    }
    let mut files = Vec::new();
    let mut declared_services = BTreeSet::new();
    for (index, path) in paths.into_iter().enumerate() {
        relative_path(path).map_err(|e| failure(&e))?;
        if host.protected(path) {
            return Err(failure("host-owned files cannot be replaced"));
        }
        let mut member = root.to_path_buf();
        for part in Path::new(path).components() {
            member.push(part);
            if fs::symlink_metadata(&member)
                .map_err(|_| failure("release file is missing"))?
                .file_type()
                .is_symlink()
            {
                return Err(failure("release file contains a symbolic link"));
            }
        }
        let metadata = fs::metadata(&member).map_err(|_| failure("cannot inspect release file"))?;
        if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
            return Err(failure("release file exceeds bounds"));
        }
        let bytes = fs::read(&member).map_err(|_| failure("cannot read release file"))?;
        if config.compose_files.contains(path) {
            let document: Value =
                serde_yaml::from_slice(&bytes).map_err(|_| failure("invalid Compose YAML"))?;
            if document.get("include").is_some() {
                return Err(failure("Compose include is unsupported"));
            }
            let services = document["services"]
                .as_object()
                .ok_or_else(|| failure("Compose services missing"))?;
            for (name, service) in services {
                if service.get("extends").is_some() {
                    return Err(failure("Compose extends is unsupported"));
                }
                declared_services.insert(name.clone());
            }
        }
        let component = format!("config-host-{index}");
        fs::write(output.path().join(&component), bytes)
            .map_err(|_| failure("cannot stage release file"))?;
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        files.push(HostFile {
            component,
            destination: path.clone(),
            executable,
        });
    }
    for service in config.services.iter().chain(&host.recreate_services) {
        if !declared_services.contains(service) {
            return Err(failure("selected service is absent from Compose files"));
        }
    }
    let manifest = HostBundle {
        config: host.clone(),
        project_name: config.project_name.clone(),
        service: config.services[0].clone(),
        compose_files: config.compose_files.clone(),
        files,
    };
    fs::write(
        output.path().join("config-host.json"),
        serde_json::to_vec(&manifest).map_err(|_| failure("cannot encode host bundle"))?,
    )
    .map_err(|_| failure("cannot stage host bundle"))?;
    fs::write(
        output.path().join("config-host-deploy.py"),
        include_str!("host_compose_deploy.py"),
    )
    .map_err(|_| failure("cannot stage fixed executor"))?;
    let override_document = serde_json::json!({"services": { &config.services[0]: {"image": image, "pull_policy": "never"}}});
    fs::write(
        output.path().join("compose.yaml"),
        serde_yaml::to_string(&override_document)
            .map_err(|_| failure("cannot encode image override"))?,
    )
    .map_err(|_| failure("cannot stage image override"))?;
    Ok(output)
}

impl HostBundle {
    pub(crate) fn matches_config(&self, config: &BundleComposeConfig) -> bool {
        let destinations = self
            .files
            .iter()
            .map(|file| &file.destination)
            .collect::<BTreeSet<_>>();
        let expected = config
            .compose_files
            .iter()
            .chain(&config.non_sensitive_files)
            .collect::<BTreeSet<_>>();
        config.host_compose.as_ref() == Some(&self.config)
            && config.project_name == self.project_name
            && config.services == [self.service.clone()]
            && config.compose_files == self.compose_files
            && destinations == expected
    }

    fn compose(&self, root: &str, override_path: Option<&str>) -> String {
        let mut command = format!(
            "docker compose --project-directory {} --project-name {} --env-file {}",
            posix_quote(root),
            posix_quote(&self.project_name),
            posix_quote(&format!("{root}/{}", self.config.environment_file))
        );
        for file in self.compose_files.iter().chain(&self.config.override_files) {
            command.push_str(&format!(" -f {}", posix_quote(&format!("{root}/{file}"))));
        }
        if let Some(path) = override_path {
            command.push_str(&format!(" -f {}", posix_quote(path)));
        }
        command
    }

    /// No values from the environment file or resolved Compose document leave
    /// the remote process. A read check validates the existing project's identity.
    pub(crate) fn preflight(&self, root: &str) -> String {
        let compose = self.compose(root, None);
        let mut script = format!("set -euo pipefail; cd {}; test \"$(pwd -P)\" = {}; command -v bash >/dev/null; command -v python3 >/dev/null; command -v sha256sum >/dev/null;", posix_quote(root), posix_quote(root));
        for path in self
            .compose_files
            .iter()
            .chain(&self.config.override_files)
            .chain([&self.config.environment_file, &self.config.backup.script])
        {
            script.push_str(&format!(
                " test -f {path}; test \"$(realpath -- {path})\" = {absolute};",
                path = posix_quote(path),
                absolute = posix_quote(&format!("{root}/{path}"))
            ));
        }
        script.push_str(&format!(" {compose} config --quiet >/dev/null 2>&1; ids=$({compose} ps -q {} 2>/dev/null); test -n \"$ids\"; for id in $ids; do test \"$(docker inspect --format '{{{{index .Config.Labels \"com.docker.compose.project\"}}}}' \"$id\")\" = {}; done;", posix_quote(&self.service), posix_quote(&self.project_name)));
        script.push_str(" { ");
        let paths = self
            .files
            .iter()
            .map(|file| file.destination.as_str())
            .chain(self.config.override_files.iter().map(String::as_str))
            .chain([
                self.config.environment_file.as_str(),
                self.config.backup.script.as_str(),
                ".shellspan/host-image.yaml",
            ])
            .collect::<BTreeSet<_>>();
        script.push_str(&format!(" for path in {}; do if test -e \"$path\"; then test -f \"$path\"; test ! -L \"$path\"; sha256sum -- \"$path\"; else printf 'absent:%s\\n' \"$path\"; fi; done;", paths.into_iter().map(posix_quote).collect::<Vec<_>>().join(" ")));
        script.push_str(" for id in $ids; do docker inspect --format '{{.Id}} {{.Image}}' \"$id\"; done; } | sha256sum | cut -d ' ' -f 1;");
        script
    }

    pub(crate) fn deploy(&self, root: &str, staging: &str, image: &str) -> String {
        format!(
            "python3 {} {} {} {}",
            posix_quote(&format!("{staging}/config-host-deploy.py")),
            posix_quote(root),
            posix_quote(staging),
            posix_quote(image)
        )
    }
}
