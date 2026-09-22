use super::canonicalization::canonical_sha256;
use super::node_registry::{DeploymentNodeRegistry, DeploymentNodeTypeSpec};
use super::workflow_schema::{
    EffectReceipt, ImmutableRunPlan, VerificationEvidence, WorkflowNodeDefinition,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
pub(crate) const DEPLOYMENT_EXECUTOR_CONTRACT_VERSION: &str = "deployment-node-executor";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenNodeInput {
    pub run_id: String,
    pub node: WorkflowNodeDefinition,
    pub targets: Vec<super::workflow_schema::DeploymentTargetDefinition>,
    pub inputs: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlannedNode {
    pub schema_version: u32,
    pub node_id: String,
    pub node_type: String,
    pub node_type_version: u32,
    pub executor_version: String,
    pub config_digest: String,
    pub input_digest: String,
    pub fixed_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VerifiedNodeInput {
    pub frozen: FrozenNodeInput,
    pub planned: PlannedNode,
    pub immutable_plan: Option<ImmutableRunPlan>,
    pub attempt: u32,
    pub idempotency_key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NodeExecutionContext {
    pub cancellation: CancellationToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeOutputKind {
    Scalar,
    Artifact,
    Receipt,
    Evidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeOutputValue {
    pub kind: NodeOutputKind,
    pub value: Value,
    pub artifact_reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeExecutionResult {
    pub outputs: BTreeMap<String, NodeOutputValue>,
    pub receipt: Option<EffectReceipt>,
    pub evidence: Option<VerificationEvidence>,
    pub summary: Value,
}

impl NodeExecutionResult {
    pub(crate) fn output(name: impl Into<String>, output: NodeOutputValue) -> Self {
        Self {
            outputs: BTreeMap::from([(name.into(), output)]),
            receipt: None,
            evidence: None,
            summary: serde_json::json!({ "completed": true }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeFailureDisposition {
    Definite,
    Ambiguous,
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeFailure {
    pub category: String,
    pub message: String,
    pub disposition: NodeFailureDisposition,
}

impl NodeFailure {
    pub(crate) fn definite(category: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            category: category.into(),
            message: message.into(),
            disposition: NodeFailureDisposition::Definite,
        }
    }

    pub(crate) fn ambiguous(category: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            category: category.into(),
            message: message.into(),
            disposition: NodeFailureDisposition::Ambiguous,
        }
    }

    pub(crate) fn canceled() -> Self {
        Self {
            category: "canceled".into(),
            message: "deployment node execution was canceled".into(),
            disposition: NodeFailureDisposition::Canceled,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NodeReconcileResult {
    NotStarted,
    SafeToRetry,
    Succeeded(Box<NodeExecutionResult>),
    // Part of the executor contract even though the current built-in executor
    // only reports retryable, successful, or unknown reconciliation outcomes.
    #[allow(dead_code)]
    FailedDefinitely(NodeFailure),
    StateUnknown(String),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CompensationInput {
    pub verified: VerifiedNodeInput,
    pub successful_result: NodeExecutionResult,
    pub compensation_kind: String,
    pub fixed_actions: Vec<String>,
    pub frozen_verification: Option<WorkflowNodeDefinition>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CompensationResult {
    Succeeded(EffectReceipt),
    NotRequired,
    StateUnknown(String),
}

#[async_trait]
pub(crate) trait DeploymentNodeExecutor: Send + Sync {
    fn node_type(&self) -> (&'static str, u32);

    fn executor_version(&self) -> &'static str;

    fn validate_config(&self, config: &Value) -> Result<(), String>;

    fn plan(&self, input: FrozenNodeInput) -> Result<PlannedNode, String>;

    async fn execute(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeExecutionResult, NodeFailure>;

    async fn reconcile(
        &self,
        input: VerifiedNodeInput,
        context: NodeExecutionContext,
    ) -> Result<NodeReconcileResult, NodeFailure>;

    async fn compensate(
        &self,
        input: CompensationInput,
        context: NodeExecutionContext,
    ) -> Result<CompensationResult, NodeFailure>;
}

#[derive(Clone, Default)]
pub(crate) struct DeploymentNodeExecutorRegistry {
    executors: BTreeMap<(String, u32), Arc<dyn DeploymentNodeExecutor>>,
}

impl DeploymentNodeExecutorRegistry {
    pub(crate) fn register(
        &mut self,
        executor: Arc<dyn DeploymentNodeExecutor>,
    ) -> Result<(), String> {
        let (node_type, version) = executor.node_type();
        let key = (node_type.to_string(), version);
        if self.executors.insert(key, executor).is_some() {
            return Err("DEPLOYMENT_WORKFLOW_DUPLICATE_EXECUTOR".into());
        }
        Ok(())
    }

    pub(crate) fn get(
        &self,
        node_type: &str,
        node_type_version: u32,
    ) -> Result<Arc<dyn DeploymentNodeExecutor>, String> {
        self.executors
            .get(&(node_type.to_string(), node_type_version))
            .cloned()
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_NOT_REGISTERED".to_string())
    }

    pub(crate) fn validate_against_registry(
        &self,
        registry: &DeploymentNodeRegistry,
        required_nodes: impl IntoIterator<Item = (String, u32)>,
    ) -> Result<(), String> {
        for (node_type, version) in required_nodes {
            if registry.find(&node_type, version).is_none() {
                return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".into());
            }
            self.get(&node_type, version)?;
        }
        Ok(())
    }
}

pub(crate) fn plan_from_descriptor(
    descriptor: &DeploymentNodeTypeSpec,
    executor_version: &str,
    input: &FrozenNodeInput,
) -> Result<PlannedNode, String> {
    let config_digest = canonical_sha256(&input.node.config).map_err(|error| error.to_string())?;
    let input_digest = canonical_sha256(&input.inputs).map_err(|error| error.to_string())?;
    Ok(PlannedNode {
        schema_version: 1,
        node_id: input.node.id.clone(),
        node_type: descriptor.type_name.clone(),
        node_type_version: descriptor.type_version,
        executor_version: executor_version.to_string(),
        config_digest,
        input_digest,
        fixed_actions: descriptor.fixed_actions.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executor_contract_name_and_plan_digests_are_stable() {
        assert_eq!(
            DEPLOYMENT_EXECUTOR_CONTRACT_VERSION,
            "deployment-node-executor"
        );
        let definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        let node = definition.nodes[0].clone();
        let registry = DeploymentNodeRegistry::mvp();
        let descriptor = registry.find(&node.type_name, node.type_version).unwrap();
        let input = FrozenNodeInput {
            run_id: "run-contract".into(),
            node,
            targets: definition.targets,
            inputs: BTreeMap::new(),
        };
        let first = plan_from_descriptor(descriptor, "test", &input).unwrap();
        let second = plan_from_descriptor(descriptor, "test", &input).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.fixed_actions, vec!["freeze_source_snapshot"]);
    }
}
