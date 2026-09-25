//! Preview first, then exclusively create the exact reviewed local files.
use super::applications::{validate, ApplicationEntry};
use super::canonicalization::canonical_sha256;
use serde::Serialize;
use serde_json::json;
use std::io::Write;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentFilePreview {
    pub digest: String,
    pub files: Vec<GeneratedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedFile {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

pub(crate) fn preview(entry: &ApplicationEntry) -> Result<DeploymentFilePreview, String> {
    validate(entry)?;
    let root = &entry.source.local_path;
    let package_path = root.join("package.json");
    let metadata = std::fs::symlink_metadata(&package_path)
        .map_err(|_| "DEPLOYMENT_GENERATION_PACKAGE_REQUIRED")?;
    if metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024 {
        return Err("DEPLOYMENT_GENERATION_PACKAGE_INVALID".into());
    }
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_path).map_err(|e| e.to_string())?)
            .map_err(|_| "DEPLOYMENT_GENERATION_PACKAGE_INVALID")?;
    if !root.join("pnpm-lock.yaml").is_file()
        || package
            .pointer("/scripts/build")
            .and_then(serde_json::Value::as_str)
            .is_none()
        || package
            .pointer("/scripts/start")
            .and_then(serde_json::Value::as_str)
            .is_none()
    {
        return Err("DEPLOYMENT_GENERATION_PNPM_BUILD_START_REQUIRED".into());
    }
    let config = &entry.environment.config;
    if config.dockerfile != "Dockerfile"
        || config.compose_file != "compose.yaml"
        || config.build_context != "."
    {
        return Err("DEPLOYMENT_GENERATION_ROOT_FILES_REQUIRED".into());
    }
    if config.service.is_empty()
        || config.host_port == 0
        || config.container_port == 0
        || !matches!(config.bind_address.as_str(), "127.0.0.1" | "::1")
    {
        return Err("DEPLOYMENT_GENERATION_ENVIRONMENT_REQUIRED".into());
    }
    let users = config
        .data_directories
        .iter()
        .map(|directory| directory.container_user.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if users.len() > 1 {
        return Err("DEPLOYMENT_GENERATION_ONE_CONTAINER_USER_REQUIRED".into());
    }
    if users
        .iter()
        .any(|user| !super::compose_release::numeric_container_user(user))
    {
        return Err("DEPLOYMENT_GENERATION_NUMERIC_CONTAINER_USER_REQUIRED".into());
    }
    let mut service = json!({"build": {"context":".","dockerfile":"Dockerfile"},"image":"shellspan/application:local",
        "ports":[{"target":config.container_port,"published":config.host_port.to_string(),"host_ip":config.bind_address,"protocol":"tcp"}],
        "environment":{"NODE_ENV":"production","PORT":config.container_port.to_string(),"HOSTNAME":"0.0.0.0"},
        "restart":"unless-stopped","volumes":config.data_directories.iter().map(|directory|json!({
            "type":"bind","source":directory.host_path,"target":directory.container_path,"read_only":directory.read_only,
            "bind":{"create_host_path":false}
        })).collect::<Vec<_>>()});
    if let Some(user) = users.first().filter(|user| !user.is_empty()) {
        service["user"] = json!(user);
    }
    let compose = serde_yaml::to_string(&json!({"services":{&config.service:service}}))
        .map_err(|e| e.to_string())?;
    let runtime_user = users
        .first()
        .map(|user| format!("RUN chown -R {user} /app\nUSER {user}\n"))
        .unwrap_or_default();
    let dockerfile = format!("FROM node:24-bookworm-slim\nWORKDIR /app\nRUN npm install -g pnpm@11.1.1\nCOPY . .\nRUN pnpm install --frozen-lockfile\nRUN pnpm build\n{runtime_user}CMD [\"pnpm\", \"start\"]\n");
    let files = [
        ("Dockerfile", dockerfile.to_string()),
        ("compose.yaml", compose),
        (
            ".dockerignore",
            ".git\nnode_modules\n.next\ndist\ntarget\ndata\n.env\n.env.*\n*.pem\n*.key\n"
                .to_string(),
        ),
    ]
    .into_iter()
    .map(|(path, content)| GeneratedFile {
        path: path.into(),
        content,
        exists: root.join(path).symlink_metadata().is_ok(),
    })
    .collect::<Vec<_>>();
    let digest =
        canonical_sha256(&json!({"entry":entry,"files":files})).map_err(|e| e.to_string())?;
    Ok(DeploymentFilePreview { digest, files })
}

pub(crate) fn apply(
    entry: &ApplicationEntry,
    expected_digest: &str,
) -> Result<Vec<String>, String> {
    let plan = preview(entry)?;
    if plan.digest != expected_digest {
        return Err("DEPLOYMENT_GENERATION_PREVIEW_CHANGED".into());
    }
    if plan.files.iter().any(|file| file.exists) {
        return Err("DEPLOYMENT_GENERATION_WILL_NOT_OVERWRITE".into());
    }
    let mut written = Vec::new();
    for file in plan.files {
        let mut temporary =
            tempfile::NamedTempFile::new_in(&entry.source.local_path).map_err(|e| e.to_string())?;
        temporary
            .write_all(file.content.as_bytes())
            .map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary
            .persist_noclobber(entry.source.local_path.join(&file.path))
            .map_err(|_| {
                format!(
                    "DEPLOYMENT_GENERATION_FILE_CONFLICT:{};created={}",
                    file.path,
                    written.join(",")
                )
            })?;
        written.push(file.path);
    }
    Ok(written)
}
