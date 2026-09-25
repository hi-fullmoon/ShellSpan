use super::compose_release::BundleComposeConfig;
use super::host_compose::*;
use std::fs;
use std::process::{Command, Output};

fn config() -> BundleComposeConfig {
    BundleComposeConfig {
        compose_files: vec!["compose.yml".into()],
        project_name: "host-compose-acceptance".into(),
        services: vec!["web".into()],
        registered_mounts: vec![],
        non_sensitive_files: vec!["message.txt".into()],
        host_compose: Some(HostCompose {
            environment_file: ".env".into(),
            override_files: vec!["override.yml".into()],
            recreate_services: vec!["proxy".into()],
            backup: BackupProgram {
                script: "backup.sh".into(),
                arguments: vec![],
            },
            checks: vec![HttpCheck {
                url: "http://127.0.0.1:3080/healthz".into(),
                status: 200,
                json_fields: Default::default(),
                location: None,
            }],
        }),
    }
}

#[test]
fn host_bundle_protects_server_files_and_preserves_interpolation() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("compose.yml"),
        "services:\n  web:\n    image: ${IMAGE}\n  proxy:\n    image: ${IMAGE}\n",
    )
    .unwrap();
    fs::write(root.path().join("message.txt"), "release content").unwrap();
    let mut config = config();
    let staged = compile(root.path(), &config, "example/web:immutable").unwrap();
    let host: HostBundle =
        serde_json::from_slice(&fs::read(staged.path().join("config-host.json")).unwrap()).unwrap();
    assert_eq!(host.files.len(), 2);
    assert!(host.matches_config(&config));
    config
        .host_compose
        .as_mut()
        .unwrap()
        .backup
        .arguments
        .push("different-backup".into());
    assert!(!host.matches_config(&config));
    config
        .host_compose
        .as_mut()
        .unwrap()
        .backup
        .arguments
        .clear();
    config.non_sensitive_files.push("unreviewed.txt".into());
    assert!(!host.matches_config(&config));
    config.non_sensitive_files.pop();
    assert!(!staged.path().join(".env").exists());
    let compose_file = host
        .files
        .iter()
        .find(|file| file.destination == "compose.yml")
        .unwrap();
    assert!(
        fs::read_to_string(staged.path().join(&compose_file.component))
            .unwrap()
            .contains("${IMAGE}")
    );
    for path in [
        ".env",
        "override.yml",
        "tls/cert.pem",
        "docker/nginx/wellknown/domain.txt",
        "../outside",
    ] {
        config.non_sensitive_files = vec![path.into()];
        assert!(
            compile(root.path(), &config, "example/web:immutable").is_err(),
            "must reject {path}"
        );
    }
}

fn docker(args: &[&str]) -> Output {
    let result = Command::new("docker").args(args).output().unwrap();
    assert!(
        result.status.success(),
        "docker {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    result
}

struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.0])
            .output();
    }
}

/// Uses a real isolated Docker daemon and Compose services. No SSH, Docker or
/// backup executable is replaced by a fake implementation.
#[test]
#[ignore = "requires the local deployment acceptance Docker image"]
fn isolated_host_compose_updates_only_selected_services_and_blocks_failed_backup() {
    let name = format!("shellspan-host-{}", uuid::Uuid::new_v4().simple());
    docker(&[
        "run",
        "-d",
        "--privileged",
        "--name",
        &name,
        "shellspan-deployment-e2e:local",
    ]);
    let _container = Container(name.clone());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    while !Command::new("docker")
        .args(["exec", &name, "docker", "info"])
        .output()
        .unwrap()
        .status
        .success()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "isolated Docker engine did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let local = tempfile::tempdir().unwrap();
    let archive = local.path().join("image.tar");
    let image = "shellspan/deployment-e2e:fixture-healthy";
    docker(&["save", "--output", archive.to_str().unwrap(), image]);
    docker(&[
        "cp",
        archive.to_str().unwrap(),
        &format!("{name}:/tmp/image.tar"),
    ]);
    docker(&["exec", &name, "docker", "load", "--input", "/tmp/image.tar"]);
    let root = local.path().join("project");
    fs::create_dir(&root).unwrap();
    let compose = "services:\n  web:\n    image: ${IMAGE}\n    ports: ['127.0.0.1:3080:8080']\n  proxy:\n    image: ${IMAGE}\n  untouched:\n    image: ${IMAGE}\n";
    fs::write(root.join("compose.yml"), compose).unwrap();
    fs::write(root.join(".env"), format!("IMAGE={image}\n")).unwrap();
    fs::write(
        root.join("override.yml"),
        "services:\n  web:\n    restart: unless-stopped\n",
    )
    .unwrap();
    fs::write(root.join("message.txt"), "old release").unwrap();
    fs::write(root.join("backup.sh"), "set -eu\ntest ! -f fail-backup\nmkdir -p backups\ntar -cf backups/config.tar compose.yml message.txt\ntar -tf backups/config.tar >/dev/null\n").unwrap();
    docker(&[
        "cp",
        root.to_str().unwrap(),
        &format!("{name}:/srv/project"),
    ]);
    docker(&["exec", &name, "sh", "-c", "cd /srv/project && docker compose -p host-compose-acceptance --env-file .env -f compose.yml -f override.yml up -d --no-build --pull never"]);
    let untouched = docker(&[
        "exec",
        &name,
        "docker",
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.service=untouched",
    ])
    .stdout;
    let proxy = docker(&[
        "exec",
        &name,
        "docker",
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.service=proxy",
    ])
    .stdout;
    fs::write(root.join("message.txt"), "new release").unwrap();
    let staged = compile(&root, &config(), image).unwrap();
    let host: HostBundle =
        serde_json::from_slice(&fs::read(staged.path().join("config-host.json")).unwrap()).unwrap();
    docker(&[
        "cp",
        staged.path().to_str().unwrap(),
        &format!("{name}:/srv/staging"),
    ]);
    docker(&["exec", &name, "bash", "-c", &host.preflight("/srv/project")]);
    docker(&["exec", &name, "touch", "/srv/project/fail-backup"]);
    let failed = Command::new("docker")
        .args([
            "exec",
            &name,
            "bash",
            "-c",
            &host.deploy("/srv/project", "/srv/staging", image),
        ])
        .output()
        .unwrap();
    assert!(
        !failed.status.success(),
        "failed backup must block deployment"
    );
    assert_eq!(
        docker(&["exec", &name, "cat", "/srv/project/message.txt"]).stdout,
        b"old release"
    );
    // A distinct staging directory represents a newly approved attempt.
    docker(&[
        "cp",
        staged.path().to_str().unwrap(),
        &format!("{name}:/srv/retry"),
    ]);
    docker(&["exec", &name, "rm", "/srv/project/fail-backup"]);
    docker(&[
        "exec",
        &name,
        "chown",
        "1234:1234",
        "/srv/project/message.txt",
    ]);
    docker(&[
        "exec",
        &name,
        "bash",
        "-c",
        &host.deploy("/srv/project", "/srv/retry", image),
    ]);
    assert_eq!(
        docker(&["exec", &name, "cat", "/srv/project/message.txt"]).stdout,
        b"new release"
    );
    assert_eq!(
        docker(&[
            "exec",
            &name,
            "stat",
            "-c",
            "%u:%g",
            "/srv/project/message.txt"
        ])
        .stdout,
        b"1234:1234\n"
    );
    assert_eq!(
        docker(&[
            "exec",
            &name,
            "cat",
            "/srv/retry/host-backup/files/message.txt"
        ])
        .stdout,
        b"old release"
    );
    assert_eq!(
        docker(&["exec", &name, "cat", "/srv/project/.env"]).stdout,
        format!("IMAGE={image}\n").as_bytes()
    );
    assert_eq!(
        docker(&[
            "exec",
            &name,
            "docker",
            "ps",
            "-q",
            "--filter",
            "label=com.docker.compose.service=untouched"
        ])
        .stdout,
        untouched
    );
    assert_ne!(
        docker(&[
            "exec",
            &name,
            "docker",
            "ps",
            "-q",
            "--filter",
            "label=com.docker.compose.service=proxy"
        ])
        .stdout,
        proxy
    );
}
