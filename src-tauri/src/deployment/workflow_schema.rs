use super::port_types::DeploymentPortType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const WORKFLOW_SCHEMA_VERSION: u32 = 3;
pub(crate) const LAYOUT_SCHEMA_VERSION: u32 = 1;
pub(crate) const ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 2;
pub(crate) const COMPILED_PLAN_DRAFT_SCHEMA_VERSION: u32 = 1;

pub(crate) const MAX_WORKFLOW_JSON_BYTES: usize = 256 * 1024;
pub(crate) const MAX_LAYOUT_JSON_BYTES: usize = 128 * 1024;
pub(crate) const MAX_NODES: usize = 64;
pub(crate) const MAX_NODE_INPUTS: usize = 16;
pub(crate) const MAX_NODE_OUTPUTS: usize = 16;
pub(crate) const MAX_TARGETS: usize = 8;
pub(crate) const MAX_PARAMETERS: usize = 32;
pub(crate) const MAX_WORKFLOW_OUTPUTS: usize = 16;
pub(crate) const MAX_IDENTIFIER_BYTES: usize = 64;
pub(crate) const MAX_DISPLAY_NAME_BYTES: usize = 128;
pub(crate) const MAX_CONFIG_JSON_BYTES: usize = 32 * 1024;
pub(crate) const MAX_JSON_DEPTH: usize = 16;
pub(crate) const MAX_TIMEOUT_SECONDS: u32 = 86_400;
pub(crate) const MAX_RETRY_ATTEMPTS: u8 = 3;
pub(crate) const MAX_RETRY_BACKOFF_SECONDS: u32 = 300;
pub(crate) const MAX_PARALLEL_LOCAL_NODES: u8 = 8;
pub(crate) const MAX_RELEASES_TO_KEEP: u16 = 50;
pub(crate) const MAX_CONDITION_VALUES: usize = 16;
pub(crate) const MAX_SCALAR_STRING_BYTES: usize = 1024;
pub(crate) const MAX_ARTIFACT_COMPONENTS: usize = 64;
pub(crate) const MAX_ARTIFACT_COMPONENT_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(crate) const MAX_ARTIFACT_TOTAL_BYTES: u64 = 32 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentWorkflowDefinition {
    pub schema_version: u32,
    pub targets: Vec<DeploymentTargetDefinition>,
    #[serde(default)]
    pub parameters: Vec<WorkflowParameterDefinition>,
    pub nodes: Vec<WorkflowNodeDefinition>,
    pub outputs: BTreeMap<String, PortBinding>,
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentTargetDefinition {
    pub id: String,
    pub connection_profile_id: String,
    pub remote_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowParameterType {
    String,
    Boolean,
    Integer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowParameterDefinition {
    pub id: String,
    pub display_name: String,
    #[serde(rename = "type")]
    pub parameter_type: WorkflowParameterType,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<ScalarValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowNodeDefinition {
    pub id: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub type_version: u32,
    pub display_name: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, PortBinding>,
    pub config: Value,
    pub timeout_seconds: u32,
    pub retry: NodeRetryPolicy,
    pub run_when: NodeRunWhen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<NodeCondition>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortBinding {
    pub from_node_id: String,
    pub from_port: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeRunWhen {
    AllSucceeded,
    AnyFailed,
    Always,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeRetryPolicy {
    pub max_attempts: u8,
    pub initial_backoff_seconds: u32,
    pub max_backoff_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum NodeCondition {
    Equals {
        input: PortBinding,
        value: ScalarValue,
    },
    In {
        input: PortBinding,
        values: Vec<ScalarValue>,
    },
    Exists {
        input: PortBinding,
    },
}

impl NodeCondition {
    pub(crate) fn input(&self) -> &PortBinding {
        match self {
            Self::Equals { input, .. } | Self::In { input, .. } | Self::Exists { input } => input,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum ScalarValue {
    String(String),
    Boolean(bool),
    Integer(i64),
}

impl ScalarValue {
    pub(crate) fn matches_port(&self, port_type: DeploymentPortType) -> bool {
        matches!(
            (self, port_type),
            (Self::String(_), DeploymentPortType::ScalarString)
                | (Self::Boolean(_), DeploymentPortType::ScalarBoolean)
                | (Self::Integer(_), DeploymentPortType::ScalarInteger)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowPolicy {
    pub fail_fast: bool,
    pub max_parallel_local_nodes: u8,
    pub releases_to_keep: u16,
    pub automatic_restore: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentWorkflowLayout {
    pub schema_version: u32,
    pub nodes: BTreeMap<String, WorkflowNodeLayout>,
    #[serde(default)]
    pub groups: Vec<WorkflowLayoutGroup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<WorkflowViewport>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowNodeLayout {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowLayoutGroup {
    pub id: String,
    pub title: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExecutionDomain {
    Local,
    Target,
    NativeUi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EffectClass {
    Pure,
    LocalRead,
    LocalBuild,
    RemoteRead,
    Control,
    RemoteWrite,
    ServiceControl,
    TrafficSwitch,
    Cleanup,
    Finalizer,
}

impl EffectClass {
    pub(crate) fn requires_approval(self) -> bool {
        matches!(
            self,
            Self::RemoteWrite | Self::ServiceControl | Self::TrafficSwitch | Self::Cleanup
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactRole {
    Application,
    DeploymentConfig,
    Metadata,
    Sbom,
    Signature,
    Auxiliary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactPlatform {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactDescriptor {
    pub name: String,
    pub role: ArtifactRole,
    pub media_type: String,
    pub digest: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<ArtifactPlatform>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactSource {
    pub revision: String,
    pub dirty: bool,
    pub snapshot_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactProducer {
    pub node_type: String,
    pub node_type_version: u32,
    pub config_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactBundleManifest {
    pub schema_version: u32,
    pub artifact_type: String,
    pub source: ArtifactSource,
    pub components: Vec<ArtifactDescriptor>,
    pub producer: ArtifactProducer,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactHandle {
    pub artifact_reference: String,
    pub manifest_digest: String,
    pub content_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompiledNodePlan {
    pub node_id: String,
    pub display_name: String,
    pub node_type: String,
    pub node_type_version: u32,
    pub execution_domain: ExecutionDomain,
    pub effect_class: EffectClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    pub config_digest: String,
    pub input_digest: String,
    pub timeout_seconds: u32,
    pub retry: NodeRetryPolicy,
    pub fixed_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanRiskEntry {
    pub node_id: String,
    pub level: RiskLevel,
    pub effect_class: EffectClass,
    pub summary_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanRiskSummary {
    pub highest_level: RiskLevel,
    pub entries: Vec<PlanRiskEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlannedCompensation {
    pub node_id: String,
    pub compensation_kind: String,
    pub fixed_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompiledRunPlanDraft {
    pub schema_version: u32,
    pub definition_digest: String,
    pub plan_digest: String,
    pub topology_layers: Vec<Vec<String>>,
    pub target_effect_lanes: BTreeMap<String, Vec<String>>,
    pub nodes: Vec<CompiledNodePlan>,
    pub risks: PlanRiskSummary,
    pub compensations: Vec<PlannedCompensation>,
    pub policy: WorkflowPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowRunOperationKind {
    Deploy,
    Rollback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowRunTriggerKind {
    Manual,
    Agent,
    QuickAction,
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenSourceSnapshot {
    pub source_ref: String,
    pub revision: String,
    pub dirty: bool,
    pub snapshot_digest: String,
    pub metadata_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenTargetIdentity {
    pub target_id: String,
    pub connection_profile_id: String,
    pub profile_revision: i64,
    pub host_identity_digest: String,
    pub remote_root: String,
    pub capabilities_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenReleaseIdentity {
    pub release_id: String,
    pub artifact_content_digest: String,
    pub layout_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImmutableRunPlan {
    pub schema_version: u32,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub run_id: String,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    pub definition_digest: String,
    pub parameters: BTreeMap<String, ScalarValue>,
    pub source: FrozenSourceSnapshot,
    pub target: FrozenTargetIdentity,
    pub artifacts: Vec<ArtifactHandle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_release: Option<FrozenReleaseIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_release: Option<FrozenReleaseIdentity>,
    pub target_release: FrozenReleaseIdentity,
    pub executor_versions: BTreeMap<String, String>,
    pub compiled: CompiledRunPlanDraft,
    pub prepared_at: i64,
    pub expires_at: i64,
    pub plan_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EffectReceipt {
    pub schema_version: u32,
    pub receipt_type: String,
    pub operation_id: String,
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub target_id: String,
    pub plan_digest: String,
    pub payload_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerificationEvidence {
    pub schema_version: u32,
    pub evidence_type: String,
    pub run_id: String,
    pub node_id: String,
    pub target_id: String,
    pub plan_digest: String,
    pub observed_at: i64,
    pub outcome: String,
    pub payload_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeAttemptStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Canceled,
    StateUnknown,
    Compensated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub(crate) struct NodeAttempt {
    pub schema_version: u32,
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    pub status: NodeAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) enum CompensationStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    StateUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub(crate) struct CompensationRecord {
    pub schema_version: u32,
    pub run_id: String,
    pub node_id: String,
    pub compensation_kind: String,
    pub idempotency_key: String,
    pub status: CompensationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<EffectReceipt>,
}
