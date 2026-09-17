use super::port_types::DeploymentPortType;
use super::validation_error::{WorkflowValidationCode, WorkflowValidationError};
use super::workflow_schema::{
    EffectClass, ExecutionDomain, RiskLevel, MAX_CONFIG_JSON_BYTES, MAX_IDENTIFIER_BYTES,
    MAX_JSON_DEPTH,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const ARTIFACT_TYPE_FILE_TREE: &str = "application/vnd.shellspan.file-tree";
pub(crate) const ARTIFACT_TYPE_DOCKER_IMAGE: &str = "application/vnd.shellspan.oci-image";
pub(crate) const ARTIFACT_TYPE_COMPOSE_RELEASE: &str = "application/vnd.shellspan.compose-release";
pub(crate) const ARTIFACT_TYPE_BINARY: &str = "application/vnd.shellspan.binary";
pub(crate) const ARTIFACT_TYPE_ZIP: &str = "application/vnd.shellspan.zip";

const ANY_ARTIFACT_TYPES: &[&str] = &[
    ARTIFACT_TYPE_FILE_TREE,
    ARTIFACT_TYPE_DOCKER_IMAGE,
    ARTIFACT_TYPE_COMPOSE_RELEASE,
    ARTIFACT_TYPE_BINARY,
    ARTIFACT_TYPE_ZIP,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeCategory {
    Source,
    Build,
    Artifact,
    Target,
    Release,
    Control,
    Transfer,
    Runtime,
    Deploy,
    Verify,
    Proxy,
    Finalize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Capability {
    SourceSnapshot,
    PackageManager,
    DockerBuildx,
    Ssh,
    Sftp,
    AtomicSymlink,
    DockerRuntime,
    DockerCompose,
    HttpProbe,
    Nginx,
    Notification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortSpec {
    pub name: String,
    pub port_type: DeploymentPortType,
    pub required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub artifact_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompensationSpec {
    pub kind: String,
    pub fixed_actions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConfigFieldKind {
    String,
    Integer,
    Boolean,
    Select,
    StringList,
    IntegerList,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigOption {
    pub value: String,
    pub label_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigFieldSpec {
    pub name: String,
    pub label_key: String,
    pub description_key: String,
    pub kind: ConfigFieldKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ConfigOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigSchema {
    pub schema_version: u32,
    pub fields: Vec<ConfigFieldSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNodeTypeSpec {
    pub type_name: String,
    pub type_version: u32,
    pub display_name_key: String,
    pub description_key: String,
    pub category: NodeCategory,
    pub inputs: Vec<PortSpec>,
    pub outputs: Vec<PortSpec>,
    pub execution_domain: ExecutionDomain,
    pub effect_class: EffectClass,
    pub capabilities: Vec<Capability>,
    pub config_schema_version: u32,
    pub config_schema: ConfigSchema,
    pub default_config: Value,
    pub risk_level: RiskLevel,
    pub fixed_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compensation: Option<CompensationSpec>,
    pub retryable: bool,
    #[serde(skip)]
    config_kind: ConfigKind,
    #[serde(skip)]
    pub is_artifact_producer: bool,
    #[serde(skip)]
    pub is_deployment: bool,
    #[serde(skip)]
    pub is_verification: bool,
    #[serde(skip)]
    pub is_finalizer: bool,
}

impl DeploymentNodeTypeSpec {
    pub(crate) fn qualified_name(&self) -> String {
        format!("{}@{}", self.type_name, self.type_version)
    }

    pub(crate) fn input(&self, name: &str) -> Option<&PortSpec> {
        self.inputs.iter().find(|port| port.name == name)
    }

    pub(crate) fn output(&self, name: &str) -> Option<&PortSpec> {
        self.outputs.iter().find(|port| port.name == name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentNodeTypeCatalog {
    pub schema_version: u32,
    pub nodes: Vec<DeploymentNodeTypeSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigKind {
    SourceSnapshot,
    PackageScript,
    DockerBuildx,
    ArtifactCollect,
    BundleCompose,
    TargetPreflight,
    ReleaseCandidate,
    Approval,
    TransferSftp,
    PrepareCompose,
    PrepareFiles,
    LoadImage,
    DeployCompose,
    StaticSwitch,
    VerifyHttp,
    NginxReload,
    ReleaseCommit,
    FinalizeNotify,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedNodeConfig {
    pub target_id: Option<String>,
    pub artifact_outputs: BTreeMap<String, BTreeSet<String>>,
    pub required_target_capabilities: BTreeSet<Capability>,
}

#[derive(Debug, Clone)]
pub(crate) struct DeploymentNodeRegistry {
    nodes: Vec<DeploymentNodeTypeSpec>,
}

fn input(
    name: &str,
    port_type: DeploymentPortType,
    required: bool,
    artifact_types: &[&str],
) -> PortSpec {
    PortSpec {
        name: name.into(),
        port_type,
        required,
        artifact_types: artifact_types
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
    }
}

fn output(name: &str, port_type: DeploymentPortType, artifact_types: &[&str]) -> PortSpec {
    input(name, port_type, false, artifact_types)
}

struct SpecInput<'a> {
    type_name: &'a str,
    type_version: u32,
    category: NodeCategory,
    inputs: Vec<PortSpec>,
    outputs: Vec<PortSpec>,
    execution_domain: ExecutionDomain,
    effect_class: EffectClass,
    capabilities: Vec<Capability>,
    risk_level: RiskLevel,
    fixed_actions: &'a [&'a str],
    compensation: Option<(&'a str, &'a [&'a str])>,
    retryable: bool,
    config_kind: ConfigKind,
    is_artifact_producer: bool,
    is_deployment: bool,
    is_verification: bool,
    is_finalizer: bool,
}

fn spec(input: SpecInput<'_>) -> DeploymentNodeTypeSpec {
    let key = input.type_name.replace('.', "_").replace('-', "_");
    DeploymentNodeTypeSpec {
        type_name: input.type_name.into(),
        type_version: input.type_version,
        display_name_key: format!("deployment.node.{key}.name"),
        description_key: format!("deployment.node.{key}.description"),
        category: input.category,
        inputs: input.inputs,
        outputs: input.outputs,
        execution_domain: input.execution_domain,
        effect_class: input.effect_class,
        capabilities: input.capabilities,
        config_schema_version: 1,
        config_schema: config_schema(input.config_kind),
        default_config: default_config(input.config_kind),
        risk_level: input.risk_level,
        fixed_actions: input
            .fixed_actions
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        compensation: input.compensation.map(|(kind, actions)| CompensationSpec {
            kind: kind.into(),
            fixed_actions: actions.iter().map(|value| (*value).to_string()).collect(),
        }),
        retryable: input.retryable,
        config_kind: input.config_kind,
        is_artifact_producer: input.is_artifact_producer,
        is_deployment: input.is_deployment,
        is_verification: input.is_verification,
        is_finalizer: input.is_finalizer,
    }
}

fn field(name: &str, kind: ConfigFieldKind, required: bool) -> ConfigFieldSpec {
    ConfigFieldSpec {
        name: name.into(),
        label_key: format!("deployment.editor.config.{name}.label"),
        description_key: format!("deployment.editor.config.{name}.description"),
        kind,
        required,
        options: Vec::new(),
        minimum: None,
        maximum: None,
    }
}

fn select_field(name: &str, values: &[&str]) -> ConfigFieldSpec {
    let mut field = field(name, ConfigFieldKind::Select, true);
    field.options = values
        .iter()
        .map(|value| ConfigOption {
            value: (*value).into(),
            label_key: format!("deployment.editor.option.{name}.{value}"),
        })
        .collect();
    field
}

fn integer_field(name: &str, minimum: i64, maximum: i64) -> ConfigFieldSpec {
    let mut field = field(name, ConfigFieldKind::Integer, true);
    field.minimum = Some(minimum);
    field.maximum = Some(maximum);
    field
}

fn config_schema(kind: ConfigKind) -> ConfigSchema {
    use ConfigFieldKind::{IntegerList, String, StringList};
    let fields = match kind {
        ConfigKind::SourceSnapshot => vec![field("sourceRef", String, true)],
        ConfigKind::PackageScript => vec![
            select_field("packageManager", &["pnpm", "npm", "yarn", "bun"]),
            field("workingDirectory", String, true),
            select_field("installMode", &["frozen", "skip"]),
            field("scriptName", String, true),
            field("outputDirectory", String, true),
            field("environmentRefs", StringList, false),
        ],
        ConfigKind::DockerBuildx => vec![
            field("context", String, true),
            field("dockerfile", String, true),
            select_field("platform", &["linux/amd64", "linux/arm64"]),
            field("imageRepository", String, true),
        ],
        ConfigKind::ArtifactCollect => vec![
            select_field("kind", &["fileTree", "binary", "zip"]),
            field("paths", StringList, true),
        ],
        ConfigKind::BundleCompose => vec![
            field("composeFiles", StringList, true),
            field("projectName", String, true),
            field("services", StringList, false),
        ],
        ConfigKind::TargetPreflight => vec![
            field("targetId", String, true),
            field("requiredCapabilities", StringList, false),
        ],
        ConfigKind::ReleaseCandidate => vec![
            field("targetId", String, true),
            select_field("strategy", &["staticFiles", "dockerCompose"]),
        ],
        ConfigKind::Approval
        | ConfigKind::TransferSftp
        | ConfigKind::PrepareCompose
        | ConfigKind::PrepareFiles
        | ConfigKind::LoadImage
        | ConfigKind::NginxReload
        | ConfigKind::ReleaseCommit => vec![field("targetId", String, true)],
        ConfigKind::DeployCompose => vec![
            field("targetId", String, true),
            field("projectName", String, true),
            field("services", StringList, false),
            select_field("pullPolicy", &["never", "missing"]),
        ],
        ConfigKind::StaticSwitch => vec![
            field("targetId", String, true),
            select_field("linkName", &["current"]),
        ],
        ConfigKind::VerifyHttp => vec![
            field("targetId", String, true),
            select_field("scheme", &["http", "https"]),
            integer_field("port", 1, 65_535),
            field("path", String, true),
            field("expectedStatuses", IntegerList, true),
        ],
        ConfigKind::FinalizeNotify => vec![
            select_field("channel", &["system"]),
            field("events", StringList, true),
        ],
    };
    ConfigSchema {
        schema_version: 1,
        fields,
    }
}

fn default_config(kind: ConfigKind) -> Value {
    match kind {
        ConfigKind::SourceSnapshot => serde_json::json!({"sourceRef": "workspace"}),
        ConfigKind::PackageScript => serde_json::json!({
            "packageManager": "pnpm", "workingDirectory": ".", "installMode": "frozen",
            "scriptName": "build", "outputDirectory": "dist", "environmentRefs": []
        }),
        ConfigKind::DockerBuildx => serde_json::json!({
            "context": ".", "dockerfile": "Dockerfile", "platform": "linux/amd64",
            "imageRepository": "example/app"
        }),
        ConfigKind::ArtifactCollect => serde_json::json!({"kind": "fileTree", "paths": ["dist"]}),
        ConfigKind::BundleCompose => serde_json::json!({
            "composeFiles": ["compose.yml"], "projectName": "app", "services": []
        }),
        ConfigKind::TargetPreflight => serde_json::json!({
            "targetId": "production", "requiredCapabilities": ["sftp", "http"]
        }),
        ConfigKind::ReleaseCandidate => {
            serde_json::json!({"targetId": "production", "strategy": "staticFiles"})
        }
        ConfigKind::Approval
        | ConfigKind::TransferSftp
        | ConfigKind::PrepareCompose
        | ConfigKind::PrepareFiles
        | ConfigKind::LoadImage
        | ConfigKind::NginxReload
        | ConfigKind::ReleaseCommit => serde_json::json!({"targetId": "production"}),
        ConfigKind::DeployCompose => serde_json::json!({
            "targetId": "production", "projectName": "app", "services": [],
            "pullPolicy": "never"
        }),
        ConfigKind::StaticSwitch => {
            serde_json::json!({"targetId": "production", "linkName": "current"})
        }
        ConfigKind::VerifyHttp => serde_json::json!({
            "targetId": "production", "scheme": "https", "port": 443,
            "path": "/healthz", "expectedStatuses": [200]
        }),
        ConfigKind::FinalizeNotify => serde_json::json!({
            "channel": "system", "events": ["succeeded", "failed", "canceled", "stateUnknown"]
        }),
    }
}

impl DeploymentNodeRegistry {
    pub(crate) fn mvp() -> Self {
        use DeploymentPortType::*;
        use EffectClass::*;
        use ExecutionDomain::*;
        use NodeCategory::*;
        use RiskLevel::*;

        let nodes = vec![
            spec(SpecInput {
                type_name: "source.snapshot",
                type_version: 1,
                category: Source,
                inputs: vec![],
                outputs: vec![output("source", SourceSnapshot, &[])],
                execution_domain: Local,
                effect_class: LocalRead,
                capabilities: vec![Capability::SourceSnapshot],
                risk_level: Low,
                fixed_actions: &["freeze_source_snapshot"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::SourceSnapshot,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "build.package-script",
                type_version: 1,
                category: Build,
                inputs: vec![input("source", SourceSnapshot, true, &[])],
                outputs: vec![output("bundle", ArtifactBundle, &[ARTIFACT_TYPE_FILE_TREE])],
                execution_domain: Local,
                effect_class: LocalBuild,
                capabilities: vec![Capability::PackageManager],
                risk_level: Medium,
                fixed_actions: &[
                    "materialize_isolated_workspace",
                    "run_fixed_package_manager_script",
                    "collect_deterministic_file_tree",
                ],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::PackageScript,
                is_artifact_producer: true,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "build.docker-buildx",
                type_version: 2,
                category: Build,
                inputs: vec![input("source", SourceSnapshot, true, &[])],
                outputs: vec![output(
                    "bundle",
                    ArtifactBundle,
                    &[ARTIFACT_TYPE_DOCKER_IMAGE],
                )],
                execution_domain: Local,
                effect_class: LocalBuild,
                capabilities: vec![Capability::DockerBuildx],
                risk_level: Medium,
                fixed_actions: &[
                    "docker_buildx_build",
                    "inspect_image",
                    "export_image_archive",
                ],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::DockerBuildx,
                is_artifact_producer: true,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "artifact.collect",
                type_version: 1,
                category: Artifact,
                inputs: vec![input("source", SourceSnapshot, true, &[])],
                outputs: vec![output(
                    "bundle",
                    ArtifactBundle,
                    &[
                        ARTIFACT_TYPE_FILE_TREE,
                        ARTIFACT_TYPE_BINARY,
                        ARTIFACT_TYPE_ZIP,
                    ],
                )],
                execution_domain: Local,
                effect_class: LocalRead,
                capabilities: vec![Capability::SourceSnapshot],
                risk_level: Low,
                fixed_actions: &["collect_declared_source_paths", "write_artifact_manifest"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::ArtifactCollect,
                is_artifact_producer: true,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "artifact.bundle-compose",
                type_version: 1,
                category: Artifact,
                inputs: vec![
                    input(
                        "imageBundle",
                        ArtifactBundle,
                        true,
                        &[ARTIFACT_TYPE_DOCKER_IMAGE],
                    ),
                    input("source", SourceSnapshot, true, &[]),
                ],
                outputs: vec![output(
                    "bundle",
                    ArtifactBundle,
                    &[ARTIFACT_TYPE_COMPOSE_RELEASE],
                )],
                execution_domain: Local,
                effect_class: Pure,
                capabilities: vec![],
                risk_level: Low,
                fixed_actions: &["bind_compose_config_to_image_bundle"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::BundleCompose,
                is_artifact_producer: true,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "target.preflight",
                type_version: 2,
                category: NodeCategory::Target,
                inputs: vec![input("bundle", ArtifactBundle, true, ANY_ARTIFACT_TYPES)],
                outputs: vec![output("target", TargetSnapshot, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteRead,
                capabilities: vec![Capability::Ssh],
                risk_level: Low,
                fixed_actions: &["inspect_target_capabilities", "inspect_release_state"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::TargetPreflight,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "release.create-candidate",
                type_version: 1,
                category: Release,
                inputs: vec![
                    input("bundle", ArtifactBundle, true, ANY_ARTIFACT_TYPES),
                    input("target", TargetSnapshot, true, &[]),
                ],
                outputs: vec![output("candidate", ReleaseCandidate, &[])],
                execution_domain: Local,
                effect_class: Pure,
                capabilities: vec![],
                risk_level: Low,
                fixed_actions: &["bind_bundle_target_and_release_strategy"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::ReleaseCandidate,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "control.approval",
                type_version: 1,
                category: NodeCategory::Control,
                inputs: vec![
                    input("candidate", ReleaseCandidate, true, &[]),
                    input("target", TargetSnapshot, true, &[]),
                ],
                outputs: vec![output("approval", ControlApproval, &[])],
                execution_domain: NativeUi,
                effect_class: EffectClass::Control,
                capabilities: vec![],
                risk_level: High,
                fixed_actions: &["present_native_approval"],
                compensation: None,
                retryable: false,
                config_kind: ConfigKind::Approval,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "transfer.sftp",
                type_version: 2,
                category: Transfer,
                inputs: vec![
                    input("bundle", ArtifactBundle, true, ANY_ARTIFACT_TYPES),
                    input("approval", ControlApproval, true, &[]),
                ],
                outputs: vec![output("transfer", TransferReceipt, ANY_ARTIFACT_TYPES)],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteWrite,
                capabilities: vec![Capability::Sftp],
                risk_level: Medium,
                fixed_actions: &["stage_artifact", "verify_remote_digest"],
                compensation: Some(("discard_unactivated_staging", &["mark_staging_for_cleanup"])),
                retryable: false,
                config_kind: ConfigKind::TransferSftp,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "release.prepare-files",
                type_version: 1,
                category: Release,
                inputs: vec![input(
                    "transfer",
                    TransferReceipt,
                    true,
                    &[ARTIFACT_TYPE_FILE_TREE],
                )],
                outputs: vec![output(
                    "release",
                    ReleaseReceipt,
                    &[ARTIFACT_TYPE_FILE_TREE],
                )],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteWrite,
                capabilities: vec![Capability::Ssh],
                risk_level: Medium,
                fixed_actions: &["verify_staging", "prepare_immutable_release_directory"],
                compensation: Some((
                    "retain_or_mark_unactivated_release",
                    &["mark_unactivated_release_for_cleanup"],
                )),
                retryable: false,
                config_kind: ConfigKind::PrepareFiles,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "release.prepare-compose",
                type_version: 1,
                category: Release,
                inputs: vec![input(
                    "transfer",
                    TransferReceipt,
                    true,
                    &[ARTIFACT_TYPE_COMPOSE_RELEASE],
                )],
                outputs: vec![output(
                    "release",
                    ReleaseReceipt,
                    &[ARTIFACT_TYPE_COMPOSE_RELEASE],
                )],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteWrite,
                capabilities: vec![Capability::Ssh],
                risk_level: Medium,
                fixed_actions: &["verify_compose_staging", "mark_compose_release_prepared"],
                compensation: Some((
                    "mark_unactivated_compose_release",
                    &["mark_staging_for_cleanup"],
                )),
                retryable: false,
                config_kind: ConfigKind::PrepareCompose,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "runtime.load-image",
                type_version: 1,
                category: Runtime,
                inputs: vec![input(
                    "release",
                    ReleaseReceipt,
                    true,
                    &[ARTIFACT_TYPE_DOCKER_IMAGE, ARTIFACT_TYPE_COMPOSE_RELEASE],
                )],
                outputs: vec![output(
                    "image",
                    ReleaseReceipt,
                    &[ARTIFACT_TYPE_DOCKER_IMAGE, ARTIFACT_TYPE_COMPOSE_RELEASE],
                )],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteWrite,
                capabilities: vec![Capability::DockerRuntime],
                risk_level: Medium,
                fixed_actions: &[
                    "load_verified_image_archive",
                    "verify_loaded_image_identity",
                ],
                compensation: Some(("content_addressed_image_noop", &[])),
                retryable: false,
                config_kind: ConfigKind::LoadImage,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "deploy.compose",
                type_version: 2,
                category: Deploy,
                inputs: vec![input("image", ReleaseReceipt, true, &[])],
                outputs: vec![output("activation", ActivationReceipt, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: ServiceControl,
                capabilities: vec![Capability::DockerCompose],
                risk_level: High,
                fixed_actions: &[
                    "compose_config",
                    "compose_up_no_build_fixed_pull_policy",
                    "capture_service_state",
                ],
                compensation: Some((
                    "restore_compose_release",
                    &[
                        "compose_up_frozen_previous_release",
                        "capture_service_state",
                    ],
                )),
                retryable: false,
                config_kind: ConfigKind::DeployCompose,
                is_artifact_producer: false,
                is_deployment: true,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "deploy.static-switch",
                type_version: 1,
                category: Deploy,
                inputs: vec![input("release", ReleaseReceipt, true, &[])],
                outputs: vec![output("activation", ActivationReceipt, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: TrafficSwitch,
                capabilities: vec![Capability::AtomicSymlink],
                risk_level: Critical,
                fixed_actions: &["atomically_switch_relative_current_symlink"],
                compensation: Some((
                    "restore_current_symlink",
                    &[
                        "atomically_restore_frozen_previous_symlink",
                        "verify_restored_http_endpoint",
                    ],
                )),
                retryable: false,
                config_kind: ConfigKind::StaticSwitch,
                is_artifact_producer: false,
                is_deployment: true,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "verify.http",
                type_version: 2,
                category: Verify,
                inputs: vec![input("activation", ActivationReceipt, true, &[])],
                outputs: vec![output("evidence", VerificationEvidence, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: RemoteRead,
                capabilities: vec![Capability::HttpProbe],
                risk_level: Low,
                fixed_actions: &["perform_bounded_http_probe"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::VerifyHttp,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: true,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "proxy.nginx-reload",
                type_version: 2,
                category: Proxy,
                inputs: vec![input("evidence", VerificationEvidence, true, &[])],
                outputs: vec![output("activation", ActivationReceipt, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: ServiceControl,
                capabilities: vec![Capability::Nginx],
                risk_level: High,
                fixed_actions: &["validate_nginx_configuration", "reload_nginx"],
                compensation: Some((
                    "reverify_after_release_restore",
                    &["verify_nginx_after_release_restore"],
                )),
                retryable: false,
                config_kind: ConfigKind::NginxReload,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "release.commit",
                type_version: 1,
                category: Release,
                inputs: vec![
                    input("evidence", VerificationEvidence, true, &[]),
                    input("activation", ActivationReceipt, false, &[]),
                ],
                outputs: vec![output("activeRelease", ReleaseReceipt, &[])],
                execution_domain: ExecutionDomain::Target,
                effect_class: TrafficSwitch,
                capabilities: vec![Capability::Ssh],
                risk_level: High,
                fixed_actions: &["commit_active_release_identity"],
                compensation: Some((
                    "restore_previous_release_identity",
                    &["commit_frozen_previous_release_identity"],
                )),
                retryable: false,
                config_kind: ConfigKind::ReleaseCommit,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: false,
            }),
            spec(SpecInput {
                type_name: "finalize.notify",
                type_version: 1,
                category: Finalize,
                inputs: vec![],
                outputs: vec![output("notified", ScalarBoolean, &[])],
                execution_domain: Local,
                effect_class: Finalizer,
                capabilities: vec![Capability::Notification],
                risk_level: Low,
                fixed_actions: &["send_bounded_local_notification"],
                compensation: None,
                retryable: true,
                config_kind: ConfigKind::FinalizeNotify,
                is_artifact_producer: false,
                is_deployment: false,
                is_verification: false,
                is_finalizer: true,
            }),
        ];
        Self { nodes }
    }

    pub(crate) fn catalog(&self) -> DeploymentNodeTypeCatalog {
        DeploymentNodeTypeCatalog {
            schema_version: 1,
            nodes: self.nodes.clone(),
        }
    }

    pub(crate) fn nodes(&self) -> &[DeploymentNodeTypeSpec] {
        &self.nodes
    }

    #[cfg(test)]
    pub(crate) fn from_test_nodes(nodes: Vec<DeploymentNodeTypeSpec>) -> Self {
        Self { nodes }
    }

    pub(crate) fn find(
        &self,
        type_name: &str,
        type_version: u32,
    ) -> Option<&DeploymentNodeTypeSpec> {
        self.nodes
            .iter()
            .find(|spec| spec.type_name == type_name && spec.type_version == type_version)
    }

    pub(crate) fn versions_for(&self, type_name: &str) -> Vec<u32> {
        self.nodes
            .iter()
            .filter(|spec| spec.type_name == type_name)
            .map(|spec| spec.type_version)
            .collect()
    }

    pub(crate) fn validate_config(
        &self,
        spec: &DeploymentNodeTypeSpec,
        node_id: &str,
        config: &Value,
    ) -> Result<ValidatedNodeConfig, Vec<WorkflowValidationError>> {
        let mut errors = dangerous_config_errors(node_id, config);
        if serde_json::to_vec(config)
            .map(|bytes| bytes.len() > MAX_CONFIG_JSON_BYTES)
            .unwrap_or(true)
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("node config exceeds {MAX_CONFIG_JSON_BYTES} bytes"),
                )
                .for_node(node_id)
                .at_path(format!("nodes.{node_id}.config")),
            );
        }
        if json_depth(config) > MAX_JSON_DEPTH {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("node config exceeds JSON depth {MAX_JSON_DEPTH}"),
                )
                .for_node(node_id)
                .at_path(format!("nodes.{node_id}.config")),
            );
        }
        if !errors.is_empty() {
            return Err(errors);
        }

        let mut artifact_outputs = BTreeMap::new();
        let mut required_target_capabilities = BTreeSet::new();
        let result = match spec.config_kind {
            ConfigKind::SourceSnapshot => parse_config::<SourceSnapshotConfig>(node_id, config)
                .and_then(|value| {
                    validate_reference("sourceRef", &value.source_ref)?;
                    Ok(None)
                }),
            ConfigKind::PackageScript => parse_config::<PackageScriptConfig>(node_id, config)
                .and_then(|value| {
                    validate_relative_path("workingDirectory", &value.working_directory, true)?;
                    validate_relative_path("outputDirectory", &value.output_directory, false)?;
                    validate_script_name(&value.script_name)?;
                    validate_reference_list("environmentRefs", &value.environment_refs, 16)?;
                    validate_build_environment_refs(&value.environment_refs)?;
                    Ok(None)
                }),
            ConfigKind::DockerBuildx => parse_config::<DockerBuildxConfig>(node_id, config)
                .and_then(|value| {
                    validate_relative_path("context", &value.context, true)?;
                    validate_relative_path("dockerfile", &value.dockerfile, false)?;
                    validate_image_repository(&value.image_repository)?;
                    Ok(None)
                }),
            ConfigKind::ArtifactCollect => parse_config::<ArtifactCollectConfig>(node_id, config)
                .and_then(|value| {
                    if value.paths.is_empty() || value.paths.len() > 32 {
                        return Err("paths must contain between 1 and 32 entries".into());
                    }
                    for path in &value.paths {
                        validate_relative_path("paths", path, false)?;
                    }
                    let artifact_type = match value.kind {
                        ArtifactCollectKind::FileTree => ARTIFACT_TYPE_FILE_TREE,
                        ArtifactCollectKind::Binary => ARTIFACT_TYPE_BINARY,
                        ArtifactCollectKind::Zip => ARTIFACT_TYPE_ZIP,
                    };
                    artifact_outputs
                        .insert("bundle".into(), BTreeSet::from([artifact_type.to_string()]));
                    Ok(None)
                }),
            ConfigKind::BundleCompose => parse_config::<BundleComposeConfig>(node_id, config)
                .and_then(|value| {
                    if value.compose_files.is_empty() || value.compose_files.len() > 8 {
                        return Err("composeFiles must contain between 1 and 8 entries".into());
                    }
                    for path in &value.compose_files {
                        validate_relative_path("composeFiles", path, false)?;
                    }
                    validate_project_name(&value.project_name)?;
                    validate_identifier_list("services", &value.services, 32)?;
                    Ok(None)
                }),
            ConfigKind::TargetPreflight => parse_config::<TargetPreflightConfig>(node_id, config)
                .and_then(|value| {
                    validate_identifier("targetId", &value.target_id)?;
                    if value.required_capabilities.len() > 16 {
                        return Err("requiredCapabilities exceeds 16 entries".into());
                    }
                    required_target_capabilities.insert(Capability::Ssh);
                    for capability in value.required_capabilities {
                        required_target_capabilities.insert(match capability {
                            RequiredTargetCapability::Sftp => Capability::Sftp,
                            RequiredTargetCapability::AtomicSymlink => Capability::AtomicSymlink,
                            RequiredTargetCapability::Docker => Capability::DockerRuntime,
                            RequiredTargetCapability::Compose => Capability::DockerCompose,
                            RequiredTargetCapability::Http => Capability::HttpProbe,
                            RequiredTargetCapability::Nginx => Capability::Nginx,
                        });
                    }
                    Ok(Some(value.target_id))
                }),
            ConfigKind::ReleaseCandidate => parse_config::<ReleaseCandidateConfig>(node_id, config)
                .and_then(|value| {
                    validate_identifier("targetId", &value.target_id)?;
                    Ok(Some(value.target_id))
                }),
            ConfigKind::Approval => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::TransferSftp => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::PrepareCompose => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::PrepareFiles => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::LoadImage => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::DeployCompose => parse_config::<DeployComposeConfig>(node_id, config)
                .and_then(|value| {
                    validate_identifier("targetId", &value.target_id)?;
                    validate_project_name(&value.project_name)?;
                    validate_identifier_list("services", &value.services, 32)?;
                    Ok(Some(value.target_id))
                }),
            ConfigKind::StaticSwitch => parse_config::<StaticSwitchConfig>(node_id, config)
                .and_then(|value| {
                    validate_identifier("targetId", &value.target_id)?;
                    if value.link_name != "current" {
                        return Err("linkName must be exactly 'current'".into());
                    }
                    Ok(Some(value.target_id))
                }),
            ConfigKind::VerifyHttp => {
                parse_config::<VerifyHttpConfig>(node_id, config).and_then(|value| {
                    validate_identifier("targetId", &value.target_id)?;
                    validate_http_path(&value.path)?;
                    if value.port == 0 {
                        return Err("port must be between 1 and 65535".into());
                    }
                    if value.expected_statuses.is_empty() || value.expected_statuses.len() > 16 {
                        return Err("expectedStatuses must contain between 1 and 16 entries".into());
                    }
                    if value
                        .expected_statuses
                        .iter()
                        .any(|status| !(100..=599).contains(status))
                    {
                        return Err("expectedStatuses contains an invalid HTTP status".into());
                    }
                    Ok(Some(value.target_id))
                })
            }
            ConfigKind::NginxReload => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::ReleaseCommit => parse_config::<TargetOnlyConfig>(node_id, config)
                .and_then(|value| target_only(value.target_id)),
            ConfigKind::FinalizeNotify => parse_config::<FinalizeNotifyConfig>(node_id, config)
                .and_then(|value| {
                    if value.events.is_empty() || value.events.len() > 4 {
                        return Err("events must contain between 1 and 4 entries".into());
                    }
                    Ok(None)
                }),
        };

        result
            .map(|target_id| ValidatedNodeConfig {
                target_id,
                artifact_outputs,
                required_target_capabilities,
            })
            .map_err(|message| {
                vec![WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidNodeConfig,
                    message,
                )
                .for_node(node_id)
                .at_path(format!("nodes.{node_id}.config"))]
            })
    }
}

fn parse_config<T: DeserializeOwned>(node_id: &str, config: &Value) -> Result<T, String> {
    serde_json::from_value(config.clone())
        .map_err(|error| format!("invalid config for node '{node_id}': {error}"))
}

fn target_only(target_id: String) -> Result<Option<String>, String> {
    validate_identifier("targetId", &target_id)?;
    Ok(Some(target_id))
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        _ => 1,
    }
}

fn dangerous_config_errors(node_id: &str, config: &Value) -> Vec<WorkflowValidationError> {
    fn visit(node_id: &str, value: &Value, path: &str, errors: &mut Vec<WorkflowValidationError>) {
        match value {
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    visit(node_id, value, &format!("{path}.{index}"), errors);
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    let forbidden_command = matches!(
                        normalized.as_str(),
                        "command" | "shell" | "argv" | "executable" | "interpreter" | "scriptbody"
                    );
                    let forbidden_secret = matches!(
                        normalized.as_str(),
                        "password"
                            | "secret"
                            | "token"
                            | "apikey"
                            | "privatekey"
                            | "credentialvalue"
                    );
                    if forbidden_command || forbidden_secret {
                        errors.push(
                            WorkflowValidationError::new(
                                WorkflowValidationCode::DangerousConfig,
                                format!("forbidden config field '{key}'"),
                            )
                            .for_node(node_id)
                            .at_path(format!("{path}.{key}")),
                        );
                    }
                    visit(node_id, value, &format!("{path}.{key}"), errors);
                }
            }
            Value::String(value)
                if value.contains("-----BEGIN PRIVATE KEY")
                    || value.contains("-----BEGIN OPENSSH PRIVATE KEY") =>
            {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::DangerousConfig,
                        "literal private-key material is forbidden",
                    )
                    .for_node(node_id)
                    .at_path(path),
                );
            }
            _ => {}
        }
    }

    let mut errors = Vec::new();
    visit(
        node_id,
        config,
        &format!("nodes.{node_id}.config"),
        &mut errors,
    );
    errors
}

pub(crate) fn validate_identifier(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(format!(
            "{field} must contain between 1 and {MAX_IDENTIFIER_BYTES} bytes"
        ));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{field} is required"));
    };
    if !first.is_ascii_alphanumeric()
        || !chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!(
            "{field} must start with an ASCII letter or digit and contain only letters, digits, '.', '-' or '_'"
        ));
    }
    Ok(())
}

pub(crate) fn validate_remote_root(value: &str) -> Result<(), String> {
    if value.len() > 512
        || value == "/"
        || !value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\0')
    {
        return Err(
            "remoteRoot must be a non-root absolute POSIX path of at most 512 bytes".into(),
        );
    }
    if value.contains("//")
        || value
            .split('/')
            .any(|component| matches!(component, "." | ".."))
    {
        return Err("remoteRoot must be normalized and cannot contain '.' or '..' segments".into());
    }
    if value.chars().any(|character| character.is_control()) {
        return Err("remoteRoot cannot contain control characters".into());
    }
    Ok(())
}

fn validate_relative_path(field: &str, value: &str, allow_dot: bool) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.contains('\0') || value.contains('\\') {
        return Err(format!("{field} must be a non-empty POSIX relative path"));
    }
    if allow_dot && value == "." {
        return Ok(());
    }
    if value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!(
            "{field} must be normalized, relative, and cannot contain '.' or '..' segments"
        ));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(format!("{field} cannot contain control characters"));
    }
    Ok(())
}

fn validate_reference(field: &str, value: &str) -> Result<(), String> {
    validate_identifier(field, value)
}

fn validate_reference_list(field: &str, values: &[String], max: usize) -> Result<(), String> {
    if values.len() > max {
        return Err(format!("{field} exceeds {max} entries"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_reference(field, value)?;
        if !unique.insert(value) {
            return Err(format!("{field} contains duplicate reference '{value}'"));
        }
    }
    Ok(())
}

fn validate_build_environment_refs(values: &[String]) -> Result<(), String> {
    const ALLOWED: &[&str] = &["ci", "node-env-production", "source-date-epoch-zero"];
    if let Some(value) = values
        .iter()
        .find(|value| !ALLOWED.contains(&value.as_str()))
    {
        return Err(format!(
            "environmentRefs contains unsupported reference '{value}'"
        ));
    }
    Ok(())
}

fn validate_identifier_list(field: &str, values: &[String], max: usize) -> Result<(), String> {
    if values.len() > max {
        return Err(format!("{field} exceeds {max} entries"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_identifier(field, value)?;
        if !unique.insert(value) {
            return Err(format!("{field} contains duplicate value '{value}'"));
        }
    }
    Ok(())
}

fn validate_script_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 64 {
        return Err("scriptName must contain between 1 and 64 bytes".into());
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, ':' | '-' | '_'))
    {
        return Err("scriptName contains unsupported characters".into());
    }
    Ok(())
}

fn validate_image_repository(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 255 {
        return Err("imageRepository must contain between 1 and 255 bytes".into());
    }
    if value.chars().any(|character| {
        !(character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '-' | '_' | ':'))
    }) {
        return Err("imageRepository contains unsupported characters".into());
    }
    Ok(())
}

fn validate_project_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 63 {
        return Err("projectName must contain between 1 and 63 bytes".into());
    }
    if !value.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '-' | '_')
    }) {
        return Err("projectName must use lowercase ASCII letters, digits, '-' or '_'".into());
    }
    Ok(())
}

fn validate_http_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 1024
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\0')
        || value.contains("..")
        || value.contains("http://")
        || value.contains("https://")
    {
        return Err("path must be a bounded target-relative HTTP path".into());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSnapshotConfig {
    source_ref: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageScriptConfig {
    package_manager: PackageManager,
    working_directory: String,
    install_mode: InstallMode,
    script_name: String,
    output_directory: String,
    #[serde(default)]
    environment_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PackageManager {
    Pnpm,
    Npm,
    Yarn,
    Bun,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum InstallMode {
    Frozen,
    Skip,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DockerBuildxConfig {
    context: String,
    dockerfile: String,
    platform: DockerPlatform,
    image_repository: String,
}

#[derive(Debug, Deserialize)]
enum DockerPlatform {
    #[serde(rename = "linux/amd64")]
    LinuxAmd64,
    #[serde(rename = "linux/arm64")]
    LinuxArm64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactCollectConfig {
    kind: ArtifactCollectKind,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ArtifactCollectKind {
    FileTree,
    Binary,
    Zip,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleComposeConfig {
    compose_files: Vec<String>,
    project_name: String,
    #[serde(default)]
    services: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetPreflightConfig {
    target_id: String,
    #[serde(default)]
    required_capabilities: Vec<RequiredTargetCapability>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RequiredTargetCapability {
    Sftp,
    AtomicSymlink,
    Docker,
    Compose,
    Http,
    Nginx,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseCandidateConfig {
    target_id: String,
    strategy: ReleaseStrategy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReleaseStrategy {
    StaticFiles,
    DockerCompose,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetOnlyConfig {
    target_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeployComposeConfig {
    target_id: String,
    project_name: String,
    #[serde(default)]
    services: Vec<String>,
    pull_policy: ComposePullPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ComposePullPolicy {
    Never,
    Missing,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StaticSwitchConfig {
    target_id: String,
    link_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyHttpConfig {
    target_id: String,
    scheme: HttpScheme,
    port: u16,
    path: String,
    expected_statuses: Vec<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HttpScheme {
    Http,
    Https,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinalizeNotifyConfig {
    channel: NotifyChannel,
    events: Vec<NotifyEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum NotifyChannel {
    System,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum NotifyEvent {
    Succeeded,
    Failed,
    Canceled,
    StateUnknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lists_every_mvp_node_with_readable_metadata() {
        let registry = DeploymentNodeRegistry::mvp();
        let names = registry
            .nodes()
            .iter()
            .map(DeploymentNodeTypeSpec::qualified_name)
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 18);
        for expected in [
            "source.snapshot@1",
            "build.package-script@1",
            "build.docker-buildx@2",
            "artifact.collect@1",
            "artifact.bundle-compose@1",
            "target.preflight@2",
            "release.create-candidate@1",
            "control.approval@1",
            "transfer.sftp@2",
            "release.prepare-files@1",
            "runtime.load-image@1",
            "deploy.compose@2",
            "deploy.static-switch@1",
            "verify.http@2",
            "proxy.nginx-reload@2",
            "release.commit@1",
            "finalize.notify@1",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing {expected}"
            );
        }
        assert!(registry.nodes().iter().all(|node| {
            !node.display_name_key.is_empty()
                && !node.description_key.is_empty()
                && !node.fixed_actions.is_empty()
                && node.config_schema.schema_version == node.config_schema_version
                && node.default_config.is_object()
        }));
        let package_script = registry.find("build.package-script", 1).unwrap();
        assert!(package_script
            .config_schema
            .fields
            .iter()
            .any(|field| field.name == "packageManager" && !field.options.is_empty()));
        registry
            .validate_config(package_script, "build", &package_script.default_config)
            .unwrap();
    }

    #[test]
    fn dangerous_command_and_secret_fields_are_rejected_before_schema_parsing() {
        let registry = DeploymentNodeRegistry::mvp();
        let node = registry.find("source.snapshot", 1).unwrap();
        for config in [
            serde_json::json!({"sourceRef": "repo", "command": "rm -rf /"}),
            serde_json::json!({"sourceRef": "repo", "password": "literal"}),
        ] {
            let errors = registry
                .validate_config(node, "source", &config)
                .unwrap_err();
            assert!(errors
                .iter()
                .any(|error| error.code == WorkflowValidationCode::DangerousConfig));
        }
    }
}
