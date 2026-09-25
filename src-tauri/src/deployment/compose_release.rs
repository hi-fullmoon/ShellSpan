//! Compile a deliberately bounded Compose release using the official parser.
use super::docker_compose_executor::fixed_command;
use super::node_executor::NodeFailure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Component, Path};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredBindMount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BundleComposeConfig {
    #[serde(default)]
    pub host_compose: Option<super::host_compose::HostCompose>,
    pub compose_files: Vec<String>,
    pub project_name: String,
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub registered_mounts: Vec<RegisteredBindMount>,
    /// Explicit declaration that these files contain no credentials.
    #[serde(default)]
    pub non_sensitive_files: Vec<String>,
}

fn failure(message: &str) -> NodeFailure {
    NodeFailure::definite("composeConfig", message)
}

pub(super) fn numeric_container_user(value: &str) -> bool {
    let Some((uid, gid)) = value.split_once(':') else {
        return false;
    };
    [uid, gid].iter().all(|part| {
        !part.is_empty()
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && part.parse::<u32>().is_ok()
    })
}

fn member(root: &Path, value: &str) -> Result<std::path::PathBuf, NodeFailure> {
    let relative = Path::new(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(failure("Compose file dependency escapes the frozen source"));
    }
    let path = fs::canonicalize(root.join(relative))
        .map_err(|_| failure("Compose file dependency is unavailable"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(failure("Compose file dependency is not a source file"));
    }
    Ok(path)
}

fn check_document(value: &Value) -> Result<(), NodeFailure> {
    match value {
        Value::String(text) if text.contains('$') => {
            return Err(failure(
                "Compose interpolation is unsupported; provide explicit non-sensitive values",
            ))
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if key == "environment" {
                    let explicit = match value {
                        Value::Object(values) => values.values().all(|value| !value.is_null()),
                        Value::Array(values) => values
                            .iter()
                            .all(|value| value.as_str().is_some_and(|value| value.contains('='))),
                        _ => false,
                    };
                    if !explicit {
                        return Err(failure("implicit host environment values are forbidden"));
                    }
                }
                if matches!(
                    key.as_str(),
                    "include" | "extends" | "secrets" | "credential_spec" | "develop" | "env_file"
                ) {
                    return Err(failure("Compose includes, secrets, development hooks and env_file require an explicit supported resource mapping"));
                }
                check_document(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                check_document(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Returns an isolated directory containing compose.yaml and all declared config files.
pub(crate) fn compile(
    root: &Path,
    config: &BundleComposeConfig,
    image_reference: &str,
    cancellation: &CancellationToken,
) -> Result<tempfile::TempDir, NodeFailure> {
    if config.host_compose.is_some() {
        return super::host_compose::compile(root, config, image_reference);
    }
    let canonical_root =
        fs::canonicalize(root).map_err(|_| failure("frozen source is unavailable"))?;
    let root = canonical_root.as_path();
    if config.services.len() != 1 || config.compose_files.is_empty() {
        return Err(failure("select exactly one managed service"));
    }
    let output =
        tempfile::tempdir().map_err(|_| failure("cannot create Compose staging directory"))?;
    let empty_env = output.path().join("empty.env");
    fs::write(&empty_env, []).map_err(|_| failure("cannot isolate Compose environment"))?;
    let mut args = vec![
        "compose".into(),
        "--env-file".into(),
        empty_env.to_string_lossy().into_owned(),
        "--project-name".into(),
        config.project_name.clone(),
        "--project-directory".into(),
        root.to_string_lossy().into_owned(),
    ];
    for file in &config.compose_files {
        let path = member(root, file)?;
        let bytes = fs::read(&path).map_err(|_| failure("cannot read Compose input"))?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(failure("Compose input exceeds size limit"));
        }
        let document: Value =
            serde_yaml::from_slice(&bytes).map_err(|_| failure("invalid Compose YAML"))?;
        check_document(&document)?;
        args.extend(["--file".into(), path.to_string_lossy().into_owned()]);
    }
    let effective = output.path().join("effective.json");
    args.extend([
        "config".into(),
        "--no-interpolate".into(),
        "--no-env-resolution".into(),
        "--no-path-resolution".into(),
        "--format".into(),
        "json".into(),
        "--output".into(),
        effective.to_string_lossy().into_owned(),
    ]);
    fixed_command("docker", &args, root, cancellation, Duration::from_secs(30))?;
    let bytes = fs::read(&effective).map_err(|_| failure("cannot read resolved Compose"))?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(failure("resolved Compose exceeds size limit"));
    }
    let mut document: Value =
        serde_json::from_slice(&bytes).map_err(|_| failure("invalid resolved Compose"))?;
    let services = document
        .get_mut("services")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| failure("Compose services are missing"))?;
    if services.len() != 1 {
        return Err(failure(
            "additional images are unsupported by this release bundle",
        ));
    }
    let service = services
        .get_mut(&config.services[0])
        .and_then(Value::as_object_mut)
        .ok_or_else(|| failure("managed Compose service is missing"))?;
    // An allowlist prevents newly introduced Compose capabilities from silently
    // extending the approved deployment privilege boundary.
    for key in service.keys() {
        if !matches!(
            key.as_str(),
            "image"
                | "build"
                | "pull_policy"
                | "command"
                | "entrypoint"
                | "environment"
                | "ports"
                | "volumes"
                | "configs"
                | "networks"
                | "restart"
                | "user"
                | "working_dir"
                | "healthcheck"
                | "init"
                | "read_only"
                | "stop_grace_period"
                | "labels"
                | "platform"
        ) {
            return Err(failure(
                "Compose service contains an unsupported capability",
            ));
        }
    }
    if service
        .get("environment")
        .and_then(Value::as_object)
        .is_some_and(|env| env.values().any(Value::is_null))
    {
        return Err(failure("implicit host environment values are forbidden"));
    }
    service.remove("build");
    service.insert("image".into(), Value::String(image_reference.into()));
    service.insert("pull_policy".into(), Value::String("never".into()));
    if service
        .get("volumes")
        .and_then(Value::as_array)
        .is_some_and(|mounts| !mounts.is_empty())
        && !service
            .get("user")
            .and_then(Value::as_str)
            .is_some_and(numeric_container_user)
    {
        return Err(failure(
            "registered mounts require an explicit numeric container UID:GID",
        ));
    }
    if let Some(mounts) = service.get_mut("volumes").and_then(Value::as_array_mut) {
        for mount in mounts {
            let source = mount.get("source").and_then(Value::as_str).unwrap_or("");
            let target = mount.get("target").and_then(Value::as_str).unwrap_or("");
            let read_only = mount
                .get("read_only")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if mount.get("type").and_then(Value::as_str) != Some("bind")
                || !Path::new(source).is_absolute()
                || source == "/"
                || source.contains("docker.sock")
                || source.contains(',')
                || target.contains(',')
                || Path::new(source)
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
                || !Path::new(target).is_absolute()
                || target == "/"
                || !config.registered_mounts.iter().any(|item| {
                    item.source == source && item.target == target && item.read_only == read_only
                })
                || mount
                    .get("bind")
                    .and_then(Value::as_object)
                    .is_some_and(|bind| bind.keys().any(|key| key != "create_host_path"))
            {
                return Err(failure("Compose bind mount is unsafe or is not registered"));
            }
            mount
                .as_object_mut()
                .ok_or_else(|| failure("invalid bind mount"))?
                .insert(
                    "bind".into(),
                    serde_json::json!({"create_host_path": false}),
                );
        }
    }
    if let Some(ports) = service.get("ports").and_then(Value::as_array) {
        for port in ports {
            if port.get("host_ip").and_then(Value::as_str) != Some("127.0.0.1")
                || port.get("published").and_then(Value::as_str).is_none()
            {
                return Err(failure(
                    "Compose ports require an explicit loopback host binding",
                ));
            }
        }
    }
    let top = document
        .as_object_mut()
        .ok_or_else(|| failure("invalid Compose model"))?;
    for key in top.keys() {
        if !matches!(key.as_str(), "name" | "services" | "networks" | "configs") {
            return Err(failure("unsupported Compose resource"));
        }
    }
    if let Some(networks) = top.get("networks").and_then(Value::as_object) {
        if networks.keys().any(|name| name != "default")
            || networks.values().any(|network| {
                network
                    .as_object()
                    .is_none_or(|fields| fields.keys().any(|key| key != "name"))
            })
        {
            return Err(failure(
                "only an isolated default Compose network is supported",
            ));
        }
    }
    if let Some(configs) = top.get_mut("configs").and_then(Value::as_object_mut) {
        for (index, resource) in configs.values_mut().enumerate() {
            let fields = resource
                .as_object_mut()
                .ok_or_else(|| failure("invalid Compose config resource"))?;
            if fields
                .keys()
                .any(|key| !matches!(key.as_str(), "file" | "name"))
            {
                return Err(failure(
                    "external or environment-backed configs are forbidden",
                ));
            }
            let file = fields
                .get("file")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("config file is missing"))?;
            if !config
                .non_sensitive_files
                .iter()
                .any(|declared| declared == file)
            {
                return Err(failure("config file must be declared non-sensitive"));
            }
            let source = member(root, file)?;
            let filename = format!("config-{index}.txt");
            fs::copy(source, output.path().join(&filename))
                .map_err(|_| failure("cannot stage config dependency"))?;
            fields.insert("file".into(), Value::String(format!("./{filename}")));
        }
    }
    let rendered =
        serde_yaml::to_string(&document).map_err(|_| failure("cannot render Compose release"))?;
    let final_path = output.path().join("compose.yaml");
    fs::write(&final_path, rendered).map_err(|_| failure("cannot write Compose release"))?;
    fixed_command(
        "docker",
        &[
            "compose".into(),
            "--env-file".into(),
            empty_env.to_string_lossy().into_owned(),
            "--file".into(),
            final_path.to_string_lossy().into_owned(),
            "config".into(),
            "--quiet".into(),
        ],
        output.path(),
        cancellation,
        Duration::from_secs(30),
    )?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> BundleComposeConfig {
        BundleComposeConfig {
            host_compose: None,
            compose_files: vec!["compose.yaml".into()],
            project_name: "shellspan-phase1-test".into(),
            services: vec!["web".into()],
            registered_mounts: vec![],
            non_sensitive_files: vec![],
        }
    }

    #[test]
    fn rejects_implicit_environment_and_external_documents() {
        for document in [
            "services: {web: {image: '${IMAGE}'}}",
            "include: other.yaml",
            "services: {web: {secrets: [password]}}",
            "services: {web: {env_file: .env}}",
        ] {
            let parsed = serde_yaml::from_str(document).unwrap();
            assert!(check_document(&parsed).is_err(), "{document}");
        }
    }

    #[test]
    #[ignore = "requires the real Docker Compose CLI"]
    fn official_compose_binds_image_and_copies_declared_config() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("compose.yaml"), "services:\n  web:\n    build: .\n    image: old:latest\n    ports: ['127.0.0.1:31000:3000']\n    configs: [settings]\nconfigs:\n  settings:\n    file: settings.json\n").unwrap();
        fs::write(
            root.path().join("settings.json"),
            "{\"mode\":\"production\"}",
        )
        .unwrap();
        let mut config = config();
        config.non_sensitive_files.push("settings.json".into());
        let release = compile(
            root.path(),
            &config,
            "shellspan/test:release-123",
            &CancellationToken::new(),
        )
        .unwrap();
        let result: Value =
            serde_yaml::from_slice(&fs::read(release.path().join("compose.yaml")).unwrap())
                .unwrap();
        assert_eq!(
            result["services"]["web"]["image"],
            "shellspan/test:release-123"
        );
        assert!(result["services"]["web"].get("build").is_none());
        assert_eq!(result["services"]["web"]["pull_policy"], "never");
        assert_eq!(
            fs::read(release.path().join("config-0.txt")).unwrap(),
            fs::read(root.path().join("settings.json")).unwrap()
        );
    }

    #[test]
    #[ignore = "requires the real Docker Compose CLI"]
    fn official_compose_rejects_unsafe_capabilities_and_dependencies() {
        let root = tempfile::tempdir().unwrap();
        for extra in [
            "privileged: true",
            "network_mode: host",
            "volumes: ['/:/host']",
            "ports: ['3000:3000']",
            "environment: [HOME]",
            "devices: ['/dev/kvm:/dev/kvm']",
        ] {
            fs::write(
                root.path().join("compose.yaml"),
                format!("services:\n  web:\n    image: app:old\n    {extra}\n"),
            )
            .unwrap();
            assert!(
                compile(
                    root.path(),
                    &config(),
                    "app:release-123",
                    &CancellationToken::new()
                )
                .is_err(),
                "{extra}"
            );
        }
        fs::write(root.path().join("compose.yaml"), "services:\n  web:\n    image: app:old\n    configs: [settings]\nconfigs:\n  settings:\n    file: ../outside.json\n").unwrap();
        let mut config = config();
        config.non_sensitive_files.push("../outside.json".into());
        assert!(compile(
            root.path(),
            &config,
            "app:release-123",
            &CancellationToken::new()
        )
        .is_err());
    }
}
