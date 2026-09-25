use super::artifact_cas::{ArtifactBlobSource, DeploymentArtifactCas};
use super::canonicalization::canonical_sha256;
use super::compose_release::{BundleComposeConfig, RegisteredBindMount};
use super::file_tree_artifact::{
    extract_verified_file_tree, FileTreeEntry, FileTreeEntryKind, FILE_TREE_COMPONENT_NAME,
    FILE_TREE_MEDIA_TYPE,
};
use super::local_artifact_executor::{
    execute_artifact_collect, execute_package_script_build, ArtifactCollectConfig,
    PackageScriptConfig,
};
use super::node_executor::{
    plan_from_descriptor, CompensationInput, CompensationResult, DeploymentNodeExecutor,
    DeploymentNodeExecutorRegistry, FrozenNodeInput, NodeExecutionContext, NodeExecutionResult,
    NodeFailure, NodeReconcileResult, PlannedNode, VerifiedNodeInput,
};
use super::node_executor::{NodeOutputKind, NodeOutputValue};
use super::node_registry::DeploymentNodeRegistry;
use super::target_connection::connection_for_profile;
use super::workflow_schema::{
    ArtifactBundleManifest, ArtifactDescriptor, ArtifactHandle, ArtifactProducer, ArtifactRole,
    ArtifactSource, EffectReceipt, FrozenReleaseIdentity, FrozenSourceSnapshot,
    FrozenTargetIdentity, VerificationEvidence,
};
use crate::db::{current_timestamp_ms, Database};
use crate::execution::{
    execute_reviewed_ssh_command_with_handle, ExecutionCancellationRegistry, ExecutionOutputPolicy,
    ExecutionStatus, FrozenTargetIdentity as ExecutionFrozenTargetIdentity, ReviewedSshCommand,
    ReviewedSshExecutionRequest,
};
use crate::keychain::CredentialManager;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use ssh2::{ErrorCode, FileStat, FileType, OpenFlags, OpenType, RenameFlags, Sftp};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub(crate) const DOCKER_COMPOSE_EXECUTOR_VERSION: &str = "docker-compose/3";

pub(crate) const DOCKER_COMPOSE_NODE_TYPES: &[(&str, u32)] = &[
    ("source.snapshot", 1),
    ("build.package-script", 1),
    ("build.docker-buildx", 2),
    ("artifact.collect", 1),
    ("artifact.bundle-compose", 1),
    ("target.preflight", 2),
    ("release.create-candidate", 1),
    ("control.approval", 1),
    ("transfer.sftp", 2),
    ("release.prepare-compose", 1),
    ("release.prepare-files", 1),
    ("runtime.load-image", 1),
    ("deploy.compose", 2),
    ("deploy.static-switch", 1),
    ("verify.http", 2),
    ("proxy.nginx-reload", 2),
    ("release.commit", 1),
    ("finalize.notify", 1),
];

#[async_trait]
pub(crate) trait DockerComposeExecutionBackend: Send + Sync {
    async fn execute(
        &self,
        node_type: &str,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure>;

    async fn reconcile(
        &self,
        node_type: &str,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeReconcileResult, NodeFailure>;

    async fn compensate(
        &self,
        node_type: &str,
        input: CompensationInput,
        context: NodeExecutionContext,
    ) -> Result<CompensationResult, NodeFailure>;
}

struct DockerComposeNodeExecutor {
    node_type: &'static str,
    node_version: u32,
    backend: Arc<dyn DockerComposeExecutionBackend>,
}

#[async_trait]
impl DeploymentNodeExecutor for DockerComposeNodeExecutor {
    fn node_type(&self) -> (&'static str, u32) {
        (self.node_type, self.node_version)
    }

    fn executor_version(&self) -> &'static str {
        DOCKER_COMPOSE_EXECUTOR_VERSION
    }

    fn validate_config(&self, config: &Value) -> Result<(), String> {
        let registry = DeploymentNodeRegistry::mvp();
        let descriptor = registry
            .find(self.node_type, self.node_version)
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
        registry
            .validate_config(descriptor, "executor-validation", config)
            .map(|_| ())
            .map_err(|errors| {
                errors
                    .into_iter()
                    .map(|error| error.message)
                    .collect::<Vec<_>>()
                    .join("; ")
            })
    }

    fn plan(&self, input: FrozenNodeInput) -> Result<PlannedNode, String> {
        let registry = DeploymentNodeRegistry::mvp();
        let descriptor = registry
            .find(self.node_type, self.node_version)
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
        if input.node.type_name != self.node_type || input.node.type_version != self.node_version {
            return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_NODE_MISMATCH".into());
        }
        plan_from_descriptor(descriptor, self.executor_version(), &input)
    }

    async fn execute(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        self.backend.execute(self.node_type, input, context).await
    }

    async fn reconcile(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeReconcileResult, NodeFailure> {
        self.backend.reconcile(self.node_type, input, context).await
    }

    async fn compensate(
        &self,
        input: CompensationInput,
        context: NodeExecutionContext,
    ) -> Result<CompensationResult, NodeFailure> {
        self.backend
            .compensate(self.node_type, input, context)
            .await
    }
}

pub(crate) fn docker_compose_executor_registry(
    backend: Arc<dyn DockerComposeExecutionBackend>,
) -> Result<DeploymentNodeExecutorRegistry, String> {
    let mut registry = DeploymentNodeExecutorRegistry::default();
    for (node_type, version) in DOCKER_COMPOSE_NODE_TYPES {
        registry.register(Arc::new(DockerComposeNodeExecutor {
            node_type,
            node_version: *version,
            backend: backend.clone(),
        }))?;
    }
    Ok(registry)
}

#[derive(Clone)]
pub(crate) struct NativeDockerComposeBackend {
    app: Option<AppHandle>,
    database: Database,
    credentials: CredentialManager,
    cancellations: ExecutionCancellationRegistry,
    known_hosts_path: PathBuf,
    sources: Arc<Mutex<BTreeMap<(String, String), (FrozenSourceSnapshot, Arc<tempfile::TempDir>)>>>,
    artifacts: DeploymentArtifactCas,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSnapshotConfig {
    source_ref: String,
    #[serde(default)]
    binding: Option<super::source_binding::SourceBinding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DockerBuildxConfig {
    #[serde(default)]
    verification: Option<super::build_verification::BuildVerification>,
    context: String,
    dockerfile: String,
    platform: String,
    image_repository: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetPreflightConfig {
    target_id: String,
    #[serde(default)]
    required_capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetOnlyConfig {
    target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateConfig {
    target_id: String,
    strategy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeployComposeConfig {
    target_id: String,
    project_name: String,
    #[serde(default)]
    services: Vec<String>,
    pull_policy: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyHttpConfig {
    target_id: String,
    scheme: String,
    port: u16,
    path: String,
    expected_statuses: Vec<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StaticSwitchConfig {
    target_id: String,
    link_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DockerComposeRemoteAction {
    HostComposeCheck {
        command: String,
    },
    HostComposeDeploy {
        command: String,
    },
    CheckManagedCompose(super::readiness::ManagedComposeCheck),
    CheckUnoccupiedCompose {
        project_name: String,
        ports: Vec<u16>,
    },
    Preflight {
        remote_root: String,
        require_atomic_symlink: bool,
    },
    LoadImage {
        archive: String,
        image_reference: String,
        image_id: String,
        image_manifest_id: Option<String>,
    },
    PrepareCompose {
        remote_directory: String,
        component_names: Vec<String>,
        prepared_identity: String,
    },
    ComposeDeploy {
        compose_files: Vec<String>,
        project_name: String,
        services: Vec<String>,
        pull_policy: String,
        image_reference: String,
        container_user: String,
        mounts: Vec<RegisteredBindMount>,
    },
    StaticSwitch {
        remote_root: String,
        release_id: String,
        artifact_content_digest: String,
        layout_digest: String,
        previous_release_id: Option<String>,
    },
    VerifyHttp {
        url: String,
    },
    NginxReload,
    CommitRelease {
        remote_root: String,
        staging: String,
        release: String,
        artifact_content_digest: String,
        layout_digest: String,
        metadata: String,
    },
    RestoreCompose {
        release: String,
        project_name: String,
        components: Vec<(String, String)>,
    },
    RestoreReleaseIdentity {
        remote_root: String,
        release: String,
        artifact_content_digest: String,
        layout_digest: String,
        metadata: String,
    },
    RestoreStaticAndVerify {
        remote_root: String,
        previous_release_id: String,
        previous_artifact_content_digest: String,
        previous_layout_digest: String,
        url: String,
        expected_statuses: Vec<u16>,
    },
    ReverifyHttp {
        url: String,
    },
    MarkStagingForCleanup {
        remote_directory: String,
        plan_digest: String,
    },
}

impl DockerComposeRemoteAction {
    fn fixed_request(&self) -> (String, &'static str) {
        let script = match self {
            Self::HostComposeCheck { command } | Self::HostComposeDeploy { command } => format!("bash -c {}", posix_quote(command)),
            Self::CheckManagedCompose(check) => check.command().to_string(),
            Self::CheckUnoccupiedCompose { project_name, ports } => {
                let port_checks = ports.iter().map(|port| format!(
                    "listeners=$(ss -H -ltn 'sport = :{port}'); test -z \"$listeners\"; published=$(docker ps -q --filter publish={port}); test -z \"$published\";"
                )).collect::<Vec<_>>().join(" ");
                format!("set -eu; containers=$(docker ps -aq --filter {}); test -z \"$containers\"; {port_checks}",
                    posix_quote(&format!("label=com.docker.compose.project={project_name}")))
            }
            Self::Preflight {
                remote_root,
                require_atomic_symlink,
            } => {
                let static_check = if *require_atomic_symlink {
                    "if test -e \"$root/current\" || test -L \"$root/current\"; then test -L \"$root/current\" || exit 21; link=$(readlink \"$root/current\"); case \"$link\" in releases/release-*) ;; *) exit 21 ;; esac; printf 'currentLink=%s\\n' \"$link\"; fi"
                } else {
                    ":"
                };
                format!(
                    "root={}; test -d \"$root\" || exit 20; printf 'ssh=1\\n'; command -v docker >/dev/null 2>&1 && printf 'docker=1\\n' || printf 'docker=0\\n'; docker compose version >/dev/null 2>&1 && printf 'compose=1\\n' || printf 'compose=0\\n'; command -v curl >/dev/null 2>&1 && printf 'http=1\\n' || printf 'http=0\\n'; command -v nginx >/dev/null 2>&1 && printf 'nginx=1\\n' || printf 'nginx=0\\n'; if test \"$(uname -s)\" = Linux && test -w \"$root\" && command -v ln >/dev/null 2>&1 && command -v mv >/dev/null 2>&1 && command -v readlink >/dev/null 2>&1 && mv --help 2>&1 | grep -q -- '-T'; then printf 'atomicSymlink=1\\n'; else printf 'atomicSymlink=0\\n'; fi; {static_check}; if test -e \"$root/.shellspan/current.release\" || test -L \"$root/.shellspan/current.release\"; then test -f \"$root/.shellspan/current.release\"; test ! -L \"$root/.shellspan/current.release\"; sed -n '1,4p' \"$root/.shellspan/current.release\"; fi",
                    posix_quote(remote_root)
                )
            }
            Self::LoadImage {
                archive,
                image_reference,
                image_id,
                image_manifest_id,
            } => format!(
                "set -eu; archive={}; image={}; expected={}; manifest={}; test -f \"$archive\"; docker load --input \"$archive\" >/dev/null; actual=$(docker image inspect --format '{{{{.Id}}}}' \"$image\"); test \"$actual\" = \"$expected\" || {{ test -n \"$manifest\" && test \"$actual\" = \"$manifest\"; }}",
                posix_quote(archive),
                posix_quote(image_reference),
                posix_quote(image_id),
                posix_quote(image_manifest_id.as_deref().unwrap_or("")),
            ),
            Self::PrepareCompose {
                remote_directory,
                component_names,
                prepared_identity,
            } => {
                let checks = component_names
                    .iter()
                    .map(|name| {
                        format!(
                            "test -f {}",
                            posix_quote(&format!("{remote_directory}/{name}"))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                format!(
                    "set -eu; {checks}; umask 077; printf '%s\\n' {} > {}",
                    posix_quote(prepared_identity),
                    posix_quote(&format!("{remote_directory}/.prepared")),
                )
            }
            Self::ComposeDeploy {
                compose_files,
                project_name,
                services,
                pull_policy,
                image_reference,
                container_user,
                mounts,
            } => {
                let probes = mounts.iter().map(|mount| {
                    let specification = format!("type=bind,source={},target={}{}", mount.source, mount.target,
                        if mount.read_only { ",readonly" } else { "" });
                    let probe = "set -eu; test -d \"$1\"; test -r \"$1\"; test -x \"$1\"; if test \"$2\" = rw; then scratch=$(mktemp -d \"$1/.shellspan-access.XXXXXXXX\"); trap 'rm -f \"$scratch/probe\"; rmdir \"$scratch\"' EXIT; printf shellspan-access > \"$scratch/probe\"; test \"$(cat \"$scratch/probe\")\" = shellspan-access; fi";
                    format!("test \"$(readlink -f {source})\" = {source}; docker run --rm --pull never --network none --read-only --user {user} --mount {mount} --entrypoint /bin/sh {image} -ec {probe} shellspan-access {target} {mode};",
                        source=posix_quote(&mount.source), user=posix_quote(container_user), mount=posix_quote(&specification),
                        image=posix_quote(image_reference), probe=posix_quote(probe), target=posix_quote(&mount.target),
                        mode=if mount.read_only { "ro" } else { "rw" })
                }).collect::<Vec<_>>().join(" ");
                let file_args = compose_files
                    .iter()
                    .map(|path| format!("-f {}", posix_quote(path)))
                    .collect::<Vec<_>>()
                    .join(" ");
                let services = services
                    .iter()
                    .map(|service| posix_quote(service))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!(
                    "set -eu; images=$(docker compose {file_args} --project-name {} config --images); printf '%s\\n' \"$images\" | grep -F -x -- {} >/dev/null; docker compose {file_args} --project-name {} config >/dev/null; {probes} docker compose {file_args} --project-name {} up -d --no-build --pull {} {services}",
                    posix_quote(project_name),
                    posix_quote(image_reference),
                    posix_quote(project_name),
                    posix_quote(project_name),
                    posix_quote(pull_policy),
                )
            }
            Self::StaticSwitch {
                remote_root,
                release_id,
                artifact_content_digest,
                layout_digest,
                previous_release_id,
            } => {
                let expected_previous = previous_release_id
                    .as_ref()
                    .map(|release| format!("releases/{release}"));
                let previous_check = match expected_previous {
                    Some(previous) => format!(
                        "test -L \"$current\"; test \"$(readlink \"$current\")\" = {}",
                        posix_quote(&previous)
                    ),
                    None => "test ! -e \"$current\"; test ! -L \"$current\"".into(),
                };
                let relative = format!("releases/{release_id}");
                format!(
                    "set -eu; root={}; release={}; expected={}; layout={}; release_id={}; current=\"$root/current\"; target={}; test \"$(readlink -f \"$root\")\" = \"$root\"; test ! -L \"$root\"; test -d \"$release\"; test ! -L \"$release\"; test -f \"$release/.prepared\"; test ! -L \"$release/.prepared\"; test \"$(sed -n '1p' \"$release/.prepared\")\" = \"$expected\"; test \"$(sed -n '2p' \"$release/.prepared\")\" = \"$layout\"; test \"$(sed -n '3p' \"$release/.prepared\")\" = \"$release_id\"; if test -L \"$current\" && test \"$(readlink \"$current\")\" = \"$target\"; then exit 0; fi; {previous_check}; tmp=\"$root/.current.{}\"; if test -L \"$tmp\"; then test \"$(readlink \"$tmp\")\" = \"$target\"; else test ! -e \"$tmp\"; ln -s \"$target\" \"$tmp\"; fi; mv -Tf \"$tmp\" \"$current\"; test -L \"$current\"; test \"$(readlink \"$current\")\" = \"$target\"",
                    posix_quote(remote_root),
                    posix_quote(&format!("{remote_root}/releases/{release_id}")),
                    posix_quote(artifact_content_digest),
                    posix_quote(layout_digest),
                    posix_quote(release_id),
                    posix_quote(&relative),
                    &artifact_content_digest[7..23],
                )
            }
            Self::VerifyHttp { url } => format!(
                "curl --silent --show-error --output /dev/null --write-out '%{{http_code}}' --max-time 20 {}",
                posix_quote(url)
            ),
            Self::NginxReload => "set -eu; nginx -t; nginx -s reload".into(),
            Self::CommitRelease {
                remote_root,
                staging,
                release,
                artifact_content_digest,
                layout_digest,
                metadata,
            } => format!(
                "set -eu; root={}; staging={}; release={}; expected={}; layout={}; test \"$(readlink -f \"$root\")\" = \"$root\"; test ! -L \"$root\"; mkdir -p \"$root/releases\" \"$root/.shellspan\"; if ! test -d \"$release\"; then test -d \"$staging\"; test ! -L \"$staging\"; test -f \"$staging/.prepared\"; test ! -L \"$staging/.prepared\"; test \"$(sed -n '1p' \"$staging/.prepared\")\" = \"$expected\"; mv \"$staging\" \"$release\"; fi; test -d \"$release\"; test ! -L \"$release\"; test -f \"$release/.prepared\"; test ! -L \"$release/.prepared\"; test \"$(sed -n '1p' \"$release/.prepared\")\" = \"$expected\"; if test -e \"$root/current\" || test -L \"$root/current\"; then test -L \"$root/current\"; test \"$(readlink \"$root/current\")\" = \"releases/${{release##*/}}\"; test \"$(sed -n '2p' \"$release/.prepared\")\" = \"$layout\"; test \"$(sed -n '3p' \"$release/.prepared\")\" = \"${{release##*/}}\"; fi; test ! -L \"$root/.shellspan/current.release.tmp\"; umask 077; printf %s {} > \"$root/.shellspan/current.release.tmp\"; mv \"$root/.shellspan/current.release.tmp\" \"$root/.shellspan/current.release\"",
                posix_quote(remote_root),
                posix_quote(staging),
                posix_quote(release),
                posix_quote(artifact_content_digest),
                posix_quote(layout_digest),
                posix_quote(metadata),
            ),
            Self::RestoreCompose { release, project_name, components } => {
                let checks = components.iter().map(|(name, digest)| format!(
                    "test ! -L {path}; test -f {path}; actual=$(sha256sum {path}); test \"${{actual%% *}}\" = {digest};",
                    path = posix_quote(&format!("{release}/{name}")),
                    digest = posix_quote(digest.strip_prefix("sha256:").unwrap_or(digest)),
                )).collect::<Vec<_>>().join(" ");
                format!(
                    "set -eu; release={}; test -d \"$release\"; test ! -L \"$release\"; {checks} docker load --input \"$release/image.tar\" >/dev/null; docker compose -f \"$release/compose.yaml\" --project-name {} up -d --no-build --pull never",
                    posix_quote(release), posix_quote(project_name),
                )
            },
            Self::RestoreReleaseIdentity {
                remote_root,
                release,
                artifact_content_digest,
                layout_digest,
                metadata,
            } => format!(
                "set -eu; root={}; release={}; expected={}; layout={}; test \"$(readlink -f \"$root\")\" = \"$root\"; test ! -L \"$root\"; test -d \"$release\"; test ! -L \"$release\"; test -f \"$release/.prepared\"; test ! -L \"$release/.prepared\"; test \"$(sed -n '1p' \"$release/.prepared\")\" = \"$expected\"; stored_layout=$(sed -n '2p' \"$release/.prepared\"); if test -n \"$stored_layout\"; then test \"$stored_layout\" = \"$layout\"; fi; test ! -L \"$root/.shellspan/current.release.tmp\"; umask 077; printf %s {} > \"$root/.shellspan/current.release.tmp\"; mv \"$root/.shellspan/current.release.tmp\" \"$root/.shellspan/current.release\"",
                posix_quote(remote_root),
                posix_quote(release),
                posix_quote(artifact_content_digest),
                posix_quote(layout_digest),
                posix_quote(metadata),
            ),
            Self::RestoreStaticAndVerify {
                remote_root,
                previous_release_id,
                previous_artifact_content_digest,
                previous_layout_digest,
                url,
                expected_statuses,
            } => {
                let relative = format!("releases/{previous_release_id}");
                let allowed = expected_statuses
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join("|");
                format!(
                    "set -eu; root={}; release={}; expected={}; layout={}; release_id={}; current=\"$root/current\"; target={}; test \"$(readlink -f \"$root\")\" = \"$root\"; test ! -L \"$root\"; test -d \"$release\"; test ! -L \"$release\"; test -f \"$release/.prepared\"; test ! -L \"$release/.prepared\"; test \"$(sed -n '1p' \"$release/.prepared\")\" = \"$expected\"; test \"$(sed -n '2p' \"$release/.prepared\")\" = \"$layout\"; test \"$(sed -n '3p' \"$release/.prepared\")\" = \"$release_id\"; tmp=\"$root/.restore.{}\"; if test -L \"$tmp\"; then test \"$(readlink \"$tmp\")\" = \"$target\"; else test ! -e \"$tmp\"; ln -s \"$target\" \"$tmp\"; fi; mv -Tf \"$tmp\" \"$current\"; test \"$(readlink \"$current\")\" = \"$target\"; status=$(curl --silent --show-error --output /dev/null --write-out '%{{http_code}}' --max-time 20 {}); case \"$status\" in {allowed}) exit 0 ;; *) exit 22 ;; esac",
                    posix_quote(remote_root),
                    posix_quote(&format!("{remote_root}/releases/{previous_release_id}")),
                    posix_quote(previous_artifact_content_digest),
                    posix_quote(previous_layout_digest),
                    posix_quote(previous_release_id),
                    posix_quote(&relative),
                    &previous_release_id[..previous_release_id.len().min(32)],
                    posix_quote(url),
                )
            }
            Self::ReverifyHttp { url } => format!(
                "set -eu; status=$(curl --silent --show-error --output /dev/null --write-out '%{{http_code}}' --max-time 20 {}); test \"$status\" -ge 200; test \"$status\" -lt 400",
                posix_quote(url)
            ),
            Self::MarkStagingForCleanup {
                remote_directory,
                plan_digest,
            } => format!(
                "set -eu; test -d {}; umask 077; printf '%s\\n' {} > {}",
                posix_quote(remote_directory),
                posix_quote(plan_digest),
                posix_quote(&format!("{remote_directory}/.cleanup-eligible")),
            ),
        };
        let preview = match self {
            Self::CheckManagedCompose(_) => "ShellSpan read-only managed Compose evidence check",
            Self::CheckUnoccupiedCompose { .. } => {
                "ShellSpan read-only Compose resource conflict check"
            }
            Self::Preflight { .. } => "ShellSpan fixed deployment preflight",
            Self::LoadImage { .. } => "ShellSpan fixed Docker image load",
            Self::PrepareCompose { .. } => "ShellSpan fixed Compose release preparation",
            Self::ComposeDeploy { .. } => "ShellSpan fixed Docker Compose deploy",
            Self::HostComposeCheck { .. } => "ShellSpan read-only existing Compose check",
            Self::HostComposeDeploy { .. } => {
                "ShellSpan approved existing Compose backup and deploy"
            }
            Self::StaticSwitch { .. } => "ShellSpan fixed static release symlink switch",
            Self::VerifyHttp { .. } => "ShellSpan fixed HTTP verification",
            Self::NginxReload => "ShellSpan fixed Nginx validate and reload",
            Self::CommitRelease { .. } => "ShellSpan fixed release commit",
            Self::RestoreCompose { .. } => "ShellSpan fixed Compose restore",
            Self::RestoreReleaseIdentity { .. } => "ShellSpan fixed release identity restore",
            Self::RestoreStaticAndVerify { .. } => {
                "ShellSpan fixed static release restore and verification"
            }
            Self::ReverifyHttp { .. } => "ShellSpan fixed restored release verification",
            Self::MarkStagingForCleanup { .. } => {
                "ShellSpan fixed unactivated staging cleanup marker"
            }
        };
        (format!("sh -c {}", posix_quote(&script)), preview)
    }
}

fn sha256_file(path: &Path) -> Result<(String, u64), NodeFailure> {
    let mut file =
        File::open(path).map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| NodeFailure::definite("artifactIo", "artifact size overflow"))?;
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    Ok((
        format!(
            "sha256:{}",
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ),
        total,
    ))
}

fn canonical_member(root: &Path, relative: &str) -> Result<PathBuf, NodeFailure> {
    let root = fs::canonicalize(root)
        .map_err(|error| NodeFailure::definite("pathBoundary", error.to_string()))?;
    let candidate = if relative == "." {
        root.clone()
    } else {
        root.join(relative)
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| NodeFailure::definite("pathBoundary", error.to_string()))?;
    if !canonical.starts_with(&root) {
        return Err(NodeFailure::definite(
            "pathBoundary",
            "source member escapes the frozen workspace",
        ));
    }
    Ok(canonical)
}

pub(super) fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn safe_local_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env_clear();
    for name in [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_RUNTIME_DIR",
        "DOCKER_CONFIG",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("LC_ALL", "C")
        .env("DOCKER_CONTEXT", "default")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

pub(super) fn fixed_command(
    program: &str,
    args: &[String],
    directory: &Path,
    cancellation: &tokio_util::sync::CancellationToken,
    timeout: Duration,
) -> Result<(), NodeFailure> {
    let mut command = safe_local_command(program);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(test)]
    if std::env::var("SHELLSPAN_DEPLOYMENT_TEST_VERBOSE").as_deref() == Ok("1") {
        command.stderr(Stdio::inherit());
    }
    let mut child = command
        .spawn()
        .map_err(|error| NodeFailure::definite("processStart", error.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(NodeFailure::canceled());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(NodeFailure::definite(
                "timedOut",
                "fixed local action timed out",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(NodeFailure::definite(
                    "processFailed",
                    format!("fixed local action exited with {status}"),
                ))
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                return Err(NodeFailure::definite("processWait", error.to_string()));
            }
        }
    }
}

fn build_image_bundle(
    frozen_root: &Path,
    source: FrozenSourceSnapshot,
    config: DockerBuildxConfig,
    config_digest: String,
    artifacts: &DeploymentArtifactCas,
    cancellation: &tokio_util::sync::CancellationToken,
    timeout: Duration,
) -> Result<super::artifact_cas::ArtifactBundleProjection, NodeFailure> {
    if let Some(verification) = &config.verification {
        verification.execute(frozen_root, cancellation, timeout)?;
    }
    let materialized = super::source_binding::materialize(frozen_root)
        .map_err(|error| NodeFailure::definite("sourceMaterialize", error))?;
    let source_root = materialized.path();
    let context_path = canonical_member(&source_root, &config.context)?;
    let dockerfile = canonical_member(&source_root, &config.dockerfile)?;
    if !context_path.is_dir() || !dockerfile.is_file() {
        return Err(NodeFailure::definite(
            "pathBoundary",
            "Docker build inputs are unavailable",
        ));
    }
    let identity = canonical_sha256(&serde_json::json!({
        "source": source,
        "configDigest": config_digest,
    }))
    .map_err(|error| NodeFailure::definite("artifact", error.to_string()))?;
    let release_id = format!("release-{}", &identity[7..23]);
    let image_reference = format!("{}:{release_id}", config.image_repository);
    fixed_command(
        "docker",
        &["buildx".into(), "version".into()],
        &source_root,
        &cancellation,
        Duration::from_secs(30),
    )?;
    let temporary = tempfile::tempdir()
        .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
    let archive = temporary.path().join("image.tar");
    fixed_command(
        "docker",
        &[
            "buildx".into(),
            "build".into(),
            "--progress".into(),
            "plain".into(),
            "--platform".into(),
            config.platform.clone(),
            "--file".into(),
            dockerfile.to_string_lossy().into_owned(),
            "--tag".into(),
            image_reference.clone(),
            "--output".into(),
            format!("type=docker,dest={}", archive.display()),
            context_path.to_string_lossy().into_owned(),
        ],
        &source_root,
        &cancellation,
        timeout,
    )?;
    let identity = super::docker_archive::docker_archive_image_identity(&archive, &image_reference)
        .map_err(|error| NodeFailure::definite("imageIdentity", error))?;
    let mut annotations = BTreeMap::from([
        ("imageReference".into(), image_reference),
        ("imageId".into(), identity.config_id),
    ]);
    if let Some(manifest_id) = identity.manifest_id {
        annotations.insert("imageManifestId".into(), manifest_id);
    }
    let (digest, size) = sha256_file(&archive)?;
    let manifest = ArtifactBundleManifest {
        schema_version: 2,
        artifact_type: super::node_registry::ARTIFACT_TYPE_DOCKER_IMAGE.into(),
        source: ArtifactSource {
            revision: source.revision,
            dirty: source.dirty,
            snapshot_digest: source.snapshot_digest,
        },
        components: vec![ArtifactDescriptor {
            name: "image.tar".into(),
            role: ArtifactRole::Application,
            media_type: "application/vnd.shellspan.oci-image.tar".into(),
            digest: digest.clone(),
            size,
            platform: None,
            annotations,
        }],
        producer: ArtifactProducer {
            node_type: "build.docker-buildx".into(),
            node_type_version: 2,
            config_digest: config_digest,
        },
        annotations: BTreeMap::from([("releaseId".into(), release_id)]),
    };
    artifacts
        .publish_bundle(
            &manifest,
            &[ArtifactBlobSource {
                digest,
                path: archive,
            }],
        )
        .map_err(|error| NodeFailure::definite("artifactPublish", error))
}

impl NativeDockerComposeBackend {
    pub(crate) fn new(
        app: AppHandle,
        database: Database,
        credentials: CredentialManager,
        cancellations: ExecutionCancellationRegistry,
        known_hosts_path: PathBuf,
        artifacts: DeploymentArtifactCas,
    ) -> Result<Self, String> {
        Ok(Self {
            app: Some(app),
            database,
            credentials,
            cancellations,
            known_hosts_path,
            sources: Arc::new(Mutex::new(BTreeMap::new())),
            artifacts,
        })
    }

    #[cfg(test)]
    pub(crate) fn isolated_native(
        database: Database,
        credentials: CredentialManager,
        known_hosts_path: PathBuf,
        artifacts: DeploymentArtifactCas,
    ) -> Self {
        Self {
            app: None,
            database,
            credentials,
            known_hosts_path,
            artifacts,
            cancellations: ExecutionCancellationRegistry::default(),
            sources: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn frozen_source_root(
        &self,
        source: &FrozenSourceSnapshot,
    ) -> Result<Arc<tempfile::TempDir>, NodeFailure> {
        self.sources
            .lock()
            .map_err(|_| NodeFailure::definite("sourceUnavailable", "source lock poisoned"))?
            .get(&(
                source.metadata_digest.clone(),
                source.snapshot_digest.clone(),
            ))
            .filter(|captured| captured.0 == *source)
            .map(|captured| captured.1.clone())
            .ok_or_else(|| {
                NodeFailure::definite(
                    "sourceUnavailable",
                    "frozen source is unavailable; prepare again",
                )
            })
    }

    fn host_bundle(
        &self,
        handle: &ArtifactHandle,
    ) -> Result<Option<super::host_compose::HostBundle>, NodeFailure> {
        let bundle = self
            .artifacts
            .inspect(handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        if !bundle
            .manifest
            .components
            .iter()
            .any(|component| component.name == "config-host.json")
        {
            return Ok(None);
        }
        let path = self
            .artifacts
            .verified_component_path(handle, "config-host.json")
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        let host: super::host_compose::HostBundle = serde_json::from_slice(
            &fs::read(path)
                .map_err(|_| NodeFailure::definite("artifactIo", "host manifest unavailable"))?,
        )
        .map_err(|_| NodeFailure::definite("artifactIntegrity", "invalid host manifest"))?;
        host.config
            .validate()
            .map_err(|error| NodeFailure::definite("hostCompose", error))?;
        Ok(Some(host))
    }

    fn target_definition<'a>(
        input: &'a VerifiedNodeInput,
        target_id: &str,
    ) -> Result<&'a super::workflow_schema::DeploymentTargetDefinition, NodeFailure> {
        input
            .frozen
            .targets
            .iter()
            .find(|target| target.id == target_id)
            .ok_or_else(|| NodeFailure::definite("targetMismatch", "target is not frozen"))
    }

    fn verified_connection(
        &self,
        input: &VerifiedNodeInput,
        target: &super::workflow_schema::DeploymentTargetDefinition,
    ) -> Result<crate::models::RemoteConnectionRequest, NodeFailure> {
        let profile = self
            .database
            .get_profile(&target.connection_profile_id)
            .map_err(|error| NodeFailure::definite("targetUnavailable", error))?
            .ok_or_else(|| {
                NodeFailure::definite("targetUnavailable", "target profile is missing")
            })?;
        if let Some(plan) = &input.immutable_plan {
            let current_identity = canonical_sha256(&serde_json::json!({
                "profileId": profile.id,
                "host": profile.host,
                "port": profile.port,
                "username": profile.username,
                "authMethod": profile.auth_method.as_str(),
                "jumpHost": profile.jump_host_config,
            }))
            .map_err(|error| NodeFailure::definite("targetIdentity", error.to_string()))?;
            if plan.target.target_id != target.id
                || plan.target.connection_profile_id != target.connection_profile_id
                || plan.target.remote_root != target.remote_root
                || plan.target.profile_revision != profile.updated_at
                || plan.target.host_identity_digest != current_identity
            {
                return Err(NodeFailure::definite(
                    "targetChanged",
                    "target identity changed after approval",
                ));
            }
        }
        let mut connection = connection_for_profile(&self.credentials, &profile)
            .map_err(|error| NodeFailure::definite("credentialUnavailable", error))?;
        crate::commands::resolve_keychain_key_for_remote(&self.credentials, &mut connection)
            .map_err(|error| NodeFailure::definite("credentialUnavailable", error))?;
        Ok(connection)
    }

    async fn run_remote(
        &self,
        input: &VerifiedNodeInput,
        target_id: &str,
        action: DockerComposeRemoteAction,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<String, NodeFailure> {
        let target = Self::target_definition(input, target_id)?.clone();
        let connection = self.verified_connection(input, &target)?;
        let frozen_target = ExecutionFrozenTargetIdentity::from_connection(
            target.connection_profile_id.clone(),
            &connection,
        )
        .map_err(|error| NodeFailure::definite("targetIdentity", error.message))?;
        let operation_id = format!("deployment-remote:{}", &input.idempotency_key[22..]);
        let handle = self
            .cancellations
            .register(operation_id.clone())
            .map_err(|error| NodeFailure::definite("cancellation", error.to_string()))?;
        let read_only = matches!(
            &action,
            DockerComposeRemoteAction::Preflight { .. }
                | DockerComposeRemoteAction::CheckUnoccupiedCompose { .. }
                | DockerComposeRemoteAction::CheckManagedCompose(_)
                | DockerComposeRemoteAction::HostComposeCheck { .. }
                | DockerComposeRemoteAction::VerifyHttp { .. }
                | DockerComposeRemoteAction::ReverifyHttp { .. }
        );
        let (command, preview) = action.fixed_request();
        let request = ReviewedSshExecutionRequest {
            operation_id: operation_id.clone(),
            target: frozen_target,
            connection,
            command: ReviewedSshCommand::new(command, preview.to_string(), Vec::new())
                .map_err(|error| NodeFailure::definite("remoteRequest", error.message))?,
            timeout: Duration::from_secs(u64::from(input.frozen.node.timeout_seconds.min(300))),
            output_policy: ExecutionOutputPolicy::new(128 * 1024, 32 * 1024, 8 * 1024 * 1024)
                .map_err(|error| NodeFailure::definite("remoteRequest", error.message))?,
        };
        let database = self.database.clone();
        let credentials = self.credentials.clone();
        let known_hosts_path = self.known_hosts_path.clone();
        let registry = self.cancellations.clone();
        let cancel_operation = operation_id.clone();
        let monitor = tokio::spawn(async move {
            cancellation.cancelled().await;
            let _ = registry.cancel(&cancel_operation);
        });
        let result = tokio::task::spawn_blocking(move || {
            execute_reviewed_ssh_command_with_handle(
                &database,
                &credentials,
                &known_hosts_path,
                request,
                handle,
                current_timestamp_ms(),
            )
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("remoteWorker", "remote worker stopped"))?;
        monitor.abort();
        match result.status {
            ExecutionStatus::Completed if result.exit_code == Some(0) => Ok(result.stdout),
            ExecutionStatus::Cancelled => Err(NodeFailure::canceled()),
            _ if read_only => Err(NodeFailure::definite(
                "readCheckFailed",
                "read-only remote check did not complete successfully",
            )),
            ExecutionStatus::TimedOut => Err(NodeFailure::ambiguous(
                "timedOut",
                "fixed remote action timed out",
            )),
            _ => Err(NodeFailure::ambiguous(
                "remoteAction",
                result.error.unwrap_or_else(|| {
                    format!("fixed remote action exited {:?}", result.exit_code)
                }),
            )),
        }
    }

    async fn probe_sftp(&self, connection_profile_id: &str) -> Result<(), NodeFailure> {
        let database = self.database.clone();
        let credentials = self.credentials.clone();
        let known_hosts_path = self.known_hosts_path.clone();
        let connection_profile_id = connection_profile_id.to_string();
        tokio::task::spawn_blocking(move || {
            let profile = database
                .get_profile(&connection_profile_id)
                .map_err(|error| NodeFailure::definite("targetUnavailable", error))?
                .ok_or_else(|| {
                    NodeFailure::definite("targetUnavailable", "target profile is missing")
                })?;
            let mut connection = connection_for_profile(&credentials, &profile)
                .map_err(|error| NodeFailure::definite("credentialUnavailable", error))?;
            crate::commands::resolve_keychain_key_for_remote(&credentials, &mut connection)
                .map_err(|error| NodeFailure::definite("credentialUnavailable", error))?;
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::definite("connection", error.message))?;
            session
                .target
                .sftp()
                .map(|_| ())
                .map_err(|error| NodeFailure::definite("sftp", error.to_string()))
        })
        .await
        .map_err(|_| NodeFailure::definite("sftpWorker", "SFTP probe worker stopped"))?
    }

    async fn observe_current_link(
        &self,
        input: &VerifiedNodeInput,
        target_id: &str,
    ) -> Result<Option<String>, NodeFailure> {
        let target = Self::target_definition(input, target_id)?.clone();
        let connection = self.verified_connection(input, &target)?;
        let known_hosts_path = self.known_hosts_path.clone();
        tokio::task::spawn_blocking(move || {
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::ambiguous("connection", error.message))?;
            let sftp = session
                .target
                .sftp()
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            verify_remote_root(&sftp, &target.remote_root)?;
            let current = format!("{}/current", target.remote_root);
            match sftp.lstat(Path::new(&current)) {
                Ok(stat) if stat.file_type() == FileType::Symlink => {
                    let link = sftp
                        .readlink(Path::new(&current))
                        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                    let link = link.to_str().ok_or_else(|| {
                        NodeFailure::definite(
                            "targetDrift",
                            "current link target is not valid UTF-8",
                        )
                    })?;
                    let release_id = link.strip_prefix("releases/").ok_or_else(|| {
                        NodeFailure::definite(
                            "targetDrift",
                            "current is not a relative release link",
                        )
                    })?;
                    super::node_registry::validate_identifier("releaseId", release_id)
                        .map_err(|error| NodeFailure::definite("targetDrift", error))?;
                    Ok(Some(link.to_string()))
                }
                Ok(_) => Err(NodeFailure::definite(
                    "targetDrift",
                    "current exists but is not a symbolic link",
                )),
                Err(error) if is_sftp_missing(&error) => Ok(None),
                Err(error) => Err(NodeFailure::ambiguous("sftp", error.to_string())),
            }
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("sftpWorker", "link observer stopped"))?
    }

    fn effect_receipt(
        input: &VerifiedNodeInput,
        receipt_type: &str,
        target_id: &str,
        payload: &Value,
    ) -> Result<EffectReceipt, NodeFailure> {
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let payload_digest = canonical_sha256(payload)
            .map_err(|error| NodeFailure::definite("receipt", error.to_string()))?;
        Ok(EffectReceipt {
            schema_version: 1,
            receipt_type: receipt_type.to_string(),
            operation_id: format!("effect-{}", &input.idempotency_key[22..]),
            run_id: input.frozen.run_id.clone(),
            node_id: input.frozen.node.id.clone(),
            attempt: input.attempt,
            target_id: target_id.to_string(),
            plan_digest: plan.plan_digest.clone(),
            payload_digest,
        })
    }

    async fn write_ledger(
        &self,
        input: &VerifiedNodeInput,
        result: &NodeExecutionResult,
        target_id: &str,
    ) -> Result<(), NodeFailure> {
        let target = Self::target_definition(input, target_id)?.clone();
        let connection = self.verified_connection(input, &target)?;
        let known_hosts_path = self.known_hosts_path.clone();
        let input = input.clone();
        let result = result.clone();
        tokio::task::spawn_blocking(move || {
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::ambiguous("connection", error.message))?;
            let sftp = session
                .target
                .sftp()
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            let directory = format!(
                "{}/.shellspan/runs/{}/{}",
                target.remote_root, input.frozen.run_id, input.frozen.node.id
            );
            ensure_remote_directories(&sftp, &directory)?;
            let path = format!("{directory}/{}.json", input.attempt);
            let bytes = serde_json::to_vec(&result)
                .map_err(|error| NodeFailure::definite("ledger", error.to_string()))?;
            write_remote_file(&sftp, &path, &bytes, true)
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("ledger", "ledger worker stopped"))?
    }

    async fn read_ledger(
        &self,
        input: &VerifiedNodeInput,
        target_id: &str,
    ) -> Result<Option<NodeExecutionResult>, NodeFailure> {
        let target = Self::target_definition(input, target_id)?.clone();
        let connection = self.verified_connection(input, &target)?;
        let known_hosts_path = self.known_hosts_path.clone();
        let run_id = input.frozen.run_id.clone();
        let node_id = input.frozen.node.id.clone();
        let attempt = input.attempt;
        let input = input.clone();
        let target_id = target_id.to_string();
        tokio::task::spawn_blocking(move || {
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::ambiguous("connection", error.message))?;
            let sftp = session
                .target
                .sftp()
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            let path = format!(
                "{}/.shellspan/runs/{}/{}/{}.json",
                target.remote_root, run_id, node_id, attempt
            );
            match sftp.open(Path::new(&path)) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(128 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|error| NodeFailure::ambiguous("ledger", error.to_string()))?;
                    if bytes.len() > 128 * 1024 {
                        return Err(NodeFailure::ambiguous(
                            "ledger",
                            "remote effect ledger exceeds the safety limit",
                        ));
                    }
                    let result: NodeExecutionResult = serde_json::from_slice(&bytes)
                        .map_err(|error| NodeFailure::ambiguous("ledger", error.to_string()))?;
                    let receipt = result.receipt.as_ref().ok_or_else(|| {
                        NodeFailure::ambiguous("ledger", "effect ledger receipt is missing")
                    })?;
                    let plan = input.immutable_plan.as_ref().ok_or_else(|| {
                        NodeFailure::definite("approval", "immutable plan is missing")
                    })?;
                    let payload = result
                        .outputs
                        .values()
                        .next()
                        .and_then(|output| output.value.get("payload"))
                        .ok_or_else(|| {
                            NodeFailure::ambiguous("ledger", "effect ledger payload is missing")
                        })?;
                    let payload_digest = canonical_sha256(payload)
                        .map_err(|error| NodeFailure::ambiguous("ledger", error.to_string()))?;
                    if receipt.operation_id != format!("effect-{}", &input.idempotency_key[22..])
                        || receipt.run_id != input.frozen.run_id
                        || receipt.node_id != input.frozen.node.id
                        || receipt.attempt != input.attempt
                        || receipt.target_id != target_id
                        || receipt.plan_digest != plan.plan_digest
                        || receipt.payload_digest != payload_digest
                    {
                        return Err(NodeFailure::ambiguous(
                            "ledger",
                            "remote effect ledger binding is invalid",
                        ));
                    }
                    Ok(Some(result))
                }
                Err(error) if is_sftp_missing(&error) => Ok(None),
                Err(error) => Err(NodeFailure::ambiguous("ledger", error.to_string())),
            }
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("ledger", "ledger worker stopped"))?
    }

    async fn execute_transfer(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let handle = input_handle(&input, "bundle")?;
        let projection = self
            .artifacts
            .inspect(&handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let target = Self::target_definition(&input, &config.target_id)?.clone();
        if target.id != config.target_id {
            return Err(NodeFailure::definite("targetMismatch", "target changed"));
        }
        let remote_directory = format!(
            "{}/.shellspan/staging/{}",
            target.remote_root, plan.target_release.release_id
        );
        let connection = self.verified_connection(&input, &target)?;
        let known_hosts_path = self.known_hosts_path.clone();
        let artifacts = self.artifacts.clone();
        let cancellation = context.cancellation.clone();
        let upload_handle = handle.clone();
        let upload_directory = remote_directory.clone();
        tokio::task::spawn_blocking(move || {
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::ambiguous("connection", error.message))?;
            let sftp = session
                .target
                .sftp()
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            ensure_remote_directories(&sftp, &upload_directory)?;
            for component in &projection.manifest.components {
                if cancellation.is_cancelled() {
                    return Err(NodeFailure::canceled());
                }
                let local = artifacts
                    .verified_component_path(&upload_handle, &component.name)
                    .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
                let remote = format!("{upload_directory}/{}", component.name);
                if let Some(parent) = remote.rsplit_once('/').map(|value| value.0) {
                    ensure_remote_directories(&sftp, parent)?;
                }
                let mut source = File::open(local)
                    .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
                let mut destination = sftp
                    .open_mode(
                        Path::new(&remote),
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                        0o600,
                        OpenType::File,
                    )
                    .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    if cancellation.is_cancelled() {
                        return Err(NodeFailure::canceled());
                    }
                    let count = source
                        .read(&mut buffer)
                        .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
                    if count == 0 {
                        break;
                    }
                    destination
                        .write_all(&buffer[..count])
                        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                }
                destination
                    .flush()
                    .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                drop(destination);
                let mut remote_file = sftp
                    .open(Path::new(&remote))
                    .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                let mut remote_hasher = Sha256::new();
                let mut remote_size = 0_u64;
                loop {
                    let count = remote_file
                        .read(&mut buffer)
                        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                    if count == 0 {
                        break;
                    }
                    remote_size = remote_size.saturating_add(count as u64);
                    remote_hasher.update(&buffer[..count]);
                }
                let remote_digest = format!(
                    "sha256:{}",
                    remote_hasher
                        .finalize()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                );
                if remote_size != component.size || remote_digest != component.digest {
                    return Err(NodeFailure::definite(
                        "remoteDigestMismatch",
                        "remote artifact digest verification failed",
                    ));
                }
            }
            let manifest = serde_json::to_vec(&projection.manifest)
                .map_err(|error| NodeFailure::definite("artifact", error.to_string()))?;
            write_remote_file(
                &sftp,
                &format!("{upload_directory}/manifest.json"),
                &manifest,
                false,
            )
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("transferWorker", "SFTP worker stopped"))??;
        let payload = serde_json::json!({
            "artifact": handle,
            "releaseId": plan.target_release.release_id,
            "remoteDirectory": remote_directory,
        });
        let receipt = Self::effect_receipt(&input, "transfer.sftp", &config.target_id, &payload)?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "transfer".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "componentCount": projection.component_count, "bytes": projection.total_size }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_prepare_compose(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let transfer = output_value(&input, "transfer")?;
        let payload = transfer
            .get("payload")
            .ok_or_else(|| NodeFailure::definite("input", "transfer payload is missing"))?;
        let remote_directory = payload
            .get("remoteDirectory")
            .and_then(Value::as_str)
            .ok_or_else(|| NodeFailure::definite("input", "transfer directory is missing"))?;
        let handle: ArtifactHandle = serde_json::from_value(
            payload
                .get("artifact")
                .cloned()
                .ok_or_else(|| NodeFailure::definite("input", "artifact handle is missing"))?,
        )
        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
        let bundle = self
            .artifacts
            .inspect(&handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        self.run_remote(
            &input,
            &config.target_id,
            DockerComposeRemoteAction::PrepareCompose {
                remote_directory: remote_directory.to_string(),
                component_names: bundle
                    .manifest
                    .components
                    .iter()
                    .map(|component| component.name.clone())
                    .collect(),
                prepared_identity: plan.target_release.artifact_content_digest.clone(),
            },
            context.cancellation,
        )
        .await?;
        let effect_payload = serde_json::json!({
            "remoteDirectory": remote_directory,
            "artifact": handle,
            "releaseId": payload.get("releaseId"),
        });
        let receipt = Self::effect_receipt(
            &input,
            "release.prepare-compose",
            &config.target_id,
            &effect_payload,
        )?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "release".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": effect_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "composeReleasePrepared": true }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_prepare_files(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let transfer = output_value(&input, "transfer")?;
        let transfer_payload = transfer
            .get("payload")
            .ok_or_else(|| NodeFailure::definite("input", "transfer payload is missing"))?;
        let handle: ArtifactHandle = serde_json::from_value(
            transfer_payload
                .get("artifact")
                .cloned()
                .ok_or_else(|| NodeFailure::definite("input", "artifact handle is missing"))?,
        )
        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
        let bundle = self
            .artifacts
            .inspect(&handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        if bundle.manifest.artifact_type != super::node_registry::ARTIFACT_TYPE_FILE_TREE {
            return Err(NodeFailure::definite(
                "artifactCompatibility",
                "release.prepare-files accepts only a file-tree artifact",
            ));
        }
        let component = bundle
            .manifest
            .components
            .iter()
            .find(|component| component.name == FILE_TREE_COMPONENT_NAME)
            .ok_or_else(|| {
                NodeFailure::definite(
                    "artifactIntegrity",
                    "file-tree archive component is missing",
                )
            })?;
        if component.media_type != FILE_TREE_MEDIA_TYPE {
            return Err(NodeFailure::definite(
                "artifactCompatibility",
                "file-tree archive media type is not supported",
            ));
        }
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        if !plan.artifacts.contains(&handle) {
            return Err(NodeFailure::definite(
                "artifactIntegrity",
                "file-tree artifact handle is not frozen in the approved plan",
            ));
        }
        if handle.content_digest != plan.target_release.artifact_content_digest {
            return Err(NodeFailure::definite(
                "artifactIntegrity",
                "prepared artifact does not match the approved release",
            ));
        }
        let target = Self::target_definition(&input, &config.target_id)?.clone();
        let connection = self.verified_connection(&input, &target)?;
        let known_hosts_path = self.known_hosts_path.clone();
        let artifacts = self.artifacts.clone();
        let extraction_handle = handle.clone();
        let release_id = plan.target_release.release_id.clone();
        let artifact_content_digest = plan.target_release.artifact_content_digest.clone();
        let layout_digest = plan.target_release.layout_digest.clone();
        let idempotency_suffix = input.idempotency_key[22..38].to_string();
        let cancellation = context.cancellation.clone();
        let remote_root = target.remote_root.clone();
        let release_directory = format!("{remote_root}/releases/{release_id}");
        let release_directory_for_worker = release_directory.clone();
        let summary = tokio::task::spawn_blocking(move || {
            let temporary = tempfile::tempdir()
                .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
            let extracted_root = temporary.path().join("files");
            let archive = artifacts
                .verified_component_path(&extraction_handle, FILE_TREE_COMPONENT_NAME)
                .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
            let extracted = extract_verified_file_tree(&archive, &extracted_root, &cancellation)?;
            let session =
                crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
                    .map_err(|error| NodeFailure::ambiguous("connection", error.message))?;
            let sftp = session
                .target
                .sftp()
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            verify_remote_root(&sftp, &remote_root)?;
            ensure_remote_directories(&sftp, &format!("{remote_root}/releases"))?;
            ensure_remote_directories(&sftp, &format!("{remote_root}/.shellspan/preparing"))?;
            let marker = format!(
                "{}\n{}\n{}\n",
                artifact_content_digest, layout_digest, release_id
            );
            match sftp.lstat(Path::new(&release_directory_for_worker)) {
                Ok(stat) if stat.file_type() == FileType::Directory => {
                    verify_remote_release_marker(
                        &sftp,
                        &release_directory_for_worker,
                        marker.as_bytes(),
                    )?;
                    verify_remote_release_tree(
                        &sftp,
                        &release_directory_for_worker,
                        &extracted.entries,
                    )?;
                    return Ok::<_, NodeFailure>(extracted);
                }
                Ok(_) => {
                    return Err(NodeFailure::definite(
                        "remoteConflict",
                        "release path exists with an unsafe type",
                    ))
                }
                Err(error) if is_sftp_missing(&error) => {}
                Err(error) => return Err(NodeFailure::ambiguous("sftp", error.to_string())),
            }
            let staging =
                format!("{remote_root}/.shellspan/preparing/{release_id}-{idempotency_suffix}");
            ensure_remote_directories(&sftp, &staging)?;
            for entry in extracted
                .entries
                .iter()
                .filter(|entry| entry.kind == FileTreeEntryKind::Directory)
            {
                if cancellation.is_cancelled() {
                    return Err(NodeFailure::canceled());
                }
                let remote = format!("{staging}/{}", entry.path);
                ensure_remote_directories(&sftp, &remote)?;
                sftp.setstat(
                    Path::new(&remote),
                    FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(entry.mode),
                        atime: None,
                        mtime: Some(0),
                    },
                )
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            }
            for entry in extracted
                .entries
                .iter()
                .filter(|entry| entry.kind == FileTreeEntryKind::File)
            {
                if cancellation.is_cancelled() {
                    return Err(NodeFailure::canceled());
                }
                let local = extracted_root.join(&entry.path);
                let remote = format!("{staging}/{}", entry.path);
                if let Some(parent) = remote.rsplit_once('/').map(|value| value.0) {
                    ensure_remote_directories(&sftp, parent)?;
                }
                let flags = match sftp.lstat(Path::new(&remote)) {
                    Ok(stat) if stat.file_type() == FileType::RegularFile => {
                        OpenFlags::WRITE | OpenFlags::TRUNCATE
                    }
                    Ok(_) => {
                        return Err(NodeFailure::definite(
                            "remoteConflict",
                            "staging member exists with an unsafe type",
                        ))
                    }
                    Err(error) if is_sftp_missing(&error) => {
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE
                    }
                    Err(error) => return Err(NodeFailure::ambiguous("sftp", error.to_string())),
                };
                let mut source = File::open(&local)
                    .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
                let mut destination = sftp
                    .open_mode(Path::new(&remote), flags, entry.mode as i32, OpenType::File)
                    .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                let mut copied = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    if cancellation.is_cancelled() {
                        return Err(NodeFailure::canceled());
                    }
                    let count = source
                        .read(&mut buffer)
                        .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?;
                    if count == 0 {
                        break;
                    }
                    copied = copied.saturating_add(count as u64);
                    if copied > entry.size {
                        return Err(NodeFailure::definite(
                            "artifactIntegrity",
                            "extracted member grew during upload",
                        ));
                    }
                    destination
                        .write_all(&buffer[..count])
                        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                }
                if copied != entry.size {
                    return Err(NodeFailure::definite(
                        "artifactIntegrity",
                        "extracted member size changed during upload",
                    ));
                }
                destination
                    .flush()
                    .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
                drop(destination);
                sftp.setstat(
                    Path::new(&remote),
                    FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(entry.mode),
                        atime: None,
                        mtime: Some(0),
                    },
                )
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
            }
            let marker_path = format!("{staging}/.prepared");
            match sftp.lstat(Path::new(&marker_path)) {
                Ok(stat) if stat.file_type() == FileType::RegularFile => {}
                Ok(_) => {
                    return Err(NodeFailure::definite(
                        "remoteConflict",
                        "staging marker exists with an unsafe type",
                    ))
                }
                Err(error) if is_sftp_missing(&error) => {}
                Err(error) => return Err(NodeFailure::ambiguous("sftp", error.to_string())),
            }
            write_remote_file(&sftp, &marker_path, marker.as_bytes(), false)?;
            verify_remote_release_tree(&sftp, &staging, &extracted.entries)?;
            match sftp.rename(
                Path::new(&staging),
                Path::new(&release_directory_for_worker),
                Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
            ) {
                Ok(()) => {}
                Err(rename_error) => match sftp.lstat(Path::new(&release_directory_for_worker)) {
                    Ok(stat) if stat.file_type() == FileType::Directory => {
                        verify_remote_release_marker(
                            &sftp,
                            &release_directory_for_worker,
                            marker.as_bytes(),
                        )?;
                        verify_remote_release_tree(
                            &sftp,
                            &release_directory_for_worker,
                            &extracted.entries,
                        )?;
                    }
                    _ => {
                        return Err(NodeFailure::ambiguous(
                            "sftpRename",
                            rename_error.to_string(),
                        ))
                    }
                },
            }
            verify_remote_release_tree(&sftp, &release_directory_for_worker, &extracted.entries)?;
            verify_remote_release_marker(&sftp, &release_directory_for_worker, marker.as_bytes())?;
            Ok(extracted)
        })
        .await
        .map_err(|_| NodeFailure::ambiguous("prepareWorker", "file prepare worker stopped"))??;
        let effect_payload = serde_json::json!({
            "remoteDirectory": release_directory,
            "artifact": handle,
            "releaseId": plan.target_release.release_id,
            "fileCount": summary.file_count,
            "directoryCount": summary.directory_count,
            "unpackedBytes": summary.total_size,
        });
        let receipt = Self::effect_receipt(
            &input,
            "release.prepare-files",
            &config.target_id,
            &effect_payload,
        )?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "release".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": effect_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({
                "fileReleasePrepared": true,
                "fileCount": summary.file_count,
                "bytes": summary.total_size,
            }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_load_image(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let release = output_value(&input, "release")?;
        let payload = release
            .get("payload")
            .ok_or_else(|| NodeFailure::definite("input", "prepared release payload is missing"))?;
        let remote_directory = payload
            .get("remoteDirectory")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                NodeFailure::definite("input", "prepared release directory is missing")
            })?;
        let handle: ArtifactHandle = serde_json::from_value(
            payload
                .get("artifact")
                .cloned()
                .ok_or_else(|| NodeFailure::definite("input", "artifact handle is missing"))?,
        )
        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
        let bundle = self
            .artifacts
            .inspect(&handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        let image = bundle
            .manifest
            .components
            .iter()
            .find(|component| component.name == "image.tar")
            .ok_or_else(|| {
                NodeFailure::definite("artifactIntegrity", "image archive is missing")
            })?;
        let image_reference = image
            .annotations
            .get("imageReference")
            .ok_or_else(|| NodeFailure::definite("imageIdentity", "image reference is missing"))?;
        let image_id = image
            .annotations
            .get("imageId")
            .ok_or_else(|| NodeFailure::definite("imageIdentity", "image ID is missing"))?;
        self.run_remote(
            &input,
            &config.target_id,
            DockerComposeRemoteAction::LoadImage {
                archive: format!("{remote_directory}/image.tar"),
                image_reference: image_reference.clone(),
                image_id: image_id.clone(),
                image_manifest_id: image.annotations.get("imageManifestId").cloned(),
            },
            context.cancellation,
        )
        .await?;
        let effect_payload = serde_json::json!({
            "remoteDirectory": remote_directory,
            "artifact": handle,
            "releaseId": payload.get("releaseId"),
        });
        let receipt = Self::effect_receipt(
            &input,
            "runtime.load-image",
            &config.target_id,
            &effect_payload,
        )?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "image".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": effect_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "imageLoaded": true }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_compose(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: DeployComposeConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let image = output_value(&input, "image")?;
        let payload = image
            .get("payload")
            .ok_or_else(|| NodeFailure::definite("input", "image payload is missing"))?;
        let remote_directory = payload
            .get("remoteDirectory")
            .and_then(Value::as_str)
            .ok_or_else(|| NodeFailure::definite("input", "release directory is missing"))?;
        let handle: ArtifactHandle = serde_json::from_value(
            payload
                .get("artifact")
                .cloned()
                .ok_or_else(|| NodeFailure::definite("input", "artifact handle is missing"))?,
        )
        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
        let bundle = self
            .artifacts
            .inspect(&handle)
            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
        let image_reference = bundle
            .manifest
            .components
            .iter()
            .find(|component| component.name == "image.tar")
            .and_then(|component| component.annotations.get("imageReference"))
            .ok_or_else(|| NodeFailure::definite("imageIdentity", "image reference is missing"))?;
        if config.pull_policy != "never"
            || bundle.manifest.annotations.get("projectName") != Some(&config.project_name)
            || bundle.manifest.annotations.get("services") != Some(&config.services.join(","))
        {
            return Err(NodeFailure::definite(
                "composeBinding",
                "activation differs from the frozen Compose bundle",
            ));
        }
        let compose_files = bundle
            .manifest
            .components
            .iter()
            .filter(|component| component.role == ArtifactRole::DeploymentConfig)
            .map(|component| format!("{remote_directory}/{}", component.name))
            .collect::<Vec<_>>();
        if compose_files.is_empty() {
            return Err(NodeFailure::definite(
                "composeConfig",
                "Compose bundle has no configuration",
            ));
        }
        let document: Value = serde_yaml::from_slice(
            &fs::read(
                self.artifacts
                    .verified_component_path(&handle, "compose.yaml")
                    .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?,
            )
            .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?,
        )
        .map_err(|error| NodeFailure::definite("composeConfig", error.to_string()))?;
        let service = &document["services"][&config.services[0]];
        let container_user = service["user"].as_str().unwrap_or("").to_string();
        let mounts = service["volumes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|mount| RegisteredBindMount {
                source: mount["source"].as_str().unwrap_or("").into(),
                target: mount["target"].as_str().unwrap_or("").into(),
                read_only: mount["read_only"].as_bool().unwrap_or(false),
            })
            .collect::<Vec<_>>();
        if !mounts.is_empty() && !super::compose_release::numeric_container_user(&container_user) {
            return Err(NodeFailure::definite(
                "containerIdentity",
                "mount access requires a numeric UID:GID",
            ));
        }
        let host = self.host_bundle(&handle)?;
        let action = if let Some(host) = &host {
            let root = &Self::target_definition(&input, &config.target_id)?.remote_root;
            let checksums = bundle
                .manifest
                .components
                .iter()
                .filter(|component| component.name != "image.tar")
                .map(|component| {
                    format!(
                        "{}  {}\n",
                        component.digest.trim_start_matches("sha256:"),
                        component.name
                    )
                })
                .collect::<String>();
            DockerComposeRemoteAction::HostComposeDeploy {
                command: format!(
                    "set -eu; cd {}; printf '%s' {} | sha256sum --check --status; {}",
                    posix_quote(remote_directory),
                    posix_quote(&checksums),
                    host.deploy(root, remote_directory, image_reference)
                ),
            }
        } else {
            DockerComposeRemoteAction::ComposeDeploy {
                compose_files,
                project_name: config.project_name.clone(),
                services: config.services.clone(),
                pull_policy: config.pull_policy.clone(),
                image_reference: image_reference.clone(),
                container_user: container_user.clone(),
                mounts: mounts.clone(),
            }
        };
        self.run_remote(&input, &config.target_id, action, context.cancellation)
            .await?;
        let effect_payload = serde_json::json!({
            "remoteDirectory": remote_directory,
            "releaseId": payload.get("releaseId"),
            "projectName": config.project_name,
            "services": config.services,
            "artifact": handle,
            "containerUser": container_user,
            "verifiedMounts": mounts,
            "hostCompose": host.is_some(),
            "backupDirectory": host.as_ref().map(|_| format!("{remote_directory}/host-backup")),
        });
        let receipt =
            Self::effect_receipt(&input, "deploy.compose", &config.target_id, &effect_payload)?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "activation".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": effect_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "composeStarted": true }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    fn static_activation_result(
        input: &VerifiedNodeInput,
        target_id: &str,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let payload = serde_json::json!({
            "release": plan.target_release,
            "remoteDirectory": format!(
                "{}/releases/{}",
                plan.target.remote_root, plan.target_release.release_id
            ),
            "relativeLink": format!("releases/{}", plan.target_release.release_id),
            "previousRelativeLink": plan
                .previous_release
                .as_ref()
                .map(|release| format!("releases/{}", release.release_id)),
        });
        let receipt = Self::effect_receipt(input, "deploy.static-switch", target_id, &payload)?;
        Ok(NodeExecutionResult {
            outputs: BTreeMap::from([(
                "activation".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "staticReleaseActivated": true }),
        })
    }

    async fn execute_static_switch(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: StaticSwitchConfig =
            serde_json::from_value(input.frozen.node.config.clone())
                .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        if config.link_name != "current" {
            return Err(NodeFailure::definite(
                "config",
                "static switch link name must be current",
            ));
        }
        let release = output_value(&input, "release")?;
        let remote_directory = release
            .pointer("/payload/remoteDirectory")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                NodeFailure::definite("input", "prepared release directory is missing")
            })?;
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let expected_directory = format!(
            "{}/releases/{}",
            plan.target.remote_root, plan.target_release.release_id
        );
        if remote_directory != expected_directory {
            return Err(NodeFailure::definite(
                "releaseIdentity",
                "prepared release directory does not match the approved release",
            ));
        }
        self.run_remote(
            &input,
            &config.target_id,
            DockerComposeRemoteAction::StaticSwitch {
                remote_root: plan.target.remote_root.clone(),
                release_id: plan.target_release.release_id.clone(),
                artifact_content_digest: plan.target_release.artifact_content_digest.clone(),
                layout_digest: plan.target_release.layout_digest.clone(),
                previous_release_id: plan
                    .previous_release
                    .as_ref()
                    .map(|release| release.release_id.clone()),
            },
            context.cancellation,
        )
        .await?;
        let result = Self::static_activation_result(&input, &config.target_id)?;
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_verify(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: VerifyHttpConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let activation = output_value(&input, "activation")?;
        let url = format!(
            "{}://127.0.0.1:{}{}",
            config.scheme, config.port, config.path
        );
        let output = self
            .run_remote(
                &input,
                &config.target_id,
                DockerComposeRemoteAction::VerifyHttp { url: url.clone() },
                context.cancellation,
            )
            .await?;
        let status = output.trim().parse::<u16>().map_err(|_| {
            NodeFailure::definite("verification", "HTTP probe returned an invalid status")
        })?;
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let outcome = if config.expected_statuses.contains(&status) {
            "passed"
        } else {
            "failed"
        };
        let evidence_payload = serde_json::json!({ "url": url, "status": status, "expectedStatuses": config.expected_statuses, "activationDigest": canonical_sha256(&activation).map_err(|error| NodeFailure::definite("verification", error.to_string()))? });
        let evidence = VerificationEvidence {
            schema_version: 1,
            evidence_type: "verify.http".into(),
            run_id: input.frozen.run_id.clone(),
            node_id: input.frozen.node.id.clone(),
            target_id: config.target_id,
            plan_digest: plan.plan_digest.clone(),
            observed_at: current_timestamp_ms(),
            outcome: outcome.into(),
            payload_digest: canonical_sha256(&evidence_payload)
                .map_err(|error| NodeFailure::definite("verification", error.to_string()))?,
        };
        if outcome != "passed" {
            return Err(NodeFailure::definite(
                "verificationFailed",
                format!("HTTP status {status} was not approved"),
            ));
        }
        Ok(NodeExecutionResult {
            outputs: BTreeMap::from([(
                "evidence".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Evidence,
                    value: serde_json::json!({ "evidence": evidence, "payload": evidence_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: None,
            evidence: Some(evidence),
            summary: serde_json::json!({ "httpStatus": status }),
        })
    }

    async fn execute_nginx(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let evidence = output_value(&input, "evidence")?;
        self.run_remote(
            &input,
            &config.target_id,
            DockerComposeRemoteAction::NginxReload,
            context.cancellation,
        )
        .await?;
        let effect_payload = serde_json::json!({
            "verifiedEvidenceDigest": canonical_sha256(&evidence).map_err(|error| NodeFailure::definite("nginx", error.to_string()))?,
            "verification": evidence,
        });
        let receipt = Self::effect_receipt(
            &input,
            "proxy.nginx-reload",
            &config.target_id,
            &effect_payload,
        )?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "activation".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": effect_payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "nginxReloaded": true }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }

    async fn execute_commit(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        let config: TargetOnlyConfig = serde_json::from_value(input.frozen.node.config.clone())
            .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
        let plan = input
            .immutable_plan
            .as_ref()
            .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is required"))?;
        let staging = format!(
            "{}/.shellspan/staging/{}",
            plan.target.remote_root, plan.target_release.release_id
        );
        let release = format!(
            "{}/releases/{}",
            plan.target.remote_root, plan.target_release.release_id
        );
        let metadata = format!(
            "releaseId={}\nartifactContentDigest={}\nlayoutDigest={}\nplanDigest={}\n",
            plan.target_release.release_id,
            plan.target_release.artifact_content_digest,
            plan.target_release.layout_digest,
            plan.plan_digest,
        );
        self.run_remote(
            &input,
            &config.target_id,
            DockerComposeRemoteAction::CommitRelease {
                remote_root: plan.target.remote_root.clone(),
                staging,
                release,
                artifact_content_digest: plan.target_release.artifact_content_digest.clone(),
                layout_digest: plan.target_release.layout_digest.clone(),
                metadata,
            },
            context.cancellation,
        )
        .await?;
        let payload = serde_json::json!({ "activeRelease": plan.target_release });
        let receipt = Self::effect_receipt(&input, "release.commit", &config.target_id, &payload)?;
        let result = NodeExecutionResult {
            outputs: BTreeMap::from([(
                "activeRelease".into(),
                NodeOutputValue {
                    kind: NodeOutputKind::Receipt,
                    value: serde_json::json!({ "receipt": receipt, "payload": payload }),
                    artifact_reference: None,
                },
            )]),
            receipt: Some(receipt),
            evidence: None,
            summary: serde_json::json!({ "releaseCommitted": true }),
        };
        self.write_ledger(&input, &result, &config.target_id)
            .await?;
        Ok(result)
    }
}

fn is_sftp_missing(error: &ssh2::Error) -> bool {
    error.code() == ErrorCode::SFTP(2)
}

fn ensure_remote_directories(sftp: &Sftp, path: &str) -> Result<(), NodeFailure> {
    let mut current = String::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        current.push('/');
        current.push_str(segment);
        match sftp.lstat(Path::new(&current)) {
            Ok(stat) if stat.file_type() == FileType::Directory => {}
            Ok(_) => {
                return Err(NodeFailure::definite(
                    "remotePath",
                    "remote path component is not a directory",
                ))
            }
            Err(error) if is_sftp_missing(&error) => sftp
                .mkdir(Path::new(&current), 0o700)
                .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?,
            Err(error) => return Err(NodeFailure::ambiguous("sftp", error.to_string())),
        }
    }
    Ok(())
}

fn write_remote_file(
    sftp: &Sftp,
    path: &str,
    bytes: &[u8],
    exclusive: bool,
) -> Result<(), NodeFailure> {
    let flags = if exclusive {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE
    } else {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    };
    let mut file = sftp
        .open_mode(Path::new(path), flags, 0o600, OpenType::File)
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    file.flush()
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))
}

fn verify_remote_root(sftp: &Sftp, remote_root: &str) -> Result<(), NodeFailure> {
    let canonical = sftp
        .realpath(Path::new(remote_root))
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    if canonical.to_str() != Some(remote_root) {
        return Err(NodeFailure::definite(
            "remotePath",
            "remote root no longer has its frozen canonical identity",
        ));
    }
    let stat = sftp
        .lstat(Path::new(remote_root))
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    if stat.file_type() != FileType::Directory {
        return Err(NodeFailure::definite(
            "remotePath",
            "remote root is not a directory",
        ));
    }
    Ok(())
}

fn remote_file_digest(sftp: &Sftp, path: &str, expected_size: u64) -> Result<String, NodeFailure> {
    let mut file = sftp
        .open(Path::new(path))
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| NodeFailure::definite("remoteConflict", "remote size overflow"))?;
        if total > expected_size {
            return Err(NodeFailure::definite(
                "remoteConflict",
                "remote file exceeds the expected size",
            ));
        }
        hasher.update(&buffer[..count]);
    }
    if total != expected_size {
        return Err(NodeFailure::definite(
            "remoteConflict",
            "remote file size differs from the prepared release",
        ));
    }
    Ok(format!(
        "sha256:{}",
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn remote_release_entries(
    sftp: &Sftp,
    root: &str,
    relative: &str,
    entries: &mut BTreeMap<String, (FileType, u64, u32)>,
    depth: usize,
) -> Result<(), NodeFailure> {
    if depth > super::file_tree_artifact::MAX_FILE_TREE_DEPTH
        || entries.len() >= super::file_tree_artifact::MAX_FILE_TREE_ENTRIES
    {
        return Err(NodeFailure::definite(
            "remoteConflict",
            "remote release exceeds the file-tree safety limits",
        ));
    }
    let directory = if relative.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{relative}")
    };
    for (path, stat) in sftp
        .readdir(Path::new(&directory))
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?
    {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                NodeFailure::definite("remoteConflict", "remote path is not valid UTF-8")
            })?;
        if matches!(name, "." | "..") {
            continue;
        }
        if entries.len() >= super::file_tree_artifact::MAX_FILE_TREE_ENTRIES {
            return Err(NodeFailure::definite(
                "remoteConflict",
                "remote release exceeds the file-count limit",
            ));
        }
        let child = if relative.is_empty() {
            name.to_string()
        } else {
            format!("{relative}/{name}")
        };
        if matches!(child.as_str(), ".prepared" | ".cleanup-eligible") {
            continue;
        }
        super::file_tree_artifact::normalize_archive_path(Path::new(&child))?;
        let kind = stat.file_type();
        if !matches!(kind, FileType::Directory | FileType::RegularFile) {
            return Err(NodeFailure::definite(
                "remoteConflict",
                "remote release contains a link or special file",
            ));
        }
        let is_directory = kind == FileType::Directory;
        if entries
            .insert(
                child.clone(),
                (kind, stat.size.unwrap_or(0), stat.perm.unwrap_or(0)),
            )
            .is_some()
        {
            return Err(NodeFailure::definite(
                "remoteConflict",
                "remote release contains a duplicate path",
            ));
        }
        if is_directory {
            remote_release_entries(sftp, root, &child, entries, depth + 1)?;
        }
    }
    Ok(())
}

fn verify_remote_release_tree(
    sftp: &Sftp,
    release_root: &str,
    expected: &[FileTreeEntry],
) -> Result<(), NodeFailure> {
    let mut actual = BTreeMap::new();
    remote_release_entries(sftp, release_root, "", &mut actual, 0)?;
    let expected_paths = expected
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<BTreeSet<_>>();
    if actual.len() != expected_paths.len()
        || actual
            .keys()
            .any(|path| !expected_paths.contains(path.as_str()))
    {
        return Err(NodeFailure::definite(
            "remoteConflict",
            "existing release has a different file-tree shape",
        ));
    }
    for entry in expected {
        let (kind, size, permissions) = actual.get(&entry.path).ok_or_else(|| {
            NodeFailure::definite("remoteConflict", "remote release member is missing")
        })?;
        match entry.kind {
            FileTreeEntryKind::Directory if *kind == FileType::Directory => {}
            FileTreeEntryKind::File if *kind == FileType::RegularFile => {
                if *size != entry.size {
                    return Err(NodeFailure::definite(
                        "remoteConflict",
                        "remote release member size differs",
                    ));
                }
                let expected_executable = entry.mode & 0o111 != 0;
                if (*permissions & 0o111 != 0) != expected_executable {
                    return Err(NodeFailure::definite(
                        "remoteConflict",
                        "remote release member executable permission differs",
                    ));
                }
                let digest = remote_file_digest(
                    sftp,
                    &format!("{release_root}/{}", entry.path),
                    entry.size,
                )?;
                if entry.digest.as_deref() != Some(digest.as_str()) {
                    return Err(NodeFailure::definite(
                        "remoteConflict",
                        "remote release member digest differs",
                    ));
                }
            }
            _ => {
                return Err(NodeFailure::definite(
                    "remoteConflict",
                    "remote release member type differs",
                ))
            }
        }
    }
    Ok(())
}

fn verify_remote_release_marker(
    sftp: &Sftp,
    release_root: &str,
    expected: &[u8],
) -> Result<(), NodeFailure> {
    let marker_path = format!("{release_root}/.prepared");
    let stat = sftp
        .lstat(Path::new(&marker_path))
        .map_err(|error| NodeFailure::definite("remoteConflict", error.to_string()))?;
    if stat.file_type() != FileType::RegularFile || stat.size.unwrap_or(u64::MAX) > 4 * 1024 {
        return Err(NodeFailure::definite(
            "remoteConflict",
            "release marker is not a bounded regular file",
        ));
    }
    let mut bytes = Vec::new();
    sftp.open(Path::new(&marker_path))
        .map_err(|error| NodeFailure::definite("remoteConflict", error.to_string()))?
        .take(4 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| NodeFailure::ambiguous("sftp", error.to_string()))?;
    if bytes != expected {
        return Err(NodeFailure::definite(
            "remoteConflict",
            "existing release marker conflicts with the approved release",
        ));
    }
    Ok(())
}

fn input_handle(input: &VerifiedNodeInput, name: &str) -> Result<ArtifactHandle, NodeFailure> {
    serde_json::from_value(
        input
            .frozen
            .inputs
            .get(name)
            .cloned()
            .ok_or_else(|| NodeFailure::definite("input", format!("missing input {name}")))?,
    )
    .map_err(|error| NodeFailure::definite("input", error.to_string()))
}

fn output_value(input: &VerifiedNodeInput, name: &str) -> Result<Value, NodeFailure> {
    input
        .frozen
        .inputs
        .get(name)
        .cloned()
        .ok_or_else(|| NodeFailure::definite("input", format!("missing input {name}")))
}

fn parse_preflight_output(output: &str) -> Result<BTreeMap<String, String>, NodeFailure> {
    let allowed = [
        "ssh",
        "docker",
        "compose",
        "http",
        "nginx",
        "atomicSymlink",
        "currentLink",
        "releaseId",
        "artifactContentDigest",
        "layoutDigest",
        "planDigest",
    ];
    let mut fields = BTreeMap::new();
    for line in output.lines() {
        let (key, value) = line.split_once('=').ok_or_else(|| {
            NodeFailure::definite("preflight", "remote preflight output is malformed")
        })?;
        if !allowed.contains(&key)
            || value.is_empty()
            || value.len() > 512
            || value.chars().any(char::is_control)
            || fields.insert(key.to_string(), value.to_string()).is_some()
        {
            return Err(NodeFailure::definite(
                "preflight",
                "remote preflight output contains an invalid field",
            ));
        }
    }
    for flag in ["ssh", "docker", "compose", "http", "nginx", "atomicSymlink"] {
        if !matches!(fields.get(flag).map(String::as_str), Some("0" | "1")) {
            return Err(NodeFailure::definite(
                "preflight",
                "remote preflight capability field is invalid",
            ));
        }
    }
    if let Some(link) = fields.get("currentLink") {
        let release_id = link.strip_prefix("releases/").ok_or_else(|| {
            NodeFailure::definite(
                "preflight",
                "current must be a relative releases/<releaseId> symbolic link",
            )
        })?;
        super::node_registry::validate_identifier("releaseId", release_id)
            .map_err(|error| NodeFailure::definite("preflight", error))?;
    }
    if let Some(release_id) = fields.get("releaseId") {
        super::node_registry::validate_identifier("releaseId", release_id)
            .map_err(|error| NodeFailure::definite("preflight", error))?;
        for digest in ["artifactContentDigest", "layoutDigest", "planDigest"] {
            let valid = fields.get(digest).is_some_and(|value| {
                value.len() == 71
                    && value.starts_with("sha256:")
                    && value[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            });
            if !valid {
                return Err(NodeFailure::definite(
                    "preflight",
                    "remote release identity is incomplete or invalid",
                ));
            }
        }
    } else if fields.contains_key("artifactContentDigest")
        || fields.contains_key("layoutDigest")
        || fields.contains_key("planDigest")
    {
        return Err(NodeFailure::definite(
            "preflight",
            "remote release identity is incomplete",
        ));
    }
    Ok(fields)
}

fn require_target_capabilities(
    required: &[String],
    capabilities: &BTreeMap<String, String>,
) -> Result<(), NodeFailure> {
    for required in required {
        let key = match required.as_str() {
            "sftp" => "sftp",
            "docker" => "docker",
            "compose" => "compose",
            "http" => "http",
            "nginx" => "nginx",
            "atomicSymlink" => "atomicSymlink",
            _ => {
                return Err(NodeFailure::definite(
                    "capability",
                    "unsupported target capability",
                ))
            }
        };
        if capabilities.get(key).map(String::as_str) != Some("1") {
            return Err(NodeFailure::definite(
                "capability",
                format!("target capability {required} is unavailable"),
            ));
        }
    }
    Ok(())
}

#[async_trait]
impl DockerComposeExecutionBackend for NativeDockerComposeBackend {
    async fn execute(
        &self,
        node_type: &str,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure> {
        if context.cancellation.is_cancelled() {
            return Err(NodeFailure::canceled());
        }
        match node_type {
            "source.snapshot" => {
                let config: SourceSnapshotConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let backend = self.clone();
                let snapshot = tokio::task::spawn_blocking(move || {
                    let binding = config.binding.ok_or_else(|| {
                        NodeFailure::definite(
                            "sourceBindingRequired",
                            "bind a local Git repository before preparing a deployment",
                        )
                    })?;
                    let captured = super::source_binding::capture_ref(
                        &binding,
                        &config.source_ref,
                        &context.cancellation,
                    )
                    .map_err(|error| {
                        if context.cancellation.is_cancelled() {
                            NodeFailure::canceled()
                        } else {
                            NodeFailure::definite("sourceCapture", error)
                        }
                    })?;
                    let snapshot = captured.snapshot;
                    backend
                        .sources
                        .lock()
                        .map_err(|_| {
                            NodeFailure::definite("sourceUnavailable", "source lock poisoned")
                        })?
                        .insert(
                            (
                                snapshot.metadata_digest.clone(),
                                snapshot.snapshot_digest.clone(),
                            ),
                            (snapshot.clone(), Arc::new(captured.directory)),
                        );
                    Ok::<_, NodeFailure>(snapshot)
                })
                .await
                .map_err(|_| {
                    NodeFailure::definite("sourceWorker", "source snapshot worker stopped")
                })??;
                Ok(NodeExecutionResult::output(
                    "source",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: serde_json::to_value(snapshot)
                            .map_err(|error| NodeFailure::definite("source", error.to_string()))?,
                        artifact_reference: None,
                    },
                ))
            }
            "build.package-script" => {
                let config: PackageScriptConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let source: FrozenSourceSnapshot =
                    serde_json::from_value(output_value(&input, "source")?)
                        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
                let backend = self.clone();
                let cancellation = context.cancellation.clone();
                let planned = input.planned.clone();
                let timeout = Duration::from_secs(u64::from(input.frozen.node.timeout_seconds));
                let handle = tokio::task::spawn_blocking(move || {
                    let frozen = backend.frozen_source_root(&source)?;
                    let materialized = super::source_binding::materialize(frozen.path())
                        .map_err(|error| NodeFailure::definite("sourceMaterialize", error))?;
                    let source_root = materialized.path();
                    let handle = execute_package_script_build(
                        &source_root,
                        &source,
                        &config,
                        &planned,
                        &backend.artifacts,
                        &cancellation,
                        timeout,
                        || Ok(()),
                    )?;
                    Ok::<_, NodeFailure>(handle)
                })
                .await
                .map_err(|_| {
                    NodeFailure::definite("buildWorker", "package build worker stopped")
                })??;
                Ok(NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&handle).map_err(|error| {
                            NodeFailure::definite("artifact", error.to_string())
                        })?,
                        artifact_reference: Some(handle.artifact_reference),
                    },
                ))
            }
            "build.docker-buildx" => {
                let config: DockerBuildxConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let source: FrozenSourceSnapshot =
                    serde_json::from_value(output_value(&input, "source")?)
                        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
                let backend = self.clone();
                let cancellation = context.cancellation.clone();
                let planned = input.planned.clone();
                let projection = tokio::task::spawn_blocking(move || {
                    let frozen = backend.frozen_source_root(&source)?;
                    build_image_bundle(
                        frozen.path(),
                        source,
                        config,
                        planned.config_digest,
                        &backend.artifacts,
                        &cancellation,
                        Duration::from_secs(u64::from(input.frozen.node.timeout_seconds)),
                    )
                })
                .await
                .map_err(|_| {
                    NodeFailure::definite("buildWorker", "Docker build worker stopped")
                })??;
                Ok(NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&projection.handle).map_err(|error| {
                            NodeFailure::definite("artifact", error.to_string())
                        })?,
                        artifact_reference: Some(projection.handle.artifact_reference),
                    },
                ))
            }
            "artifact.collect" => {
                let config: ArtifactCollectConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let source: FrozenSourceSnapshot =
                    serde_json::from_value(output_value(&input, "source")?)
                        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
                let backend = self.clone();
                let cancellation = context.cancellation.clone();
                let planned = input.planned.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    let frozen = backend.frozen_source_root(&source)?;
                    let materialized = super::source_binding::materialize(frozen.path())
                        .map_err(|error| NodeFailure::definite("sourceMaterialize", error))?;
                    let source_root = materialized.path();
                    let handle = execute_artifact_collect(
                        &source_root,
                        &source,
                        &config,
                        &planned,
                        &backend.artifacts,
                        &cancellation,
                        || Ok(()),
                    )?;
                    Ok::<_, NodeFailure>(handle)
                })
                .await
                .map_err(|_| {
                    NodeFailure::definite("artifactWorker", "artifact collection worker stopped")
                })??;
                Ok(NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&handle).map_err(|error| {
                            NodeFailure::definite("artifact", error.to_string())
                        })?,
                        artifact_reference: Some(handle.artifact_reference),
                    },
                ))
            }
            "artifact.bundle-compose" => {
                let config: BundleComposeConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let image_handle = input_handle(&input, "imageBundle")?;
                let source: FrozenSourceSnapshot =
                    serde_json::from_value(output_value(&input, "source")?)
                        .map_err(|error| NodeFailure::definite("input", error.to_string()))?;
                let backend = self.clone();
                let planned = input.planned.clone();
                let projection = tokio::task::spawn_blocking(move || {
                    let frozen = backend.frozen_source_root(&source)?;
                    let source_root = frozen.path();
                    let image = backend
                        .artifacts
                        .inspect(&image_handle)
                        .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
                    if image.manifest.source.snapshot_digest != source.snapshot_digest {
                        return Err(NodeFailure::definite(
                            "artifactIntegrity",
                            "image and Compose source snapshots differ",
                        ));
                    }
                    let image_component = image
                        .manifest
                        .components
                        .iter()
                        .find(|component| component.name == "image.tar")
                        .ok_or_else(|| {
                            NodeFailure::definite(
                                "artifactIntegrity",
                                "image archive component is missing",
                            )
                        })?;
                    let mut components = vec![image_component.clone()];
                    let mut sources = vec![ArtifactBlobSource {
                        digest: image_component.digest.clone(),
                        path: backend
                            .artifacts
                            .verified_component_path(&image_handle, "image.tar")
                            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?,
                    }];
                    let image_reference = image_component
                        .annotations
                        .get("imageReference")
                        .ok_or_else(|| {
                            NodeFailure::definite("imageIdentity", "image reference is missing")
                        })?;
                    let release = super::compose_release::compile(
                        source_root,
                        &config,
                        image_reference,
                        &context.cancellation,
                    )?;
                    for entry in fs::read_dir(release.path())
                        .map_err(|error| NodeFailure::definite("artifactIo", error.to_string()))?
                    {
                        let entry = entry.map_err(|error| {
                            NodeFailure::definite("artifactIo", error.to_string())
                        })?;
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name != "compose.yaml" && !name.starts_with("config-") {
                            continue;
                        }
                        let path = entry.path();
                        let (digest, size) = sha256_file(&path)?;
                        components.push(ArtifactDescriptor {
                            name: name.clone(),
                            role: if name == "compose.yaml" {
                                ArtifactRole::DeploymentConfig
                            } else {
                                ArtifactRole::Auxiliary
                            },
                            media_type: if name == "compose.yaml" {
                                "application/vnd.shellspan.compose+yaml"
                            } else {
                                "application/octet-stream"
                            }
                            .into(),
                            digest: digest.clone(),
                            size,
                            platform: None,
                            annotations: BTreeMap::new(),
                        });
                        sources.push(ArtifactBlobSource { digest, path });
                    }
                    components.sort_by(|left, right| left.name.cmp(&right.name));
                    let manifest = ArtifactBundleManifest {
                        schema_version: 2,
                        artifact_type: super::node_registry::ARTIFACT_TYPE_COMPOSE_RELEASE.into(),
                        source: ArtifactSource {
                            revision: source.revision,
                            dirty: source.dirty,
                            snapshot_digest: source.snapshot_digest,
                        },
                        components,
                        producer: ArtifactProducer {
                            node_type: "artifact.bundle-compose".into(),
                            node_type_version: 1,
                            config_digest: planned.config_digest,
                        },
                        annotations: BTreeMap::from([
                            ("projectName".into(), config.project_name),
                            ("services".into(), config.services.join(",")),
                        ]),
                    };
                    let mut unique = BTreeMap::<String, ArtifactBlobSource>::new();
                    for source in sources {
                        unique.entry(source.digest.clone()).or_insert(source);
                    }
                    backend
                        .artifacts
                        .publish_bundle(&manifest, &unique.into_values().collect::<Vec<_>>())
                        .map_err(|error| NodeFailure::definite("artifactPublish", error))
                })
                .await
                .map_err(|_| {
                    NodeFailure::definite("bundleWorker", "Compose bundle worker stopped")
                })??;
                Ok(NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&projection.handle).map_err(|error| {
                            NodeFailure::definite("artifact", error.to_string())
                        })?,
                        artifact_reference: Some(projection.handle.artifact_reference),
                    },
                ))
            }
            "target.preflight" => {
                let config: TargetPreflightConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                let target = Self::target_definition(&input, &config.target_id)?.clone();
                let output = self
                    .run_remote(
                        &input,
                        &config.target_id,
                        DockerComposeRemoteAction::Preflight {
                            remote_root: target.remote_root.clone(),
                            require_atomic_symlink: config
                                .required_capabilities
                                .iter()
                                .any(|capability| capability == "atomicSymlink"),
                        },
                        context.cancellation.clone(),
                    )
                    .await?;
                self.probe_sftp(&target.connection_profile_id).await?;
                let mut capabilities = parse_preflight_output(&output)?;
                let preflight_bundle = input_handle(&input, "bundle")?;
                let host = self.host_bundle(&preflight_bundle)?;
                if let Some(host) = &host {
                    let fingerprint = self
                        .run_remote(
                            &input,
                            &config.target_id,
                            DockerComposeRemoteAction::HostComposeCheck {
                                command: host.preflight(&target.remote_root),
                            },
                            context.cancellation.clone(),
                        )
                        .await?;
                    let fingerprint = fingerprint.trim();
                    if fingerprint.len() != 64
                        || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err(NodeFailure::definite(
                            "hostCompose",
                            "invalid host configuration fingerprint",
                        ));
                    }
                    capabilities.insert("hostComposeDigest".into(), fingerprint.into());
                }
                if host.is_none()
                    && capabilities.contains_key("releaseId")
                    && config
                        .required_capabilities
                        .iter()
                        .any(|capability| capability == "compose")
                {
                    let entry = self
                        .database
                        .list_deployment_applications()
                        .map_err(|error| NodeFailure::definite("managedEvidence", error))?
                        .into_iter()
                        .find(|entry| {
                            entry.environment.config.remote_root == target.remote_root
                                && entry.environment.config.connection_profile_id
                                    == target.connection_profile_id
                        })
                        .ok_or_else(|| {
                            NodeFailure::definite(
                                "managedEvidence",
                                "current Compose release is not associated with this target",
                            )
                        })?;
                    let check = super::readiness::managed_compose_check(&entry, &self.database)
                        .map_err(|error| NodeFailure::definite("managedEvidence", error))?
                        .ok_or_else(|| {
                            NodeFailure::definite(
                                "managedEvidence",
                                "current Compose release has no successful local evidence",
                            )
                        })?;
                    self.run_remote(
                        &input,
                        &config.target_id,
                        DockerComposeRemoteAction::CheckManagedCompose(check),
                        context.cancellation.clone(),
                    )
                    .await?;
                }
                if host.is_none() && !capabilities.contains_key("releaseId") {
                    let handle: ArtifactHandle =
                        serde_json::from_value(output_value(&input, "bundle")?.clone()).map_err(
                            |error| NodeFailure::definite("artifactIntegrity", error.to_string()),
                        )?;
                    let bundle = self
                        .artifacts
                        .inspect(&handle)
                        .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
                    if let Some(project_name) = bundle.manifest.annotations.get("projectName") {
                        let path = self
                            .artifacts
                            .verified_component_path(&handle, "compose.yaml")
                            .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
                        let document: Value =
                            serde_yaml::from_slice(&fs::read(path).map_err(|error| {
                                NodeFailure::definite("artifactIo", error.to_string())
                            })?)
                            .map_err(|error| {
                                NodeFailure::definite("composeConfig", error.to_string())
                            })?;
                        let mut ports = Vec::new();
                        for service in document["services"]
                            .as_object()
                            .into_iter()
                            .flat_map(|services| services.values())
                        {
                            for port in service["ports"].as_array().into_iter().flatten() {
                                let published = port["published"]
                                    .as_str()
                                    .and_then(|value| value.parse::<u16>().ok())
                                    .filter(|value| *value > 0)
                                    .ok_or_else(|| {
                                        NodeFailure::definite(
                                            "composeConfig",
                                            "invalid published port",
                                        )
                                    })?;
                                ports.push(published);
                            }
                        }
                        self.run_remote(
                            &input,
                            &config.target_id,
                            DockerComposeRemoteAction::CheckUnoccupiedCompose {
                                project_name: project_name.clone(),
                                ports,
                            },
                            context.cancellation.clone(),
                        )
                        .await
                        .map_err(|_| {
                            NodeFailure::definite(
                                "resourceConflict",
                                "Compose project or host port is occupied",
                            )
                        })?;
                    }
                }
                capabilities.insert("sftp".into(), "1".into());
                require_target_capabilities(&config.required_capabilities, &capabilities)?;
                let profile = self
                    .database
                    .get_profile(&target.connection_profile_id)
                    .map_err(|error| NodeFailure::definite("targetUnavailable", error))?
                    .ok_or_else(|| {
                        NodeFailure::definite("targetUnavailable", "target profile is missing")
                    })?;
                let host_identity_digest = canonical_sha256(&serde_json::json!({
                    "profileId": profile.id,
                    "host": profile.host,
                    "port": profile.port,
                    "username": profile.username,
                    "authMethod": profile.auth_method.as_str(),
                    "jumpHost": profile.jump_host_config,
                }))
                .map_err(|error| NodeFailure::definite("targetIdentity", error.to_string()))?;
                let identity = FrozenTargetIdentity {
                    target_id: target.id.clone(),
                    connection_profile_id: target.connection_profile_id,
                    profile_revision: profile.updated_at,
                    host_identity_digest,
                    remote_root: target.remote_root,
                    capabilities_digest: canonical_sha256(&capabilities)
                        .map_err(|error| NodeFailure::definite("capability", error.to_string()))?,
                };
                let current_release = match (
                    capabilities.get("releaseId"),
                    capabilities.get("artifactContentDigest"),
                    capabilities.get("layoutDigest"),
                ) {
                    (Some(release_id), Some(artifact_content_digest), Some(layout_digest)) => {
                        Some(FrozenReleaseIdentity {
                            release_id: release_id.clone(),
                            artifact_content_digest: artifact_content_digest.clone(),
                            layout_digest: layout_digest.clone(),
                        })
                    }
                    _ => None,
                };
                if config
                    .required_capabilities
                    .iter()
                    .any(|capability| capability == "atomicSymlink")
                {
                    match (&current_release, capabilities.get("currentLink")) {
                        (Some(release), Some(link))
                            if link == &format!("releases/{}", release.release_id) => {}
                        (None, None) => {}
                        _ => {
                            return Err(NodeFailure::definite(
                                "targetDrift",
                                "static current link and frozen release identity are inconsistent",
                            ))
                        }
                    }
                }
                Ok(NodeExecutionResult::output(
                    "target",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: serde_json::json!({
                            "identity": identity,
                            "display": {"host":profile.host,"port":profile.port,"username":profile.username},
                            "capabilities": capabilities,
                            "currentRelease": current_release,
                        }),
                        artifact_reference: None,
                    },
                ))
            }
            "release.create-candidate" => {
                let config: CandidateConfig =
                    serde_json::from_value(input.frozen.node.config.clone())
                        .map_err(|error| NodeFailure::definite("config", error.to_string()))?;
                if !matches!(config.strategy.as_str(), "dockerCompose" | "staticFiles") {
                    return Err(NodeFailure::definite(
                        "strategy",
                        "candidate strategy is not supported",
                    ));
                }
                let handle = input_handle(&input, "bundle")?;
                let bundle = self
                    .artifacts
                    .inspect(&handle)
                    .map_err(|error| NodeFailure::definite("artifactIntegrity", error))?;
                let expected_artifact_type = if config.strategy == "staticFiles" {
                    super::node_registry::ARTIFACT_TYPE_FILE_TREE
                } else {
                    super::node_registry::ARTIFACT_TYPE_COMPOSE_RELEASE
                };
                if bundle.manifest.artifact_type != expected_artifact_type {
                    return Err(NodeFailure::definite(
                        "artifactCompatibility",
                        "candidate strategy does not accept this artifact type",
                    ));
                }
                let target = output_value(&input, "target")?;
                let current = target.get("currentRelease").cloned().unwrap_or(Value::Null);
                let release_id = format!("release-{}", &handle.content_digest[7..23]);
                let layout_digest = canonical_sha256(&serde_json::json!({
                    "strategy": config.strategy,
                    "targetId": config.target_id,
                    "bundleAnnotations": bundle.manifest.annotations,
                }))
                .map_err(|error| NodeFailure::definite("candidate", error.to_string()))?;
                let target_release = FrozenReleaseIdentity {
                    release_id,
                    artifact_content_digest: handle.content_digest,
                    layout_digest,
                };
                Ok(NodeExecutionResult::output(
                    "candidate",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: serde_json::json!({
                            "targetId": config.target_id,
                            "targetRelease": target_release,
                            "currentRelease": current,
                            "previousRelease": current,
                        }),
                        artifact_reference: None,
                    },
                ))
            }
            "control.approval" => Err(NodeFailure::definite(
                "approval",
                "approval is owned by the coordinator",
            )),
            "transfer.sftp" => self.execute_transfer(input, context).await,
            "release.prepare-compose" => self.execute_prepare_compose(input, context).await,
            "release.prepare-files" => self.execute_prepare_files(input, context).await,
            "runtime.load-image" => self.execute_load_image(input, context).await,
            "deploy.compose" => self.execute_compose(input, context).await,
            "deploy.static-switch" => self.execute_static_switch(input, context).await,
            "verify.http" => self.execute_verify(input, context).await,
            "proxy.nginx-reload" => self.execute_nginx(input, context).await,
            "release.commit" => self.execute_commit(input, context).await,
            "finalize.notify" => {
                let outcome = input
                    .frozen
                    .inputs
                    .get("runOutcome")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                self.app
                    .as_ref()
                    .ok_or_else(|| {
                        NodeFailure::definite(
                            "notification",
                            "desktop notification host unavailable",
                        )
                    })?
                    .emit(
                        "deployment-finalizer",
                        serde_json::json!({
                            "runId": input.frozen.run_id,
                            "outcome": outcome,
                            "summaryKey": format!("deployment.notification.{outcome}"),
                        }),
                    )
                    .map_err(|error| NodeFailure::definite("notification", error.to_string()))?;
                Ok(NodeExecutionResult::output(
                    "notified",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: Value::Bool(true),
                        artifact_reference: None,
                    },
                ))
            }
            _ => Err(NodeFailure::definite(
                "unsupportedNode",
                format!("unsupported Docker Compose node {node_type}"),
            )),
        }
    }

    async fn reconcile(
        &self,
        node_type: &str,
        input: VerifiedNodeInput,
        _context: NodeExecutionContext,
    ) -> Result<NodeReconcileResult, NodeFailure> {
        let descriptor = DeploymentNodeRegistry::mvp()
            .find(&input.frozen.node.type_name, input.frozen.node.type_version)
            .cloned()
            .ok_or_else(|| NodeFailure::definite("descriptor", "node descriptor is missing"))?;
        if node_type == "deploy.static-switch" {
            let target_id = input
                .frozen
                .node
                .config
                .get("targetId")
                .and_then(Value::as_str)
                .ok_or_else(|| NodeFailure::definite("config", "targetId is missing"))?;
            match self.read_ledger(&input, target_id).await {
                Ok(Some(result)) => return Ok(NodeReconcileResult::Succeeded(Box::new(result))),
                Ok(None) => {}
                Err(error)
                    if error.disposition
                        == super::node_executor::NodeFailureDisposition::Ambiguous =>
                {
                    return Ok(NodeReconcileResult::StateUnknown(error.message))
                }
                Err(error) => return Err(error),
            }
            let plan = input
                .immutable_plan
                .as_ref()
                .ok_or_else(|| NodeFailure::definite("approval", "immutable plan is missing"))?;
            let observed = self.observe_current_link(&input, target_id).await;
            return match observed {
                Ok(Some(link))
                    if link == format!("releases/{}", plan.target_release.release_id) =>
                {
                    Ok(NodeReconcileResult::Succeeded(Box::new(
                        Self::static_activation_result(&input, target_id)?,
                    )))
                }
                Ok(observed)
                    if observed
                        == plan
                            .previous_release
                            .as_ref()
                            .map(|release| format!("releases/{}", release.release_id)) =>
                {
                    Ok(NodeReconcileResult::NotStarted)
                }
                Ok(_) => Ok(NodeReconcileResult::StateUnknown(
                    "current link does not match the approved target or previous release".into(),
                )),
                Err(error) => Ok(NodeReconcileResult::StateUnknown(error.message)),
            };
        }
        if descriptor.effect_class.requires_approval() {
            let target_id = input
                .frozen
                .node
                .config
                .get("targetId")
                .and_then(Value::as_str)
                .ok_or_else(|| NodeFailure::definite("config", "targetId is missing"))?;
            return match self.read_ledger(&input, target_id).await {
                Ok(Some(result)) => Ok(NodeReconcileResult::Succeeded(Box::new(result))),
                // A command can take effect before its SFTP receipt is written.
                // Missing evidence is not evidence that the command never ran.
                Ok(None) => Ok(NodeReconcileResult::StateUnknown(
                    "remote effect receipt is missing; execution cannot safely be repeated".into(),
                )),
                Err(error)
                    if error.disposition
                        == super::node_executor::NodeFailureDisposition::Ambiguous =>
                {
                    Ok(NodeReconcileResult::StateUnknown(error.message))
                }
                Err(error) => Err(error),
            };
        }
        if matches!(
            node_type,
            "source.snapshot"
                | "build.docker-buildx"
                | "build.package-script"
                | "artifact.collect"
                | "artifact.bundle-compose"
                | "target.preflight"
                | "release.create-candidate"
                | "verify.http"
                | "finalize.notify"
        ) {
            Ok(NodeReconcileResult::SafeToRetry)
        } else {
            Ok(NodeReconcileResult::StateUnknown(
                "executor has no safe read-only reconciliation".into(),
            ))
        }
    }

    async fn compensate(
        &self,
        node_type: &str,
        input: CompensationInput,
        context: NodeExecutionContext,
    ) -> Result<CompensationResult, NodeFailure> {
        if matches!(
            node_type,
            "transfer.sftp" | "release.prepare-compose" | "release.prepare-files"
        ) {
            let plan = input.verified.immutable_plan.as_ref().ok_or_else(|| {
                NodeFailure::definite("compensation", "immutable plan is missing")
            })?;
            let remote_directory = input
                .successful_result
                .outputs
                .values()
                .next()
                .and_then(|output| output.value.pointer("/payload/remoteDirectory"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    NodeFailure::definite("compensation", "frozen staging directory is missing")
                })?;
            self.run_remote(
                &input.verified,
                &plan.target.target_id,
                DockerComposeRemoteAction::MarkStagingForCleanup {
                    remote_directory: remote_directory.to_string(),
                    plan_digest: plan.plan_digest.clone(),
                },
                context.cancellation,
            )
            .await?;
            let payload = serde_json::json!({
                "stagingDirectoryDigest": canonical_sha256(&remote_directory)
                    .map_err(|error| NodeFailure::definite("compensation", error.to_string()))?,
                "compensatedNodeType": node_type,
            });
            let mut receipt = Self::effect_receipt(
                &input.verified,
                "staging.cleanup-marker",
                &plan.target.target_id,
                &payload,
            )?;
            receipt.operation_id = format!("compensate-{}", &input.verified.idempotency_key[22..]);
            return Ok(CompensationResult::Succeeded(receipt));
        }
        if node_type == "deploy.static-switch" {
            let plan = input.verified.immutable_plan.as_ref().ok_or_else(|| {
                NodeFailure::definite("compensation", "immutable plan is missing")
            })?;
            let previous = plan.previous_release.as_ref().ok_or_else(|| {
                NodeFailure::definite(
                    "compensation",
                    "no frozen previous static release is available",
                )
            })?;
            let verification_node = input.frozen_verification.as_ref().ok_or_else(|| {
                NodeFailure::definite("compensation", "frozen HTTP verification is missing")
            })?;
            if verification_node.type_name != "verify.http" || verification_node.type_version != 2 {
                return Ok(CompensationResult::StateUnknown(
                    "frozen verification node is not verify.http@2".into(),
                ));
            }
            let frozen_digest = canonical_sha256(&verification_node.config)
                .map_err(|error| NodeFailure::definite("compensation", error.to_string()))?;
            let planned_verification = plan
                .compiled
                .nodes
                .iter()
                .find(|node| node.node_id == verification_node.id);
            if planned_verification.map(|node| node.config_digest.as_str())
                != Some(frozen_digest.as_str())
            {
                return Ok(CompensationResult::StateUnknown(
                    "frozen verification config does not match the approved plan".into(),
                ));
            }
            let verification: VerifyHttpConfig =
                serde_json::from_value(verification_node.config.clone())
                    .map_err(|error| NodeFailure::definite("compensation", error.to_string()))?;
            if verification.target_id != plan.target.target_id {
                return Ok(CompensationResult::StateUnknown(
                    "frozen verification target does not match the approved target".into(),
                ));
            }
            let url = format!(
                "{}://127.0.0.1:{}{}",
                verification.scheme, verification.port, verification.path
            );
            self.run_remote(
                &input.verified,
                &plan.target.target_id,
                DockerComposeRemoteAction::RestoreStaticAndVerify {
                    remote_root: plan.target.remote_root.clone(),
                    previous_release_id: previous.release_id.clone(),
                    previous_artifact_content_digest: previous.artifact_content_digest.clone(),
                    previous_layout_digest: previous.layout_digest.clone(),
                    url: url.clone(),
                    expected_statuses: verification.expected_statuses,
                },
                context.cancellation,
            )
            .await?;
            let payload = serde_json::json!({
                "restoredRelease": previous,
                "verificationUrlDigest": canonical_sha256(&url)
                    .map_err(|error| NodeFailure::definite("compensation", error.to_string()))?,
                "verified": true,
            });
            let mut receipt = Self::effect_receipt(
                &input.verified,
                "static.restore-and-reverify",
                &plan.target.target_id,
                &payload,
            )?;
            receipt.operation_id = format!("compensate-{}", &input.verified.idempotency_key[22..]);
            return Ok(CompensationResult::Succeeded(receipt));
        }
        if !matches!(
            node_type,
            "deploy.compose" | "release.commit" | "proxy.nginx-reload"
        ) {
            return Ok(CompensationResult::NotRequired);
        }
        if input
            .successful_result
            .outputs
            .values()
            .any(|output| output.value.pointer("/payload/hostCompose") == Some(&Value::Bool(true)))
        {
            return Ok(CompensationResult::StateUnknown("existing Compose deployment requires reviewed restoration of its configuration archive; database restoration is never automatic".into()));
        }
        let plan =
            input.verified.immutable_plan.as_ref().ok_or_else(|| {
                NodeFailure::definite("compensation", "immutable plan is missing")
            })?;
        let Some(previous) = &plan.previous_release else {
            return Ok(CompensationResult::StateUnknown(
                "no frozen previous release is available".into(),
            ));
        };
        let root = &plan.target.remote_root;
        let previous_dir = format!("{root}/releases/{}", previous.release_id);
        let mut restore_checks = Vec::new();
        let action = match node_type {
            "deploy.compose" => {
                let release = self
                    .database
                    .get_deployment_release(&plan.workflow_id, &previous.release_id)
                    .map_err(|error| NodeFailure::definite("restoreEvidence", error))?
                    .filter(|release| release.identity.as_ref() == Some(previous))
                    .ok_or_else(|| {
                        NodeFailure::definite(
                            "restoreEvidence",
                            "previous release identity is unavailable",
                        )
                    })?;
                let handle = self
                    .database
                    .get_deployment_artifact_handle(&release.artifact_reference)
                    .map_err(|error| NodeFailure::definite("restoreEvidence", error))?
                    .ok_or_else(|| {
                        NodeFailure::definite("restoreEvidence", "previous bundle is unavailable")
                    })?;
                let bundle = self
                    .artifacts
                    .inspect(&handle)
                    .map_err(|error| NodeFailure::definite("restoreEvidence", error))?;
                let target_handle = plan
                    .artifacts
                    .iter()
                    .find(|artifact| {
                        artifact.content_digest == plan.target_release.artifact_content_digest
                    })
                    .ok_or_else(|| {
                        NodeFailure::definite("restoreEvidence", "target bundle is unavailable")
                    })?;
                let data_contract = |artifact: &ArtifactHandle| -> Result<Value, NodeFailure> {
                    let path = self
                        .artifacts
                        .verified_component_path(artifact, "compose.yaml")
                        .map_err(|error| NodeFailure::definite("restoreEvidence", error))?;
                    let document: Value =
                        serde_yaml::from_slice(&fs::read(path).map_err(|error| {
                            NodeFailure::definite("restoreEvidence", error.to_string())
                        })?)
                        .map_err(|error| {
                            NodeFailure::definite("restoreEvidence", error.to_string())
                        })?;
                    let services = document["services"].as_object().ok_or_else(|| {
                        NodeFailure::definite("restoreEvidence", "frozen services are missing")
                    })?;
                    Ok(Value::Object(services.iter().map(|(name, service)| (name.clone(),
                        serde_json::json!({"user":service["user"],"volumes":service["volumes"]}))).collect()))
                };
                if data_contract(&handle)? != data_contract(target_handle)? {
                    return Ok(CompensationResult::StateUnknown(
                        "automatic restore requires unchanged data mounts and container identity; manual verification is required".into()));
                }
                let source_run = self
                    .database
                    .get_deployment_run(release.source_run_id.as_deref().unwrap_or(""))
                    .map_err(|error| NodeFailure::definite("restoreEvidence", error))?
                    .ok_or_else(|| {
                        NodeFailure::definite(
                            "restoreEvidence",
                            "previous successful run is unavailable",
                        )
                    })?;
                let workflow = self
                    .database
                    .get_deployment_workflow_revision(
                        &source_run.workflow_id,
                        source_run.workflow_revision,
                    )
                    .map_err(|error| NodeFailure::definite("restoreEvidence", error))?
                    .ok_or_else(|| {
                        NodeFailure::definite(
                            "restoreEvidence",
                            "previous verification configuration is unavailable",
                        )
                    })?;
                for node in workflow
                    .definition
                    .nodes
                    .iter()
                    .filter(|node| node.type_name == "verify.http")
                {
                    let check: VerifyHttpConfig = serde_json::from_value(node.config.clone())
                        .map_err(|error| {
                            NodeFailure::definite("restoreEvidence", error.to_string())
                        })?;
                    if check.target_id != plan.target.target_id {
                        return Err(NodeFailure::definite(
                            "restoreEvidence",
                            "previous verification target differs",
                        ));
                    }
                    restore_checks.push(check);
                }
                if restore_checks.is_empty() {
                    return Err(NodeFailure::definite(
                        "restoreEvidence",
                        "previous HTTP verification is missing",
                    ));
                }
                DockerComposeRemoteAction::RestoreCompose {
                    release: previous_dir.clone(),
                    project_name: bundle
                        .manifest
                        .annotations
                        .get("projectName")
                        .cloned()
                        .ok_or_else(|| {
                            NodeFailure::definite(
                                "restoreEvidence",
                                "previous Compose project is missing",
                            )
                        })?,
                    components: bundle
                        .manifest
                        .components
                        .iter()
                        .map(|component| (component.name.clone(), component.digest.clone()))
                        .collect(),
                }
            }
            "release.commit" => {
                let metadata = format!(
                    "releaseId={}\nartifactContentDigest={}\nlayoutDigest={}\nplanDigest={}\n",
                    previous.release_id,
                    previous.artifact_content_digest,
                    previous.layout_digest,
                    plan.plan_digest,
                );
                DockerComposeRemoteAction::RestoreReleaseIdentity {
                    remote_root: root.to_string(),
                    release: previous_dir.clone(),
                    artifact_content_digest: previous.artifact_content_digest.clone(),
                    layout_digest: previous.layout_digest.clone(),
                    metadata,
                }
            }
            "proxy.nginx-reload" => {
                let verification = input
                    .successful_result
                    .outputs
                    .values()
                    .next()
                    .and_then(|output| output.value.pointer("/payload/verification/payload/url"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        NodeFailure::definite("compensation", "frozen verification URL is missing")
                    })?;
                DockerComposeRemoteAction::ReverifyHttp {
                    url: verification.to_string(),
                }
            }
            _ => unreachable!(),
        };
        self.run_remote(
            &input.verified,
            &plan.target.target_id,
            action,
            context.cancellation.clone(),
        )
        .await?;
        for check in &restore_checks {
            let mut verified = false;
            for _ in 0..10 {
                let result = self
                    .run_remote(
                        &input.verified,
                        &plan.target.target_id,
                        DockerComposeRemoteAction::VerifyHttp {
                            url: format!(
                                "{}://127.0.0.1:{}{}",
                                check.scheme, check.port, check.path
                            ),
                        },
                        context.cancellation.clone(),
                    )
                    .await;
                if result
                    .ok()
                    .and_then(|value| value.trim().parse::<u16>().ok())
                    .is_some_and(|status| check.expected_statuses.contains(&status))
                {
                    verified = true;
                    break;
                }
                tokio::select! {
                    _ = context.cancellation.cancelled() => return Err(NodeFailure::canceled()),
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                }
            }
            if !verified {
                return Ok(CompensationResult::StateUnknown(
                    "previous service failed restoration verification".into(),
                ));
            }
        }
        let payload = serde_json::json!({
            "restoredRelease": previous,
            "compensatedNodeType": node_type,
            "httpReverified": !restore_checks.is_empty(),
        });
        let mut receipt = Self::effect_receipt(
            &input.verified,
            match node_type {
                "deploy.compose" => "compose.restore",
                "release.commit" => "release-identity.restore",
                "proxy.nginx-reload" => "nginx.restore-reverify",
                _ => unreachable!(),
            },
            &plan.target.target_id,
            &payload,
        )?;
        receipt.operation_id = format!("compensate-{}", &input.verified.idempotency_key[22..]);
        Ok(CompensationResult::Succeeded(receipt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "builds a real local project using Docker; requires SHELLSPAN_PHASE1_PROJECT and SHELLSPAN_PHASE1_PROJECT_KIND"]
    fn real_project_frozen_image_acceptance() {
        let path = std::env::var("SHELLSPAN_PHASE1_PROJECT").expect("real project path required");
        let kind = std::env::var("SHELLSPAN_PHASE1_PROJECT_KIND").expect("project kind required");
        assert!(matches!(kind.as_str(), "for-you" | "shellspan"));
        let mut binding = super::super::source_binding::inspect(Path::new(&path))
            .unwrap()
            .binding;
        if let Ok(selection) = std::env::var("SHELLSPAN_PHASE1_INCLUDED_UNTRACKED") {
            binding.included_untracked = serde_json::from_str(&selection).unwrap();
        }
        binding.excluded_paths = vec![
            ".claude".into(),
            ".agents".into(),
            ".codex".into(),
            "data".into(),
            ".env.example".into(),
        ];
        let original = super::super::source_binding::capture(&binding).unwrap();
        let project = super::super::source_binding::materialize(original.directory.path()).unwrap();
        let command = if kind == "for-you" {
            "[\"pnpm\",\"start\"]"
        } else {
            "[\"pnpm\",\"exec\",\"vite\",\"preview\",\"--host\",\"0.0.0.0\",\"--port\",\"3000\"]"
        };
        fs::write(project.path().join("Dockerfile"), format!("FROM node:24-bookworm-slim\nWORKDIR /app\nRUN npm install -g pnpm@11.1.1\nCOPY . .\nRUN pnpm install --frozen-lockfile\nRUN pnpm build\nCMD {command}\n")).unwrap();
        fs::write(
            project.path().join(".dockerignore"),
            ".git\nnode_modules\ndist\n.next\ndata\nsrc-tauri/target\n",
        )
        .unwrap();
        fs::write(
            project.path().join("compose.yaml"),
            "services:\n  web:\n    build: .\n    image: obsolete:must-not-run\n",
        )
        .unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Acceptance",
                "-c",
                "user.email=acceptance@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Isolated real project acceptance input",
            ],
        ] {
            let status = safe_local_command("git")
                .args(args)
                .current_dir(project.path())
                .status()
                .unwrap();
            assert!(status.success());
        }
        let binding = super::super::source_binding::inspect(project.path())
            .unwrap()
            .binding;
        let frozen = super::super::source_binding::capture(&binding).unwrap();
        let original_package = fs::read(frozen.directory.path().join("package.json")).unwrap();
        // A broken live Dockerfile must have no influence on the frozen build.
        fs::write(
            project.path().join("Dockerfile"),
            "FROM invalid-live-edit:must-not-build\n",
        )
        .unwrap();
        fs::write(project.path().join("compose.yaml"), "invalid: live edit\n").unwrap();
        let cas_root = tempfile::tempdir().unwrap();
        let artifacts = DeploymentArtifactCas::new(cas_root.path().join("cas")).unwrap();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let projection = build_image_bundle(
            frozen.directory.path(),
            frozen.snapshot.clone(),
            DockerBuildxConfig {
                verification: None,
                context: ".".into(),
                dockerfile: "Dockerfile".into(),
                platform: "linux/arm64".into(),
                image_repository: format!("shellspan/phase1-{kind}"),
            },
            canonical_sha256(&kind).unwrap(),
            &artifacts,
            &cancellation,
            Duration::from_secs(1800),
        )
        .unwrap();
        assert_eq!(
            fs::read(frozen.directory.path().join("package.json")).unwrap(),
            original_package
        );
        let image = &projection.manifest.components[0];
        let reference = &image.annotations["imageReference"];
        let project_name = format!(
            "shellspan-p1-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        );
        let config = BundleComposeConfig {
            host_compose: None,
            compose_files: vec!["compose.yaml".into()],
            project_name: project_name.clone(),
            services: vec!["web".into()],
            registered_mounts: vec![],
            non_sensitive_files: vec![],
        };
        let release = super::super::compose_release::compile(
            frozen.directory.path(),
            &config,
            reference,
            &cancellation,
        )
        .unwrap();
        let archive = artifacts
            .verified_component_path(&projection.handle, "image.tar")
            .unwrap();
        fixed_command(
            "docker",
            &[
                "load".into(),
                "--input".into(),
                archive.to_string_lossy().into_owned(),
            ],
            release.path(),
            &cancellation,
            Duration::from_secs(120),
        )
        .unwrap();
        let observed = safe_local_command("docker")
            .args(["image", "inspect", "--format", "{{.Id}}", reference])
            .output()
            .unwrap();
        assert!(observed.status.success());
        let observed_id = String::from_utf8(observed.stdout)
            .unwrap()
            .trim()
            .to_owned();
        assert!(
            observed_id == image.annotations["imageId"]
                || image.annotations.get("imageManifestId") == Some(&observed_id)
        );
        let compose: Value =
            serde_yaml::from_slice(&fs::read(release.path().join("compose.yaml")).unwrap())
                .unwrap();
        assert_eq!(compose["services"]["web"]["image"], *reference);
        assert!(compose["services"]["web"].get("build").is_none());
        if let Ok(report) = std::env::var("SHELLSPAN_PHASE1_REPORT") {
            fs::write(
                report,
                serde_json::to_vec_pretty(&serde_json::json!({
                    "project": path,
                    "projectKind": kind,
                    "sourceRevision": original.snapshot.revision,
                    "sourceDigest": frozen.snapshot.snapshot_digest,
                    "imageReference": reference,
                    "imageConfigId": image.annotations["imageId"],
                    "imageManifestId": image.annotations.get("imageManifestId"),
                    "loadedImageId": observed_id,
                    "archiveDigest": image.digest,
                    "artifactReference": projection.handle.artifact_reference,
                    "workspaceMutationIgnored": true,
                    "loadedImageMatchesCompose": true,
                    "platform": "linux/arm64"
                }))
                .unwrap(),
            )
            .unwrap();
        }
    }

    fn run_fixture_command(session: &ssh2::Session, command: &str) -> (i32, String) {
        let mut channel = session.channel_session().unwrap();
        channel.exec(command).unwrap();
        let mut output = String::new();
        channel.read_to_string(&mut output).unwrap();
        channel.stderr().read_to_string(&mut output).unwrap();
        channel.wait_close().unwrap();
        (channel.exit_status().unwrap(), output)
    }

    fn static_fixture_nginx_config(root: &str) -> String {
        format!(
            "pid nginx.pid;\nerror_log {root}/nginx/error.log notice;\nevents {{}}\nhttp {{ access_log off; client_body_temp_path {root}/nginx/temp/client_body; proxy_temp_path {root}/nginx/temp/proxy; fastcgi_temp_path {root}/nginx/temp/fastcgi; uwsgi_temp_path {root}/nginx/temp/uwsgi; scgi_temp_path {root}/nginx/temp/scgi; server {{ listen 127.0.0.1:18081; location / {{ root {root}/current; }} }} }}\n"
        )
    }

    struct UnusedBackend;

    #[async_trait]
    impl DockerComposeExecutionBackend for UnusedBackend {
        async fn execute(
            &self,
            _node_type: &str,
            _input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeExecutionResult, NodeFailure> {
            Err(NodeFailure::definite("unused", "unused"))
        }

        async fn reconcile(
            &self,
            _node_type: &str,
            _input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeReconcileResult, NodeFailure> {
            Ok(NodeReconcileResult::NotStarted)
        }

        async fn compensate(
            &self,
            _node_type: &str,
            _input: CompensationInput,
            _context: NodeExecutionContext,
        ) -> Result<CompensationResult, NodeFailure> {
            Ok(CompensationResult::NotRequired)
        }
    }

    #[test]
    fn docker_compose_lifecycle_registers_exact_native_node_versions() {
        let registry = docker_compose_executor_registry(Arc::new(UnusedBackend)).unwrap();
        for (node_type, version) in DOCKER_COMPOSE_NODE_TYPES {
            let executor = registry.get(node_type, *version).unwrap();
            assert_eq!(executor.node_type(), (*node_type, *version));
            assert_eq!(executor.executor_version(), DOCKER_COMPOSE_EXECUTOR_VERSION);
        }
        assert!(registry.get("build.docker-buildx", 1).is_err());
    }

    #[test]
    fn remote_runner_accepts_only_closed_actions_and_quotes_all_runtime_values() {
        let (request, preview) = DockerComposeRemoteAction::ComposeDeploy {
            compose_files: vec!["/srv/app/release/compose file.yml".into()],
            project_name: "example".into(),
            services: vec!["web".into()],
            pull_policy: "never".into(),
            image_reference: "example/web:release-1".into(),
            container_user: String::new(),
            mounts: vec![],
        }
        .fixed_request();
        assert!(request.starts_with("sh -c '"));
        assert!(request.contains("'\\''/srv/app/release/compose file.yml'\\''"));
        assert!(request.contains("grep -F -x"));
        assert!(request.contains("--no-build --pull"));
        assert_eq!(preview, "ShellSpan fixed Docker Compose deploy");
        assert!(!request.contains("${"));
    }

    #[test]
    fn preflight_wire_is_allowlisted_bounded_and_rejects_remote_text_injection() {
        let valid = parse_preflight_output(
            "ssh=1\ndocker=1\ncompose=1\nhttp=1\nnginx=0\natomicSymlink=1\n",
        )
        .unwrap();
        assert_eq!(valid.get("compose").map(String::as_str), Some("1"));
        assert!(parse_preflight_output(
            "ssh=1\ndocker=1\ncompose=1\nhttp=1\nnginx=0\natomicSymlink=1\nmessage=owned\n"
        )
        .is_err());
        assert!(parse_preflight_output(
            "ssh=1\ndocker=1\ncompose=1\nhttp=1\nnginx=0\natomicSymlink=1\nreleaseId=release-1\nartifactContentDigest=bad\n"
        )
        .is_err());
        assert!(parse_preflight_output(
            "ssh=1\ndocker=1\ncompose=1\nhttp=1\nnginx=0\natomicSymlink=1\ncurrentLink=/srv/release\n"
        )
        .is_err());
        let unavailable = parse_preflight_output(
            "ssh=1\ndocker=0\ncompose=0\nhttp=1\nnginx=0\natomicSymlink=0\n",
        )
        .unwrap();
        let error =
            require_target_capabilities(&["atomicSymlink".into()], &unavailable).unwrap_err();
        assert_eq!(error.category, "capability");
    }

    #[test]
    fn static_acceptance_http_fixture_uses_the_installed_nginx_runtime() {
        let dockerfile = include_str!("../../../tests/deployment-e2e/Dockerfile");
        assert!(dockerfile.lines().any(|line| line.trim() == "nginx \\"));
        let config = static_fixture_nginx_config("/srv/shellspan-deployment/static");
        assert!(config.contains("listen 127.0.0.1:18081"));
        assert!(config.contains("root /srv/shellspan-deployment/static/current"));
        assert!(
            config.contains("error_log /srv/shellspan-deployment/static/nginx/error.log notice")
        );
        assert!(config.contains(
            "client_body_temp_path /srv/shellspan-deployment/static/nginx/temp/client_body"
        ));
        assert!(!config.contains("busybox"));
    }

    #[test]
    #[ignore = "requires isolated SSH fixture and a real application image already loaded"]
    fn isolated_container_user_permission_denial() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_hosts, known_hosts) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session =
            crate::execution::open_ssh_execution_session(&connection, &known_hosts).unwrap();
        let image = std::env::var("SHELLSPAN_PERMISSION_IMAGE")
            .expect("real loaded application image required");
        let root = format!(
            "/srv/shellspan-deployment/permissions-{}",
            uuid::Uuid::new_v4()
        );
        let data = format!("{root}/data");
        assert_eq!(
            run_fixture_command(
                &session.target,
                &format!(
                    "mkdir -p {}; chmod 555 {}",
                    posix_quote(&data),
                    posix_quote(&data)
                )
            )
            .0,
            0
        );
        let compose = format!("{root}/compose.yaml");
        let document = serde_yaml::to_string(&serde_json::json!({"services":{"web":{
            "image":image,"user":"1000:1000","volumes":[{"type":"bind","source":data,"target":"/app/data","bind":{"create_host_path":false}}]
        }}})).unwrap();
        session
            .target
            .sftp()
            .unwrap()
            .create(Path::new(&compose))
            .unwrap()
            .write_all(document.as_bytes())
            .unwrap();
        let project = format!("permissions-{}", uuid::Uuid::new_v4());
        let action = DockerComposeRemoteAction::ComposeDeploy {
            compose_files: vec![compose.clone()],
            project_name: project.clone(),
            services: vec!["web".into()],
            pull_policy: "never".into(),
            image_reference: image,
            container_user: "1000:1000".into(),
            mounts: vec![RegisteredBindMount {
                source: data.clone(),
                target: "/app/data".into(),
                read_only: false,
            }],
        };
        let result = run_fixture_command(&session.target, &action.fixed_request().0);
        assert_ne!(
            result.0, 0,
            "read-only host directory must reject writable container access"
        );
        let query = format!(
            "docker ps -aq --filter {}",
            posix_quote(&format!("label=com.docker.compose.project={project}"))
        );
        assert!(
            run_fixture_command(&session.target, &query)
                .1
                .trim()
                .is_empty(),
            "failed probe must not start the service"
        );
        assert_eq!(
            run_fixture_command(
                &session.target,
                &format!("chmod 770 {}", posix_quote(&data))
            )
            .0,
            0
        );
        let result = run_fixture_command(&session.target, &action.fixed_request().0);
        assert_eq!(
            result.0, 0,
            "matching UID:GID must be able to start the real application: {}",
            result.1
        );
        assert!(run_fixture_command(
            &session.target,
            &format!("find {} -name '.shellspan-access.*'", posix_quote(&data))
        )
        .1
        .trim()
        .is_empty());
        assert_eq!(
            run_fixture_command(
                &session.target,
                &format!(
                    "docker compose -f {} -p {} down",
                    posix_quote(&compose),
                    posix_quote(&project)
                )
            )
            .0,
            0
        );
    }

    #[test]
    #[ignore = "requires the isolated tests/deployment-e2e DinD SSH fixture"]
    fn isolated_deployment_docker_compose_acceptance() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_known_hosts_directory, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
            .expect("connect to isolated Docker Compose fixture");
        let sftp = session.target.sftp().unwrap();
        let fixture_root = std::env::var("SHELLSPAN_DEPLOYMENT_E2E_ROOT")
            .expect("SHELLSPAN_DEPLOYMENT_E2E_ROOT is required");
        let archive = PathBuf::from(
            std::env::var("SHELLSPAN_DEPLOYMENT_E2E_IMAGE_ARCHIVE")
                .expect("SHELLSPAN_DEPLOYMENT_E2E_IMAGE_ARCHIVE is required"),
        );
        let image_reference = "shellspan/deployment-e2e:fixture-healthy";
        let identity =
            super::super::docker_archive::docker_archive_image_identity(&archive, image_reference)
                .unwrap();
        let release = format!("{fixture_root}/compose/release-e2e");
        ensure_remote_directories(&sftp, &release).unwrap();
        let remote_archive = format!("{release}/image.tar");
        let mut source = File::open(&archive).unwrap();
        let mut destination = sftp
            .open_mode(
                Path::new(&remote_archive),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                0o600,
                OpenType::File,
            )
            .unwrap();
        std::io::copy(&mut source, &mut destination).unwrap();
        destination.flush().unwrap();
        drop(destination);
        let compose_path = format!("{release}/compose.yaml");
        write_remote_file(
            &sftp,
            &compose_path,
            format!(
                "services:\n  web:\n    image: {image_reference}\n    ports:\n      - \"18082:8080\"\n"
            )
            .as_bytes(),
            false,
        )
        .unwrap();
        let load = DockerComposeRemoteAction::LoadImage {
            archive: remote_archive.clone(),
            image_reference: image_reference.into(),
            image_id: identity.config_id,
            image_manifest_id: identity.manifest_id,
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &load).0, 0);
        let prepare = DockerComposeRemoteAction::PrepareCompose {
            remote_directory: release.clone(),
            component_names: vec!["compose.yaml".into(), "image.tar".into()],
            prepared_identity: format!("sha256:{}", "a".repeat(64)),
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &prepare).0, 0);
        let deploy = DockerComposeRemoteAction::ComposeDeploy {
            compose_files: vec![compose_path.clone()],
            project_name: "shellspan-e2e".into(),
            services: vec!["web".into()],
            pull_policy: "never".into(),
            image_reference: image_reference.into(),
            container_user: String::new(),
            mounts: vec![],
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &deploy).0, 0);
        assert_eq!(run_fixture_command(&session.target, &deploy).0, 0);
        let verify = DockerComposeRemoteAction::VerifyHttp {
            url: "http://127.0.0.1:18082/healthz".into(),
        }
        .fixed_request()
        .0;
        let (status, output) = run_fixture_command(&session.target, &verify);
        assert_eq!(status, 0, "{output}");
        assert_eq!(output, "200");
        let cleanup = format!(
            "docker compose -f {} --project-name shellspan-e2e down --remove-orphans",
            posix_quote(&compose_path),
        );
        assert_eq!(run_fixture_command(&session.target, &cleanup).0, 0);
    }

    #[test]
    #[ignore = "requires the isolated tests/deployment-e2e DinD SSH fixture"]
    fn isolated_deployment_static_release_acceptance() {
        let connection = crate::execution::fixture::isolated_ssh_connection();
        let (_known_hosts_directory, known_hosts_path) =
            crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
        let session = crate::execution::open_ssh_execution_session(&connection, &known_hosts_path)
            .expect("connect to isolated static deployment fixture");
        let sftp = session.target.sftp().unwrap();
        let fixture_root = std::env::var("SHELLSPAN_DEPLOYMENT_E2E_ROOT")
            .expect("SHELLSPAN_DEPLOYMENT_E2E_ROOT is required");
        let root = format!("{fixture_root}/static");
        ensure_remote_directories(&sftp, &format!("{root}/releases/release-one")).unwrap();
        let first_digest = format!("sha256:{}", "1".repeat(64));
        write_remote_file(
            &sftp,
            &format!("{root}/releases/release-one/.prepared"),
            format!("{first_digest}\nsha256:{}\nrelease-one\n", "a".repeat(64)).as_bytes(),
            false,
        )
        .unwrap();
        write_remote_file(
            &sftp,
            &format!("{root}/releases/release-one/index.html"),
            b"one",
            false,
        )
        .unwrap();
        let (preflight, _) = DockerComposeRemoteAction::Preflight {
            remote_root: root.clone(),
            require_atomic_symlink: true,
        }
        .fixed_request();
        let (status, output) = run_fixture_command(&session.target, &preflight);
        assert_eq!(status, 0, "{output}");
        assert_eq!(
            parse_preflight_output(&output)
                .unwrap()
                .get("atomicSymlink")
                .map(String::as_str),
            Some("1")
        );
        let first = DockerComposeRemoteAction::StaticSwitch {
            remote_root: root.clone(),
            release_id: "release-one".into(),
            artifact_content_digest: first_digest,
            layout_digest: format!("sha256:{}", "a".repeat(64)),
            previous_release_id: None,
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &first).0, 0);
        assert_eq!(run_fixture_command(&session.target, &first).0, 0);
        assert_eq!(
            sftp.readlink(Path::new(&format!("{root}/current")))
                .unwrap()
                .to_str(),
            Some("releases/release-one")
        );

        ensure_remote_directories(&sftp, &format!("{root}/releases/release-two")).unwrap();
        let second_digest = format!("sha256:{}", "2".repeat(64));
        write_remote_file(
            &sftp,
            &format!("{root}/releases/release-two/.prepared"),
            format!("{second_digest}\nsha256:{}\nrelease-two\n", "b".repeat(64)).as_bytes(),
            false,
        )
        .unwrap();
        write_remote_file(
            &sftp,
            &format!("{root}/releases/release-two/index.html"),
            b"two",
            false,
        )
        .unwrap();
        let drifted = DockerComposeRemoteAction::StaticSwitch {
            remote_root: root.clone(),
            release_id: "release-two".into(),
            artifact_content_digest: second_digest.clone(),
            layout_digest: format!("sha256:{}", "b".repeat(64)),
            previous_release_id: Some("release-other".into()),
        }
        .fixed_request()
        .0;
        assert_ne!(run_fixture_command(&session.target, &drifted).0, 0);
        assert_eq!(
            sftp.readlink(Path::new(&format!("{root}/current")))
                .unwrap()
                .to_str(),
            Some("releases/release-one")
        );
        let second = DockerComposeRemoteAction::StaticSwitch {
            remote_root: root.clone(),
            release_id: "release-two".into(),
            artifact_content_digest: second_digest,
            layout_digest: format!("sha256:{}", "b".repeat(64)),
            previous_release_id: Some("release-one".into()),
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &second).0, 0);
        ensure_remote_directories(&sftp, &format!("{root}/nginx/logs")).unwrap();
        ensure_remote_directories(&sftp, &format!("{root}/nginx/temp")).unwrap();
        let nginx_config = format!("{root}/nginx.conf");
        let nginx_prefix = format!("{root}/nginx/");
        write_remote_file(
            &sftp,
            &nginx_config,
            static_fixture_nginx_config(&root).as_bytes(),
            false,
        )
        .unwrap();
        let nginx_base = format!(
            "nginx -p {} -c {}",
            posix_quote(&nginx_prefix),
            posix_quote(&nginx_config)
        );
        let (test_status, test_output) =
            run_fixture_command(&session.target, &format!("{nginx_base} -t"));
        assert_eq!(test_status, 0, "{test_output}");
        let nginx_start = format!("{nginx_base} >/dev/null 2>&1");
        let (nginx_status, nginx_output) = run_fixture_command(&session.target, &nginx_start);
        assert_eq!(nginx_status, 0, "{nginx_output}");
        let restore = DockerComposeRemoteAction::RestoreStaticAndVerify {
            remote_root: root.clone(),
            previous_release_id: "release-one".into(),
            previous_artifact_content_digest: format!("sha256:{}", "1".repeat(64)),
            previous_layout_digest: format!("sha256:{}", "a".repeat(64)),
            url: "http://127.0.0.1:18081/index.html".into(),
            expected_statuses: vec![200],
        }
        .fixed_request()
        .0;
        assert_eq!(run_fixture_command(&session.target, &restore).0, 0);
        assert_eq!(
            sftp.readlink(Path::new(&format!("{root}/current")))
                .unwrap()
                .to_str(),
            Some("releases/release-one")
        );
        let (status, body) = run_fixture_command(
            &session.target,
            "curl --silent --show-error http://127.0.0.1:18081/index.html",
        );
        assert_eq!(status, 0);
        assert_eq!(body, "one");
        let nginx_stop = format!(
            "nginx -p {} -c {} -s quit",
            posix_quote(&nginx_prefix),
            posix_quote(&nginx_config)
        );
        let (stop_status, stop_output) = run_fixture_command(&session.target, &nginx_stop);
        assert_eq!(stop_status, 0, "{stop_output}");
    }
}
