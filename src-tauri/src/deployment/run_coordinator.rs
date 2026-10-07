use super::artifact_cas::DeploymentArtifactCas;
use super::canonicalization::canonical_sha256;
use super::compiler::compile_workflow_definition;
use super::docker_compose_executor::DOCKER_COMPOSE_EXECUTOR_VERSION;
use super::node_executor::{
    CompensationInput, CompensationResult, DeploymentNodeExecutorRegistry, FrozenNodeInput,
    NodeExecutionContext, NodeExecutionResult, NodeFailureDisposition, NodeOutputKind,
    NodeOutputValue, NodeReconcileResult, PlannedNode, VerifiedNodeInput,
};
use super::node_registry::DeploymentNodeRegistry;
use super::repository::{
    DeploymentArtifactRefKind, DeploymentArtifactRefWrite, DeploymentArtifactWrite,
    DeploymentNodeAttemptWrite, DeploymentRunNodeSeed, DeploymentRunNodeStatus,
    DeploymentRunOutputKind, DeploymentRunOutputWrite, DeploymentRunRecord, DeploymentRunStatus,
    DeploymentRunWrite,
};
use super::runtime::DeploymentWorkflowRuntime;
use super::security::{safe_failure_code, MAX_APPROVAL_SUMMARY_BYTES, MAX_IMMUTABLE_PLAN_BYTES};
use super::workflow_schema::{
    ArtifactHandle, FrozenReleaseIdentity, FrozenSourceSnapshot, FrozenTargetIdentity,
    ImmutableRunPlan, NodeAttemptStatus, WorkflowRunOperationKind, WorkflowRunTriggerKind,
};
use crate::db::{current_timestamp_ms, Database};
use futures_util::future::join_all;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const PLAN_TTL_MS: i64 = 30 * 60 * 1_000;
const EXECUTOR_PLAN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrepareRunRequest {
    pub run_id: String,
    pub workflow_id: String,
    pub workflow_revision: u64,
    pub operation_kind: WorkflowRunOperationKind,
    pub trigger_kind: WorkflowRunTriggerKind,
    pub parameters: BTreeMap<String, super::workflow_schema::ScalarValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedRun {
    pub run_id: String,
    pub plan_digest: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunProjection {
    pub run_id: String,
    pub status: String,
    pub plan_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReconciliationProjection {
    pub run_id: String,
    pub status: String,
    pub evidence_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparationProgress {
    pub run_id: String,
    pub node_id: String,
    pub status: String,
    pub completed: u32,
    pub total: u32,
}

pub(crate) type PreparationProgressObserver = Arc<dyn Fn(PreparationProgress) + Send + Sync>;

#[derive(Debug, Clone)]
struct CompletedNode {
    node_id: String,
    planned: PlannedNode,
    attempt: u32,
    result: NodeExecutionResult,
}

#[derive(Debug, Clone)]
struct PreparationState {
    outputs: BTreeMap<(String, String), NodeOutputValue>,
    completed: Vec<CompletedNode>,
    reused_nodes: Vec<String>,
}

fn output_kind(kind: NodeOutputKind) -> DeploymentRunOutputKind {
    match kind {
        NodeOutputKind::Scalar => DeploymentRunOutputKind::Scalar,
        NodeOutputKind::Artifact => DeploymentRunOutputKind::Artifact,
        NodeOutputKind::Receipt => DeploymentRunOutputKind::Receipt,
        NodeOutputKind::Evidence => DeploymentRunOutputKind::Evidence,
    }
}

fn node_inputs(
    node: &super::workflow_schema::WorkflowNodeDefinition,
    outputs: &BTreeMap<(String, String), NodeOutputValue>,
) -> Result<BTreeMap<String, Value>, String> {
    node.inputs
        .iter()
        .map(|(name, binding)| {
            outputs
                .get(&(binding.from_node_id.clone(), binding.from_port.clone()))
                .map(|output| (name.clone(), output.value.clone()))
                .ok_or_else(|| {
                    format!("DEPLOYMENT_WORKFLOW_INPUT_UNAVAILABLE:{}:{}", node.id, name)
                })
        })
        .collect()
}

fn idempotency_key(run_id: &str, node_id: &str, attempt: u32, plan_digest: &str) -> String {
    let digest = canonical_sha256(&serde_json::json!({
        "contract": "deployment-node-attempt",
        "runId": run_id,
        "nodeId": node_id,
        "attempt": attempt,
        "planDigest": plan_digest,
    }))
    .expect("bounded attempt identity is serializable");
    format!("deployment-attempt:{}", &digest[7..])
}

fn plan_digest(plan: &ImmutableRunPlan) -> Result<String, String> {
    let mut value = serde_json::to_value(plan).map_err(|error| error.to_string())?;
    value
        .as_object_mut()
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_INVALID_IMMUTABLE_PLAN".to_string())?
        .remove("planDigest");
    canonical_sha256(&value).map_err(|error| error.to_string())
}

fn ensure_plan_unexpired(expires_at: i64) -> Result<(), String> {
    if current_timestamp_ms() >= expires_at {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_EXPIRED".into());
    }
    Ok(())
}

fn parse_artifact_handle(value: &Value) -> Result<ArtifactHandle, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_ARTIFACT_OUTPUT".to_string())
}

fn parse_source(value: &Value) -> Result<FrozenSourceSnapshot, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_SOURCE_OUTPUT".to_string())
}

fn parse_target(value: &Value) -> Result<FrozenTargetIdentity, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_TARGET_OUTPUT".to_string())
}

fn parse_release(value: &Value) -> Result<FrozenReleaseIdentity, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_INVALID_RELEASE_OUTPUT".to_string())
}

fn resolve_parameters(
    definition: &super::workflow_schema::DeploymentWorkflowDefinition,
    supplied: &BTreeMap<String, super::workflow_schema::ScalarValue>,
) -> Result<BTreeMap<String, super::workflow_schema::ScalarValue>, String> {
    if supplied.keys().any(|id| {
        !definition
            .parameters
            .iter()
            .any(|parameter| &parameter.id == id)
    }) {
        return Err("DEPLOYMENT_WORKFLOW_UNKNOWN_PARAMETER".into());
    }
    let mut resolved = BTreeMap::new();
    for parameter in &definition.parameters {
        let value = supplied
            .get(&parameter.id)
            .cloned()
            .or_else(|| parameter.default_value.clone());
        let Some(value) = value else {
            if parameter.required {
                return Err(format!(
                    "DEPLOYMENT_WORKFLOW_REQUIRED_PARAMETER_MISSING:{}",
                    parameter.id
                ));
            }
            continue;
        };
        let matches = matches!(
            (&parameter.parameter_type, &value),
            (
                super::workflow_schema::WorkflowParameterType::String,
                super::workflow_schema::ScalarValue::String(_)
            ) | (
                super::workflow_schema::WorkflowParameterType::Boolean,
                super::workflow_schema::ScalarValue::Boolean(_)
            ) | (
                super::workflow_schema::WorkflowParameterType::Integer,
                super::workflow_schema::ScalarValue::Integer(_)
            )
        );
        if !matches
            || matches!(&value, super::workflow_schema::ScalarValue::String(value) if value.len() > 1024)
        {
            return Err(format!(
                "DEPLOYMENT_WORKFLOW_PARAMETER_TYPE_MISMATCH:{}",
                parameter.id
            ));
        }
        resolved.insert(parameter.id.clone(), value);
    }
    Ok(resolved)
}

async fn execute_with_retry(
    executors: &DeploymentNodeExecutorRegistry,
    descriptor_registry: &DeploymentNodeRegistry,
    frozen: FrozenNodeInput,
    immutable_plan: Option<ImmutableRunPlan>,
    plan_digest: &str,
    cancellation: CancellationToken,
) -> Result<CompletedNode, String> {
    let executor = executors.get(&frozen.node.type_name, frozen.node.type_version)?;
    executor.validate_config(&frozen.node.config)?;
    let descriptor = descriptor_registry
        .find(&frozen.node.type_name, frozen.node.type_version)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
    let planned = executor.plan(frozen.clone())?;
    if planned.schema_version != EXECUTOR_PLAN_SCHEMA_VERSION
        || planned.node_id != frozen.node.id
        || planned.node_type != frozen.node.type_name
        || planned.node_type_version != frozen.node.type_version
        || planned.fixed_actions != descriptor.fixed_actions
    {
        return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_PLAN_MISMATCH".into());
    }
    let maximum_attempts = if descriptor.retryable {
        u32::from(frozen.node.retry.max_attempts)
    } else {
        1
    };
    let mut attempt = 1_u32;
    loop {
        if cancellation.is_cancelled() {
            return Err("DEPLOYMENT_WORKFLOW_CANCELED".into());
        }
        let verified = VerifiedNodeInput {
            frozen: frozen.clone(),
            planned: planned.clone(),
            immutable_plan: immutable_plan.clone(),
            attempt,
            idempotency_key: idempotency_key(&frozen.run_id, &frozen.node.id, attempt, plan_digest),
        };
        let context = NodeExecutionContext {
            cancellation: cancellation.clone(),
        };
        match executor.execute(verified.clone(), context.clone()).await {
            Ok(result) => {
                return Ok(CompletedNode {
                    node_id: frozen.node.id.clone(),
                    planned,
                    attempt,
                    result,
                })
            }
            Err(failure) if failure.disposition == NodeFailureDisposition::Canceled => {
                return Err("DEPLOYMENT_WORKFLOW_CANCELED".into())
            }
            Err(_failure) if attempt < maximum_attempts => {
                match executor.reconcile(verified, context).await {
                    Ok(NodeReconcileResult::Succeeded(result)) => {
                        return Ok(CompletedNode {
                            node_id: frozen.node.id.clone(),
                            planned,
                            attempt,
                            result: *result,
                        })
                    }
                    Ok(NodeReconcileResult::NotStarted | NodeReconcileResult::SafeToRetry) => {}
                    Ok(NodeReconcileResult::FailedDefinitely(reconciled)) => {
                        return Err(format!(
                            "DEPLOYMENT_WORKFLOW_NODE_FAILED:{}:{}",
                            reconciled.category, reconciled.message
                        ))
                    }
                    Ok(NodeReconcileResult::StateUnknown(reason)) => {
                        return Err(format!("DEPLOYMENT_WORKFLOW_STATE_UNKNOWN:{reason}"))
                    }
                    Err(reconcile_failure) => {
                        return Err(format!(
                            "DEPLOYMENT_WORKFLOW_RECONCILE_FAILED:{}:{}",
                            reconcile_failure.category, reconcile_failure.message
                        ))
                    }
                }
                let backoff = frozen
                    .node
                    .retry
                    .initial_backoff_seconds
                    .saturating_mul(2_u32.saturating_pow(attempt.saturating_sub(1)))
                    .min(frozen.node.retry.max_backoff_seconds);
                if backoff > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(u64::from(backoff))) => {}
                        _ = cancellation.cancelled() => {
                            return Err("DEPLOYMENT_WORKFLOW_CANCELED".into());
                        }
                    }
                }
                attempt = attempt.saturating_add(1);
            }
            Err(failure) => {
                let prefix = if failure.disposition == NodeFailureDisposition::Ambiguous {
                    "DEPLOYMENT_WORKFLOW_STATE_UNKNOWN"
                } else {
                    "DEPLOYMENT_WORKFLOW_NODE_FAILED"
                };
                return Err(format!("{prefix}:{}:{}", failure.category, failure.message));
            }
        }
    }
}

async fn execute_pre_approval(
    run_id: &str,
    definition: &super::workflow_schema::DeploymentWorkflowDefinition,
    compiled: &super::workflow_schema::CompiledRunPlanDraft,
    executors: &DeploymentNodeExecutorRegistry,
    cancellation: CancellationToken,
    rollback_artifact: Option<&ArtifactHandle>,
    progress: Option<&PreparationProgressObserver>,
) -> Result<PreparationState, String> {
    let descriptors = DeploymentNodeRegistry::mvp();
    let nodes = definition
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let approval_id = definition
        .nodes
        .iter()
        .find(|node| node.type_name == "control.approval")
        .map(|node| node.id.clone())
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_APPROVAL_NOT_FOUND".to_string())?;
    let semaphore = Arc::new(Semaphore::new(usize::from(
        definition.policy.max_parallel_local_nodes,
    )));
    let mut outputs = BTreeMap::new();
    let mut completed = Vec::new();
    let mut reused_nodes = Vec::new();
    let total = compiled
        .topology_layers
        .iter()
        .take_while(|layer| !layer.iter().any(|node_id| node_id == &approval_id))
        .flatten()
        .filter(|node_id| {
            nodes.get(*node_id).is_some_and(|node| {
                descriptors
                    .find(&node.type_name, node.type_version)
                    .is_some_and(|descriptor| {
                        !descriptor.is_finalizer && !descriptor.effect_class.requires_approval()
                    })
            })
        })
        .count() as u32;
    let mut completed_count = 0_u32;
    for layer in &compiled.topology_layers {
        if layer.iter().any(|node_id| node_id == &approval_id) {
            break;
        }
        let mut futures = Vec::new();
        for node_id in layer {
            let node = nodes
                .get(node_id)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_PLAN_NODE_MISSING".to_string())?;
            let descriptor = descriptors
                .find(&node.type_name, node.type_version)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
            if descriptor.is_finalizer || descriptor.effect_class.requires_approval() {
                continue;
            }
            if let Some(handle) = rollback_artifact {
                if matches!(
                    node.type_name.as_str(),
                    "source.snapshot"
                        | "build.docker-buildx"
                        | "build.package-script"
                        | "artifact.collect"
                        | "artifact.bundle-compose"
                ) {
                    reused_nodes.push(node.id.clone());
                    continue;
                }
                for binding in node.inputs.values().filter(|binding| {
                    nodes.get(&binding.from_node_id).is_some_and(|producer| {
                        matches!(
                            producer.type_name.as_str(),
                            "artifact.collect" | "artifact.bundle-compose"
                        )
                    })
                }) {
                    outputs.insert(
                        (binding.from_node_id.clone(), binding.from_port.clone()),
                        NodeOutputValue {
                            kind: NodeOutputKind::Artifact,
                            value: serde_json::to_value(handle)
                                .map_err(|error| error.to_string())?,
                            artifact_reference: Some(handle.artifact_reference.clone()),
                        },
                    );
                }
            }
            let mut inputs = node_inputs(node, &outputs)?;
            if let Some(handle) = rollback_artifact.filter(|_| {
                matches!(
                    node.type_name.as_str(),
                    "target.preflight" | "release.create-candidate"
                )
            }) {
                inputs.insert(
                    "bundle".into(),
                    serde_json::to_value(handle).map_err(|error| error.to_string())?,
                );
            }
            let frozen = FrozenNodeInput {
                run_id: run_id.to_string(),
                node: (*node).clone(),
                targets: definition.targets.clone(),
                inputs,
            };
            let executor_registry = executors.clone();
            let descriptor_registry = descriptors.clone();
            let semaphore = semaphore.clone();
            let cancellation = cancellation.clone();
            let local =
                descriptor.execution_domain == super::workflow_schema::ExecutionDomain::Local;
            if let Some(progress) = progress {
                progress(PreparationProgress {
                    run_id: run_id.to_string(),
                    node_id: node.id.clone(),
                    status: "running".into(),
                    completed: completed_count,
                    total,
                });
            }
            let progress_node_id = node.id.clone();
            futures.push(async move {
                let _permit = if local {
                    match semaphore.acquire_owned().await {
                        Ok(permit) => Some(permit),
                        Err(_) => {
                            return (
                                progress_node_id,
                                Err("DEPLOYMENT_WORKFLOW_SCHEDULER_STOPPED".to_string()),
                            )
                        }
                    }
                } else {
                    None
                };
                let result = execute_with_retry(
                    &executor_registry,
                    &descriptor_registry,
                    frozen,
                    None,
                    "sha256:preparation",
                    cancellation,
                )
                .await;
                (progress_node_id, result)
            });
        }
        let results = join_all(futures).await;
        for (progress_node_id, result) in results {
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    if let Some(progress) = progress {
                        progress(PreparationProgress {
                            run_id: run_id.to_string(),
                            node_id: progress_node_id,
                            status: "failed".into(),
                            completed: completed_count,
                            total,
                        });
                    }
                    return Err(error);
                }
            };
            for (name, value) in &result.result.outputs {
                outputs.insert((result.node_id.clone(), name.clone()), value.clone());
            }
            completed_count = completed_count.saturating_add(1);
            if let Some(progress) = progress {
                progress(PreparationProgress {
                    run_id: run_id.to_string(),
                    node_id: result.node_id.clone(),
                    status: "succeeded".into(),
                    completed: completed_count,
                    total,
                });
            }
            completed.push(result);
        }
    }
    if let Some(handle) = rollback_artifact {
        let replacement = NodeOutputValue {
            kind: NodeOutputKind::Artifact,
            value: serde_json::to_value(handle).map_err(|error| error.to_string())?,
            artifact_reference: Some(handle.artifact_reference.clone()),
        };
        let final_bindings = definition
            .nodes
            .iter()
            .filter(|node| {
                matches!(
                    node.type_name.as_str(),
                    "target.preflight" | "release.create-candidate" | "transfer.sftp"
                )
            })
            .filter_map(|node| node.inputs.get("bundle"))
            .map(|binding| (binding.from_node_id.clone(), binding.from_port.clone()))
            .collect::<std::collections::BTreeSet<_>>();
        for binding in final_bindings {
            outputs.insert(binding.clone(), replacement.clone());
            if let Some(completed_node) = completed
                .iter_mut()
                .find(|completed_node| completed_node.node_id == binding.0)
            {
                completed_node
                    .result
                    .outputs
                    .insert(binding.1, replacement.clone());
            }
        }
    }
    Ok(PreparationState {
        outputs,
        completed,
        reused_nodes,
    })
}

fn find_output<'a>(
    state: &'a PreparationState,
    node_type: &str,
    definition: &super::workflow_schema::DeploymentWorkflowDefinition,
    output_name: &str,
) -> Result<&'a Value, String> {
    let node_id = definition
        .nodes
        .iter()
        .find(|node| node.type_name == node_type)
        .map(|node| node.id.as_str())
        .ok_or_else(|| format!("DEPLOYMENT_WORKFLOW_NODE_NOT_FOUND:{node_type}"))?;
    state
        .outputs
        .get(&(node_id.to_string(), output_name.to_string()))
        .map(|output| &output.value)
        .ok_or_else(|| format!("DEPLOYMENT_WORKFLOW_OUTPUT_NOT_FOUND:{node_id}:{output_name}"))
}

fn approval_summary(
    plan: &ImmutableRunPlan,
    definition: &super::workflow_schema::DeploymentWorkflowDefinition,
    artifact_summaries: &[Value],
    preflight: &Value,
) -> Value {
    let effect_nodes = plan
        .compiled
        .nodes
        .iter()
        .filter(|node| node.effect_class.requires_approval())
        .map(|node| {
            serde_json::json!({
                "nodeId": node.node_id,
                "displayName": node.display_name,
                "effectClass": node.effect_class,
                "fixedActions": node.fixed_actions,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schemaVersion": 1,
        "workflowId": plan.workflow_id,
        "workflowRevision": plan.workflow_revision,
        "definitionDigest": plan.definition_digest,
        "runId": plan.run_id,
        "operationKind": plan.operation_kind,
        "triggerKind": plan.trigger_kind,
        "parameters": plan.parameters,
        "planDigest": plan.plan_digest,
        "preparedAt": plan.prepared_at,
        "expiresAt": plan.expires_at,
        "source": plan.source,
        "target": plan.target,
        "preflight": preflight,
        "artifacts": artifact_summaries,
        "currentRelease": plan.current_release,
        "previousRelease": plan.previous_release,
        "targetRelease": plan.target_release,
        "effects": effect_nodes,
        "risks": plan.compiled.risks,
        "compensations": plan.compiled.compensations,
        "verificationNodes": definition.nodes.iter().filter(|node| node.type_name.starts_with("verify.")).map(|node| &node.id).collect::<Vec<_>>(),
        "retention": plan.compiled.policy.releases_to_keep,
        "releaseReview": {
            "automaticRestore": definition.policy.automatic_restore,
            "configuration": definition.nodes.iter().filter(|node| matches!(node.type_name.as_str(),
                "artifact.bundle-compose" | "deploy.compose" | "verify.http"))
                .map(|node| serde_json::json!({"nodeId":node.id,"name":node.display_name,"type":node.type_name,"config":node.config}))
                .collect::<Vec<_>>(),
        },
    })
}

fn persist_output(
    database: &Database,
    run_id: &str,
    node_id: &str,
    output_name: &str,
    output: &NodeOutputValue,
    now: i64,
) -> Result<(), String> {
    database.record_deployment_run_output(&DeploymentRunOutputWrite {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
        output_name: output_name.to_string(),
        output_kind: output_kind(output.kind),
        value: output.value.clone(),
        artifact_reference: output.artifact_reference.clone(),
        created_at: now,
    })?;
    Ok(())
}

fn record_artifact(
    database: &Database,
    cas: &DeploymentArtifactCas,
    handle: &ArtifactHandle,
    created_at: i64,
) -> Result<(), String> {
    let projection = cas.inspect(handle)?;
    let manifest_json = String::from_utf8(
        super::canonicalization::canonical_json_bytes(&projection.manifest)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|_| "deployment artifact manifest is not UTF-8".to_string())?;
    database.record_verified_deployment_artifact(&DeploymentArtifactWrite {
        artifact_reference: handle.artifact_reference.clone(),
        manifest_digest: handle.manifest_digest.clone(),
        content_digest: handle.content_digest.clone(),
        artifact_type: projection.manifest.artifact_type,
        manifest_json,
        component_count: projection.component_count,
        total_size: projection.total_size,
        created_at,
        verified_at: created_at,
    })
}

pub(crate) async fn prepare_run_observed(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    request: PrepareRunRequest,
    rollback_release_id: Option<String>,
    observer: PreparationProgressObserver,
) -> Result<PreparedRun, String> {
    prepare_run_internal(
        database,
        runtime,
        executors,
        request,
        rollback_release_id,
        Some(observer),
    )
    .await
}

async fn prepare_run_internal(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    request: PrepareRunRequest,
    rollback_release_id: Option<String>,
    progress: Option<PreparationProgressObserver>,
) -> Result<PreparedRun, String> {
    if (request.operation_kind == WorkflowRunOperationKind::Rollback)
        != rollback_release_id.is_some()
    {
        return Err("DEPLOYMENT_WORKFLOW_ROLLBACK_RELEASE_REQUIRED".into());
    }
    let workflow = database
        .get_deployment_workflow_revision(&request.workflow_id, request.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    if !workflow.enabled || workflow.archived {
        return Err("DEPLOYMENT_WORKFLOW_NOT_EXECUTABLE".into());
    }
    let descriptors = DeploymentNodeRegistry::mvp();
    let compiled = compile_workflow_definition(&workflow.definition, &descriptors)
        .map_err(|error| error.to_string())?;
    if compiled.definition_digest != workflow.definition_digest {
        return Err("DEPLOYMENT_WORKFLOW_DEFINITION_DIGEST_MISMATCH".into());
    }
    let parameters = resolve_parameters(&workflow.definition, &request.parameters)?;
    executors.validate_against_registry(
        &descriptors,
        workflow
            .definition
            .nodes
            .iter()
            .map(|node| (node.type_name.clone(), node.type_version)),
    )?;
    let rollback_release = rollback_release_id
        .as_deref()
        .map(|release_id| {
            database
                .get_deployment_release(&workflow.id, release_id)?
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_ROLLBACK_RELEASE_NOT_FOUND".to_string())
        })
        .transpose()?;
    if rollback_release
        .as_ref()
        .is_some_and(|release| !release.rollbackable || release.position != "previous")
    {
        return Err("DEPLOYMENT_WORKFLOW_RELEASE_NOT_ROLLBACKABLE".into());
    }
    let rollback_handle = rollback_release
        .as_ref()
        .map(|release| {
            database
                .get_deployment_artifact_handle(&release.artifact_reference)?
                .ok_or_else(|| "DEPLOYMENT_ARTIFACT_NOT_FOUND".to_string())
        })
        .transpose()?;
    let rollback_projection = rollback_handle
        .as_ref()
        .map(|handle| runtime.artifacts().inspect(handle))
        .transpose()?;
    if let Some(handle) = &rollback_handle {
        let projection = rollback_projection
            .as_ref()
            .ok_or("DEPLOYMENT_ARTIFACT_NOT_FOUND")?;
        let has_host_manifest = projection
            .manifest
            .components
            .iter()
            .any(|item| item.name == "config-host.json");
        let bundle_node = workflow
            .definition
            .nodes
            .iter()
            .find(|node| node.type_name == "artifact.bundle-compose");
        let configured_host = bundle_node
            .and_then(|node| node.config.get("hostCompose"))
            .is_some_and(|value| !value.is_null());
        if has_host_manifest || configured_host {
            let config: super::compose_release::BundleComposeConfig = serde_json::from_value(
                bundle_node
                    .ok_or("DEPLOYMENT_WORKFLOW_ROLLBACK_CONFIG_MISMATCH")?
                    .config
                    .clone(),
            )
            .map_err(|_| "DEPLOYMENT_WORKFLOW_ROLLBACK_CONFIG_MISMATCH")?;
            let path = runtime
                .artifacts()
                .verified_component_path(handle, "config-host.json")?;
            let host: super::host_compose::HostBundle = serde_json::from_slice(
                &std::fs::read(path).map_err(|_| "DEPLOYMENT_ARTIFACT_NOT_FOUND")?,
            )
            .map_err(|_| "DEPLOYMENT_WORKFLOW_ROLLBACK_CONFIG_MISMATCH")?;
            if !host.matches_config(&config) {
                return Err("DEPLOYMENT_WORKFLOW_ROLLBACK_CONFIG_MISMATCH".into());
            }
        }
    }
    let run_id = request.run_id;
    super::node_registry::validate_identifier("runId", &run_id)?;
    let cancellation = runtime.register_run_cancellation(&run_id)?;
    let preparation_result = execute_pre_approval(
        &run_id,
        &workflow.definition,
        &compiled,
        executors,
        cancellation,
        rollback_handle.as_ref(),
        progress.as_ref(),
    )
    .await;
    runtime.finish_run(&run_id);
    let preparation = preparation_result?;
    let mut source = if let Some(projection) = &rollback_projection {
        FrozenSourceSnapshot {
            changed_files: Vec::new(),
            binding: None,
            source_ref: format!("release:{}", rollback_release.as_ref().unwrap().release_id),
            revision: projection.manifest.source.revision.clone(),
            dirty: projection.manifest.source.dirty,
            snapshot_digest: projection.manifest.source.snapshot_digest.clone(),
            metadata_digest: canonical_sha256(&projection.manifest.source)
                .map_err(|error| error.to_string())?,
        }
    } else {
        parse_source(find_output(
            &preparation,
            "source.snapshot",
            &workflow.definition,
            "source",
        )?)?
    };
    let target_output = find_output(
        &preparation,
        "target.preflight",
        &workflow.definition,
        "target",
    )?;
    let target = parse_target(target_output.get("identity").unwrap_or(target_output))?;
    let candidate = find_output(
        &preparation,
        "release.create-candidate",
        &workflow.definition,
        "candidate",
    )?;
    let target_release = candidate
        .get("targetRelease")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_CANDIDATE_RELEASE_MISSING".to_string())
        .and_then(parse_release)?;
    let current_release = candidate
        .get("currentRelease")
        .filter(|value| !value.is_null())
        .map(parse_release)
        .transpose()?;
    let previous_release = candidate
        .get("previousRelease")
        .filter(|value| !value.is_null())
        .map(parse_release)
        .transpose()?;
    if let Some(release) = &rollback_release {
        let identity = release
            .identity
            .as_ref()
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_ROLLBACK_IDENTITY_MISSING".to_string())?;
        if &target_release != identity {
            return Err("DEPLOYMENT_WORKFLOW_ROLLBACK_RELEASE_DRIFT".into());
        }
        let known_current = database
            .list_deployment_releases(&workflow.id)?
            .into_iter()
            .find(|item| item.position == "current");
        if current_release
            .as_ref()
            .map(|item| item.release_id.as_str())
            != known_current.as_ref().map(|item| item.release_id.as_str())
        {
            return Err("DEPLOYMENT_WORKFLOW_TARGET_RELEASE_DRIFT".into());
        }
        let projection = rollback_projection
            .as_ref()
            .ok_or_else(|| "DEPLOYMENT_ARTIFACT_NOT_FOUND".to_string())?;
        source = FrozenSourceSnapshot {
            changed_files: Vec::new(),
            binding: None,
            source_ref: format!("release:{}", release.release_id),
            revision: projection.manifest.source.revision.clone(),
            dirty: projection.manifest.source.dirty,
            snapshot_digest: projection.manifest.source.snapshot_digest.clone(),
            metadata_digest: canonical_sha256(&projection.manifest.source)
                .map_err(|error| error.to_string())?,
        };
    }
    let mut produced_artifacts = Vec::new();
    for output in preparation.outputs.values() {
        if output.kind == NodeOutputKind::Artifact {
            let handle = parse_artifact_handle(&output.value)?;
            if !produced_artifacts.contains(&handle) {
                produced_artifacts.push(handle);
            }
        }
    }
    let artifacts = rollback_handle
        .clone()
        .map(|handle| vec![handle])
        .unwrap_or_else(|| produced_artifacts.clone());
    if artifacts.is_empty() {
        return Err("DEPLOYMENT_WORKFLOW_PREPARATION_PRODUCED_NO_ARTIFACT".into());
    }
    let executor_versions = preparation
        .completed
        .iter()
        .map(|completed| {
            (
                completed.node_id.clone(),
                completed.planned.executor_version.clone(),
            )
        })
        .chain(workflow.definition.nodes.iter().filter_map(|node| {
            executors
                .get(&node.type_name, node.type_version)
                .ok()
                .map(|executor| (node.id.clone(), executor.executor_version().to_string()))
        }))
        .collect::<BTreeMap<_, _>>();
    let prepared_at = current_timestamp_ms();
    let expires_at = prepared_at
        .checked_add(PLAN_TTL_MS)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_PLAN_EXPIRY_OVERFLOW".to_string())?;
    let mut immutable = ImmutableRunPlan {
        schema_version: 1,
        workflow_id: workflow.id.clone(),
        workflow_revision: workflow.revision,
        run_id: run_id.clone(),
        operation_kind: request.operation_kind,
        trigger_kind: request.trigger_kind,
        definition_digest: workflow.definition_digest.clone(),
        parameters,
        source,
        target,
        artifacts: artifacts.clone(),
        current_release,
        previous_release,
        target_release,
        executor_versions,
        compiled,
        prepared_at,
        expires_at,
        plan_digest: String::new(),
    };
    immutable.plan_digest = plan_digest(&immutable)?;
    let artifact_summaries = artifacts
        .iter()
        .map(|handle| {
            let projection = runtime.artifacts().inspect(handle)?;
            Ok::<_, String>(serde_json::json!({
                "handle": handle,
                "artifactType": projection.manifest.artifact_type,
                "components": projection.manifest.components,
                "componentCount": projection.component_count,
                "totalSize": projection.total_size,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let summary = approval_summary(
        &immutable,
        &workflow.definition,
        &artifact_summaries,
        target_output,
    );
    if serde_json::to_vec(&summary)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_APPROVAL_SUMMARY_BYTES
    {
        return Err("DEPLOYMENT_WORKFLOW_APPROVAL_SUMMARY_TOO_LARGE".into());
    }
    let plan_value = serde_json::to_value(&immutable).map_err(|error| error.to_string())?;
    if serde_json::to_vec(&plan_value)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_IMMUTABLE_PLAN_BYTES
    {
        return Err("DEPLOYMENT_WORKFLOW_IMMUTABLE_PLAN_TOO_LARGE".into());
    }
    let seeds = workflow
        .definition
        .nodes
        .iter()
        .map(|node| DeploymentRunNodeSeed {
            node_id: node.id.clone(),
            node_type: node.type_name.clone(),
            node_type_version: node.type_version,
        })
        .collect::<Vec<_>>();
    database.create_deployment_run(
        &DeploymentRunWrite {
            id: run_id.clone(),
            workflow_id: workflow.id.clone(),
            workflow_revision: workflow.revision,
            operation_kind: request.operation_kind,
            trigger_kind: request.trigger_kind,
            definition_digest: workflow.definition_digest,
            plan_digest: immutable.plan_digest.clone(),
            plan: plan_value,
            approval_summary: Some(summary.clone()),
            created_at: prepared_at,
        },
        &seeds,
    )?;
    for handle in &produced_artifacts {
        record_artifact(database, runtime.artifacts(), handle, prepared_at)?;
    }
    for node_id in &preparation.reused_nodes {
        database.transition_deployment_run_node(
            &run_id,
            node_id,
            DeploymentRunNodeStatus::Pending,
            DeploymentRunNodeStatus::Skipped,
            Some(&serde_json::json!({"reason":"historicalBundleReused"})),
            "deployment.node.skipped",
            None,
            None,
            Some(prepared_at),
            prepared_at,
        )?;
        for ((producer, name), output) in &preparation.outputs {
            if producer == node_id {
                persist_output(database, &run_id, node_id, name, output, prepared_at)?;
            }
        }
    }
    for completed in &preparation.completed {
        database.transition_deployment_run_node(
            &run_id,
            &completed.node_id,
            DeploymentRunNodeStatus::Pending,
            DeploymentRunNodeStatus::Ready,
            None,
            "deployment.node.ready",
            None,
            None,
            None,
            prepared_at,
        )?;
        database.transition_deployment_run_node(
            &run_id,
            &completed.node_id,
            DeploymentRunNodeStatus::Ready,
            DeploymentRunNodeStatus::Running,
            None,
            "deployment.node.running",
            None,
            Some(prepared_at),
            None,
            prepared_at,
        )?;
        for attempt in 1..=completed.attempt {
            database.create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
                run_id: run_id.clone(),
                node_id: completed.node_id.clone(),
                attempt,
                node_type: completed.planned.node_type.clone(),
                node_type_version: completed.planned.node_type_version,
                executor_version: completed.planned.executor_version.clone(),
                idempotency_key: idempotency_key(
                    &run_id,
                    &completed.node_id,
                    attempt,
                    &immutable.plan_digest,
                ),
                created_at: prepared_at,
            })?;
            database.transition_deployment_node_attempt(
                &run_id,
                &completed.node_id,
                attempt,
                NodeAttemptStatus::Pending,
                NodeAttemptStatus::Running,
                None,
                Some(prepared_at),
                None,
                prepared_at,
            )?;
            if attempt < completed.attempt {
                database.transition_deployment_node_attempt(
                    &run_id,
                    &completed.node_id,
                    attempt,
                    NodeAttemptStatus::Running,
                    NodeAttemptStatus::Failed,
                    Some("retryable"),
                    None,
                    Some(prepared_at),
                    prepared_at,
                )?;
            }
        }
        for (name, output) in &completed.result.outputs {
            persist_output(
                database,
                &run_id,
                &completed.node_id,
                name,
                output,
                prepared_at,
            )?;
        }
        database.transition_deployment_node_attempt(
            &run_id,
            &completed.node_id,
            completed.attempt,
            NodeAttemptStatus::Running,
            NodeAttemptStatus::Succeeded,
            None,
            None,
            Some(prepared_at),
            prepared_at,
        )?;
        database.transition_deployment_run_node(
            &run_id,
            &completed.node_id,
            DeploymentRunNodeStatus::Running,
            DeploymentRunNodeStatus::Succeeded,
            Some(&completed.result.summary),
            "deployment.node.succeeded",
            None,
            None,
            Some(prepared_at),
            prepared_at,
        )?;
    }
    for (index, handle) in artifacts.iter().enumerate() {
        runtime.artifacts().acquire_lease(&run_id, handle)?;
        database.add_deployment_artifact_ref(&DeploymentArtifactRefWrite {
            id: format!("artifact-ref-{run_id}-{index}"),
            artifact_reference: handle.artifact_reference.clone(),
            workflow_id: Some(workflow.id.clone()),
            run_id: Some(run_id.clone()),
            node_id: None,
            ref_kind: DeploymentArtifactRefKind::Run,
            owner_id: run_id.clone(),
            lease_active: true,
            retain_until: Some(expires_at),
            created_at: prepared_at,
        })?;
    }
    let approval_node = workflow
        .definition
        .nodes
        .iter()
        .find(|node| node.type_name == "control.approval")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_APPROVAL_NOT_FOUND".to_string())?;
    database.transition_deployment_run_node(
        &run_id,
        &approval_node.id,
        DeploymentRunNodeStatus::Pending,
        DeploymentRunNodeStatus::AwaitingApproval,
        None,
        "deployment.node.awaitingApproval",
        None,
        None,
        None,
        prepared_at,
    )?;
    database.transition_deployment_run(
        &run_id,
        DeploymentRunStatus::Planned,
        DeploymentRunStatus::AwaitingApproval,
        Some(&summary),
        "deployment.run.awaitingApproval",
        Some(&serde_json::json!({ "planDigest": immutable.plan_digest, "expiresAt": expires_at })),
        None,
        None,
        prepared_at,
    )?;
    Ok(PreparedRun {
        run_id,
        plan_digest: immutable.plan_digest,
        expires_at,
    })
}

fn load_and_verify_plan(
    database: &Database,
    run_id: &str,
    expected_digest: &str,
) -> Result<(DeploymentRunRecord, ImmutableRunPlan), String> {
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
    if run.plan_digest != expected_digest {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_DIGEST_MISMATCH".into());
    }
    let plan: ImmutableRunPlan = serde_json::from_value(run.plan.clone())
        .map_err(|_| "DEPLOYMENT_WORKFLOW_STORED_PLAN_INVALID".to_string())?;
    if plan.plan_digest != expected_digest || plan_digest(&plan)? != expected_digest {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_INTEGRITY_FAILURE".into());
    }
    Ok((run, plan))
}

fn ensure_workflow_head_matches_plan(
    database: &Database,
    run: &DeploymentRunRecord,
    plan: &ImmutableRunPlan,
) -> Result<(), String> {
    let head = database
        .get_deployment_workflow(&run.workflow_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_WORKFLOW_NOT_FOUND".to_string())?;
    if head.archived
        || !head.enabled
        || head.revision != run.workflow_revision
        || head.definition_digest != plan.definition_digest
    {
        return Err("DEPLOYMENT_WORKFLOW_WORKFLOW_DRIFT".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryBoundaryState {
    NotStarted,
    InProgress,
    Completed,
    Compensated,
    EvidenceIncomplete,
}

fn recovery_boundary_state(status: &str) -> RecoveryBoundaryState {
    match status {
        "pending" | "ready" => RecoveryBoundaryState::NotStarted,
        "running" | "cancel_requested" | "state_unknown" | "compensating" => {
            RecoveryBoundaryState::InProgress
        }
        "succeeded" => RecoveryBoundaryState::Completed,
        "compensated" => RecoveryBoundaryState::Compensated,
        _ => RecoveryBoundaryState::EvidenceIncomplete,
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

fn ensure_frozen_plan_integrity(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    run: &DeploymentRunRecord,
    plan: &ImmutableRunPlan,
) -> Result<(), String> {
    ensure_frozen_plan_integrity_for_mode(database, runtime, run, plan, false)
}

fn supports_reconciliation_version(version: &str) -> bool {
    matches!(version, "docker-compose/1" | "docker-compose/2")
}

fn ensure_frozen_plan_integrity_for_mode(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    run: &DeploymentRunRecord,
    plan: &ImmutableRunPlan,
    reconciliation: bool,
) -> Result<(), String> {
    if plan.plan_digest != run.plan_digest || plan_digest(plan)? != run.plan_digest {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_INTEGRITY_FAILURE".into());
    }
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    if workflow.definition_digest != run.definition_digest
        || workflow.definition_digest != plan.definition_digest
        || workflow.revision != plan.workflow_revision
    {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_DEFINITION_DRIFT".into());
    }
    let target = workflow
        .definition
        .targets
        .iter()
        .find(|target| target.id == plan.target.target_id)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_TARGET_DRIFT".to_string())?;
    if target.connection_profile_id != plan.target.connection_profile_id
        || target.remote_root != plan.target.remote_root
    {
        return Err("DEPLOYMENT_WORKFLOW_TARGET_DRIFT".into());
    }
    let profile = database
        .get_profile(&plan.target.connection_profile_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_TARGET_DRIFT".to_string())?;
    let host_identity_digest = canonical_sha256(&serde_json::json!({
        "profileId": profile.id,
        "host": profile.host,
        "port": profile.port,
        "username": profile.username,
        "authMethod": profile.auth_method.as_str(),
        "jumpHost": profile.jump_host_config,
    }))
    .map_err(|error| error.to_string())?;
    if profile.updated_at != plan.target.profile_revision
        || host_identity_digest != plan.target.host_identity_digest
    {
        return Err("DEPLOYMENT_WORKFLOW_TARGET_DRIFT".into());
    }
    for handle in &plan.artifacts {
        runtime
            .artifacts()
            .inspect(handle)
            .map_err(|_| "DEPLOYMENT_WORKFLOW_ARTIFACT_DRIFT".to_string())?;
    }
    if !plan
        .artifacts
        .iter()
        .any(|handle| handle.content_digest == plan.target_release.artifact_content_digest)
    {
        return Err("DEPLOYMENT_WORKFLOW_ARTIFACT_DRIFT".into());
    }
    if plan.executor_versions.len() != workflow.definition.nodes.len()
        || workflow.definition.nodes.iter().any(|node| {
            plan.executor_versions.get(&node.id).is_none_or(|version| {
                version != DOCKER_COMPOSE_EXECUTOR_VERSION
                    && !(reconciliation && supports_reconciliation_version(version))
            })
        })
        || plan.compiled.nodes.iter().any(|compiled| {
            workflow
                .definition
                .nodes
                .iter()
                .find(|node| node.id == compiled.node_id)
                .is_none_or(|node| {
                    node.type_name != compiled.node_type
                        || node.type_version != compiled.node_type_version
                })
        })
    {
        return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_VERSION_DRIFT".into());
    }
    Ok(())
}

fn receipt_is_bound(
    receipt: &super::workflow_schema::EffectReceipt,
    plan: &ImmutableRunPlan,
    node_id: &str,
    attempt: u32,
) -> bool {
    receipt.schema_version == 1
        && receipt.run_id == plan.run_id
        && receipt.node_id == node_id
        && receipt.attempt == attempt
        && receipt.target_id == plan.target.target_id
        && receipt.plan_digest == plan.plan_digest
        && valid_digest(&receipt.payload_digest)
}

fn mark_integrity_unknown(
    database: &Database,
    run: &DeploymentRunRecord,
    failure: &str,
) -> Result<ReconciliationProjection, String> {
    if run.status != DeploymentRunStatus::StateUnknown {
        let now = current_timestamp_ms();
        database.transition_deployment_run(
            &run.id,
            run.status,
            DeploymentRunStatus::StateUnknown,
            None,
            "deployment.run.integrityUnknown",
            Some(&serde_json::json!({
                "failureCode": safe_failure_code(failure),
                "requiresReadOnlyReconciliation": true,
            })),
            None,
            None,
            now,
        )?;
    }
    Ok(ReconciliationProjection {
        run_id: run.id.clone(),
        status: DeploymentRunStatus::StateUnknown.as_str().to_string(),
        evidence_complete: false,
    })
}

pub(crate) fn approve_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    run_id: &str,
    plan_digest: &str,
) -> Result<RunProjection, String> {
    let (run, plan) = load_and_verify_plan(database, run_id, plan_digest)?;
    if run.status != DeploymentRunStatus::AwaitingApproval {
        return Err("DEPLOYMENT_WORKFLOW_RUN_NOT_AWAITING_APPROVAL".into());
    }
    let now = current_timestamp_ms();
    ensure_plan_unexpired(plan.expires_at)?;
    ensure_frozen_plan_integrity(database, runtime, &run, &plan)?;
    ensure_workflow_head_matches_plan(database, &run, &plan)?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    if workflow.definition_digest != plan.definition_digest {
        return Err("DEPLOYMENT_WORKFLOW_WORKFLOW_DRIFT".into());
    }
    let approval_node = workflow
        .definition
        .nodes
        .iter()
        .find(|node| node.type_name == "control.approval")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_APPROVAL_NOT_FOUND".to_string())?;
    let executor_version = plan
        .executor_versions
        .get(&approval_node.id)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_VERSION_MISSING".to_string())?;
    database.create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
        run_id: run_id.to_string(),
        node_id: approval_node.id.clone(),
        attempt: 1,
        node_type: approval_node.type_name.clone(),
        node_type_version: approval_node.type_version,
        executor_version: executor_version.clone(),
        idempotency_key: idempotency_key(run_id, &approval_node.id, 1, plan_digest),
        created_at: now,
    })?;
    database.transition_deployment_node_attempt(
        run_id,
        &approval_node.id,
        1,
        NodeAttemptStatus::Pending,
        NodeAttemptStatus::Running,
        None,
        Some(now),
        None,
        now,
    )?;
    let approval = serde_json::json!({
        "schemaVersion": 1,
        "runId": run_id,
        "planDigest": plan_digest,
        "approvedAt": now,
        "expiresAt": plan.expires_at,
    });
    persist_output(
        database,
        run_id,
        &approval_node.id,
        "approval",
        &NodeOutputValue {
            kind: NodeOutputKind::Receipt,
            value: approval,
            artifact_reference: None,
        },
        now,
    )?;
    database.transition_deployment_node_attempt(
        run_id,
        &approval_node.id,
        1,
        NodeAttemptStatus::Running,
        NodeAttemptStatus::Succeeded,
        None,
        None,
        Some(now),
        now,
    )?;
    database.transition_deployment_run_node(
        run_id,
        &approval_node.id,
        DeploymentRunNodeStatus::AwaitingApproval,
        DeploymentRunNodeStatus::Succeeded,
        Some(&serde_json::json!({ "planDigest": plan_digest })),
        "deployment.node.approved",
        None,
        Some(now),
        Some(now),
        now,
    )?;
    database.transition_deployment_run(
        run_id,
        DeploymentRunStatus::AwaitingApproval,
        DeploymentRunStatus::Approved,
        None,
        "deployment.run.approved",
        Some(&serde_json::json!({ "planDigest": plan_digest, "approvedAt": now })),
        None,
        None,
        now,
    )?;
    Ok(RunProjection {
        run_id: run_id.to_string(),
        status: DeploymentRunStatus::Approved.as_str().to_string(),
        plan_digest: plan_digest.to_string(),
    })
}

fn load_outputs(
    database: &Database,
    run_id: &str,
) -> Result<BTreeMap<(String, String), NodeOutputValue>, String> {
    database
        .list_deployment_run_outputs(run_id)?
        .into_iter()
        .map(|output| {
            let kind = match output.output_kind {
                DeploymentRunOutputKind::Scalar => NodeOutputKind::Scalar,
                DeploymentRunOutputKind::Artifact => NodeOutputKind::Artifact,
                DeploymentRunOutputKind::Receipt => NodeOutputKind::Receipt,
                DeploymentRunOutputKind::Evidence => NodeOutputKind::Evidence,
            };
            Ok((
                (output.node_id, output.output_name),
                NodeOutputValue {
                    kind,
                    value: output.value,
                    artifact_reference: output.artifact_reference,
                },
            ))
        })
        .collect()
}

async fn persist_and_execute_node(
    database: &Database,
    executors: &DeploymentNodeExecutorRegistry,
    descriptors: &DeploymentNodeRegistry,
    plan: &ImmutableRunPlan,
    node: &super::workflow_schema::WorkflowNodeDefinition,
    inputs: BTreeMap<String, Value>,
    cancellation: CancellationToken,
) -> Result<CompletedNode, String> {
    let now = current_timestamp_ms();
    database.transition_deployment_run_node(
        &plan.run_id,
        &node.id,
        DeploymentRunNodeStatus::Pending,
        DeploymentRunNodeStatus::Ready,
        None,
        "deployment.node.ready",
        None,
        None,
        None,
        now,
    )?;
    let executor = executors.get(&node.type_name, node.type_version)?;
    executor.validate_config(&node.config)?;
    let frozen = FrozenNodeInput {
        run_id: plan.run_id.clone(),
        node: node.clone(),
        targets: vec![super::workflow_schema::DeploymentTargetDefinition {
            id: plan.target.target_id.clone(),
            connection_profile_id: plan.target.connection_profile_id.clone(),
            remote_root: plan.target.remote_root.clone(),
        }],
        inputs,
    };
    let planned = executor.plan(frozen.clone())?;
    if plan.executor_versions.get(&node.id) != Some(&planned.executor_version) {
        return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_VERSION_DRIFT".into());
    }
    let descriptor = descriptors
        .find(&node.type_name, node.type_version)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
    let max_attempts = if descriptor.retryable {
        u32::from(node.retry.max_attempts)
    } else {
        1
    };
    let mut attempt = 1_u32;
    loop {
        let started_at = current_timestamp_ms();
        let attempt_key = idempotency_key(&plan.run_id, &node.id, attempt, &plan.plan_digest);
        database.create_deployment_node_attempt(&DeploymentNodeAttemptWrite {
            run_id: plan.run_id.clone(),
            node_id: node.id.clone(),
            attempt,
            node_type: node.type_name.clone(),
            node_type_version: node.type_version,
            executor_version: planned.executor_version.clone(),
            idempotency_key: attempt_key.clone(),
            created_at: started_at,
        })?;
        database.transition_deployment_node_attempt(
            &plan.run_id,
            &node.id,
            attempt,
            NodeAttemptStatus::Pending,
            NodeAttemptStatus::Running,
            None,
            Some(started_at),
            None,
            started_at,
        )?;
        if attempt == 1 {
            database.transition_deployment_run_node(
                &plan.run_id,
                &node.id,
                DeploymentRunNodeStatus::Ready,
                DeploymentRunNodeStatus::Running,
                None,
                "deployment.node.running",
                None,
                Some(started_at),
                None,
                started_at,
            )?;
        }
        let verified = VerifiedNodeInput {
            frozen: frozen.clone(),
            planned: planned.clone(),
            immutable_plan: Some(plan.clone()),
            attempt,
            idempotency_key: attempt_key,
        };
        let context = NodeExecutionContext {
            cancellation: cancellation.clone(),
        };
        let execution = executor.execute(verified.clone(), context.clone()).await;
        match execution {
            Ok(result) => {
                let finished_at = current_timestamp_ms();
                for (name, output) in &result.outputs {
                    persist_output(database, &plan.run_id, &node.id, name, output, finished_at)?;
                }
                if let Some(receipt) = &result.receipt {
                    database.record_deployment_effect_receipt(receipt, finished_at)?;
                }
                database.transition_deployment_node_attempt(
                    &plan.run_id,
                    &node.id,
                    attempt,
                    NodeAttemptStatus::Running,
                    NodeAttemptStatus::Succeeded,
                    None,
                    None,
                    Some(finished_at),
                    finished_at,
                )?;
                database.transition_deployment_run_node(
                    &plan.run_id,
                    &node.id,
                    DeploymentRunNodeStatus::Running,
                    DeploymentRunNodeStatus::Succeeded,
                    Some(&result.summary),
                    "deployment.node.succeeded",
                    None,
                    None,
                    Some(finished_at),
                    finished_at,
                )?;
                return Ok(CompletedNode {
                    node_id: node.id.clone(),
                    planned,
                    attempt,
                    result,
                });
            }
            Err(failure) => {
                let failed_at = current_timestamp_ms();
                let attempt_status = if failure.disposition == NodeFailureDisposition::Canceled {
                    NodeAttemptStatus::Canceled
                } else if failure.disposition == NodeFailureDisposition::Ambiguous {
                    NodeAttemptStatus::StateUnknown
                } else {
                    NodeAttemptStatus::Failed
                };
                database.transition_deployment_node_attempt(
                    &plan.run_id,
                    &node.id,
                    attempt,
                    NodeAttemptStatus::Running,
                    attempt_status,
                    Some(&failure.category),
                    None,
                    Some(failed_at),
                    failed_at,
                )?;
                if failure.disposition == NodeFailureDisposition::Canceled {
                    database.transition_deployment_run_node(
                        &plan.run_id,
                        &node.id,
                        DeploymentRunNodeStatus::Running,
                        DeploymentRunNodeStatus::Canceled,
                        None,
                        "deployment.node.canceled",
                        None,
                        None,
                        Some(failed_at),
                        failed_at,
                    )?;
                    return Err("DEPLOYMENT_WORKFLOW_CANCELED".into());
                }
                if failure.disposition == NodeFailureDisposition::Ambiguous {
                    database.transition_deployment_run_node(
                        &plan.run_id,
                        &node.id,
                        DeploymentRunNodeStatus::Running,
                        DeploymentRunNodeStatus::StateUnknown,
                        None,
                        "deployment.node.stateUnknown",
                        None,
                        None,
                        Some(failed_at),
                        failed_at,
                    )?;
                    return Err(format!(
                        "DEPLOYMENT_WORKFLOW_STATE_UNKNOWN:{}",
                        failure.message
                    ));
                }
                if attempt >= max_attempts {
                    database.transition_deployment_run_node(
                        &plan.run_id,
                        &node.id,
                        DeploymentRunNodeStatus::Running,
                        DeploymentRunNodeStatus::Failed,
                        None,
                        "deployment.node.failed",
                        Some(&serde_json::json!({ "category": failure.category })),
                        None,
                        Some(failed_at),
                        failed_at,
                    )?;
                    return Err(format!(
                        "DEPLOYMENT_WORKFLOW_NODE_FAILED:{}:{}",
                        failure.category, failure.message
                    ));
                }
                match executor.reconcile(verified, context).await {
                    Ok(NodeReconcileResult::Succeeded(result)) => {
                        let finished_at = current_timestamp_ms();
                        for (name, output) in &result.outputs {
                            persist_output(
                                database,
                                &plan.run_id,
                                &node.id,
                                name,
                                output,
                                finished_at,
                            )?;
                        }
                        if let Some(receipt) = &result.receipt {
                            database.record_deployment_effect_receipt(receipt, finished_at)?;
                        }
                        database.transition_deployment_run_node(
                            &plan.run_id,
                            &node.id,
                            DeploymentRunNodeStatus::Running,
                            DeploymentRunNodeStatus::Succeeded,
                            Some(&result.summary),
                            "deployment.node.reconciledSucceeded",
                            None,
                            None,
                            Some(finished_at),
                            finished_at,
                        )?;
                        return Ok(CompletedNode {
                            node_id: node.id.clone(),
                            planned,
                            attempt,
                            result: *result,
                        });
                    }
                    Ok(NodeReconcileResult::NotStarted | NodeReconcileResult::SafeToRetry) => {}
                    Ok(NodeReconcileResult::FailedDefinitely(reconciled)) => {
                        return Err(format!(
                            "DEPLOYMENT_WORKFLOW_NODE_FAILED:{}:{}",
                            reconciled.category, reconciled.message
                        ))
                    }
                    Ok(NodeReconcileResult::StateUnknown(reason)) => {
                        return Err(format!("DEPLOYMENT_WORKFLOW_STATE_UNKNOWN:{reason}"))
                    }
                    Err(error) => {
                        return Err(format!(
                            "DEPLOYMENT_WORKFLOW_STATE_UNKNOWN:{}",
                            error.message
                        ))
                    }
                }
                let backoff = node
                    .retry
                    .initial_backoff_seconds
                    .saturating_mul(2_u32.saturating_pow(attempt.saturating_sub(1)))
                    .min(node.retry.max_backoff_seconds);
                if backoff > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(u64::from(backoff))) => {}
                        _ = cancellation.cancelled() => return Err("DEPLOYMENT_WORKFLOW_CANCELED".into()),
                    }
                }
                attempt = attempt.saturating_add(1);
            }
        }
    }
}

async fn compensate_completed(
    database: &Database,
    executors: &DeploymentNodeExecutorRegistry,
    plan: &ImmutableRunPlan,
    definition: &super::workflow_schema::DeploymentWorkflowDefinition,
    completed: &[CompletedNode],
    cancellation: CancellationToken,
) -> Result<bool, String> {
    let compensations = plan
        .compiled
        .compensations
        .iter()
        .map(|compensation| (compensation.node_id.as_str(), compensation))
        .collect::<BTreeMap<_, _>>();
    let node_map = definition
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let frozen_verification = definition
        .nodes
        .iter()
        .find(|node| node.type_name == "verify.http")
        .cloned();
    let mut complete = true;
    for completed in completed.iter().rev() {
        let Some(compensation) = compensations.get(completed.node_id.as_str()) else {
            continue;
        };
        let Some(node) = node_map.get(completed.node_id.as_str()) else {
            complete = false;
            continue;
        };
        let executor = executors.get(&node.type_name, node.type_version)?;
        let now = current_timestamp_ms();
        database.transition_deployment_run_node(
            &plan.run_id,
            &node.id,
            DeploymentRunNodeStatus::Succeeded,
            DeploymentRunNodeStatus::Compensating,
            None,
            "deployment.node.compensating",
            None,
            None,
            None,
            now,
        )?;
        let frozen = FrozenNodeInput {
            run_id: plan.run_id.clone(),
            node: (*node).clone(),
            targets: vec![super::workflow_schema::DeploymentTargetDefinition {
                id: plan.target.target_id.clone(),
                connection_profile_id: plan.target.connection_profile_id.clone(),
                remote_root: plan.target.remote_root.clone(),
            }],
            inputs: BTreeMap::new(),
        };
        let verified = VerifiedNodeInput {
            frozen,
            planned: completed.planned.clone(),
            immutable_plan: Some(plan.clone()),
            attempt: completed.attempt,
            idempotency_key: idempotency_key(
                &plan.run_id,
                &node.id,
                completed.attempt,
                &plan.plan_digest,
            ),
        };
        match executor
            .compensate(
                CompensationInput {
                    verified,
                    successful_result: completed.result.clone(),
                    compensation_kind: compensation.compensation_kind.clone(),
                    fixed_actions: compensation.fixed_actions.clone(),
                    frozen_verification: frozen_verification.clone(),
                },
                NodeExecutionContext {
                    cancellation: cancellation.clone(),
                },
            )
            .await
        {
            Ok(CompensationResult::Succeeded(receipt)) => {
                let finished = current_timestamp_ms();
                database.record_deployment_effect_receipt(&receipt, finished)?;
                database.transition_deployment_node_attempt(
                    &plan.run_id,
                    &node.id,
                    completed.attempt,
                    NodeAttemptStatus::Succeeded,
                    NodeAttemptStatus::Compensated,
                    None,
                    None,
                    Some(finished),
                    finished,
                )?;
                database.transition_deployment_run_node(
                    &plan.run_id,
                    &node.id,
                    DeploymentRunNodeStatus::Compensating,
                    DeploymentRunNodeStatus::Compensated,
                    Some(
                        &serde_json::json!({ "compensationKind": compensation.compensation_kind }),
                    ),
                    "deployment.node.compensated",
                    None,
                    None,
                    Some(finished),
                    finished,
                )?;
            }
            Ok(CompensationResult::NotRequired) => {
                let finished = current_timestamp_ms();
                database.transition_deployment_node_attempt(
                    &plan.run_id,
                    &node.id,
                    completed.attempt,
                    NodeAttemptStatus::Succeeded,
                    NodeAttemptStatus::Compensated,
                    None,
                    None,
                    Some(finished),
                    finished,
                )?;
                database.transition_deployment_run_node(
                    &plan.run_id,
                    &node.id,
                    DeploymentRunNodeStatus::Compensating,
                    DeploymentRunNodeStatus::Compensated,
                    Some(&serde_json::json!({ "compensationKind": compensation.compensation_kind, "noOp": true })),
                    "deployment.node.compensated",
                    None,
                    None,
                    Some(finished),
                    finished,
                )?;
            }
            Ok(CompensationResult::StateUnknown(_)) | Err(_) => complete = false,
        }
    }
    Ok(complete)
}

fn release_artifact_leases(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    plan: &ImmutableRunPlan,
) {
    let now = current_timestamp_ms();
    for (index, handle) in plan.artifacts.iter().enumerate() {
        let _ = runtime.artifacts().release_lease(&plan.run_id, handle);
        let _ = database.set_deployment_artifact_ref_lease(
            &format!("artifact-ref-{}-{index}", plan.run_id),
            false,
            now,
        );
    }
}

fn commit_active_artifact_projection(
    database: &Database,
    plan: &ImmutableRunPlan,
    now: i64,
) -> Result<(), String> {
    let active_artifact = plan
        .artifacts
        .iter()
        .find(|handle| handle.content_digest == plan.target_release.artifact_content_digest)
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_ACTIVE_ARTIFACT_NOT_FROZEN".to_string())?;
    database.commit_deployment_release_artifact(
        &plan.workflow_id,
        &plan.run_id,
        &active_artifact.artifact_reference,
        &plan.target_release.release_id,
        now,
    )
}

async fn execute_finalizers(
    database: &Database,
    executors: &DeploymentNodeExecutorRegistry,
    descriptors: &DeploymentNodeRegistry,
    plan: &ImmutableRunPlan,
    finalizers: &[super::workflow_schema::WorkflowNodeDefinition],
    outcome: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    for finalizer in finalizers {
        let run_when_matches = match finalizer.run_when {
            super::workflow_schema::NodeRunWhen::Always => true,
            super::workflow_schema::NodeRunWhen::AnyFailed => outcome != "succeeded",
            super::workflow_schema::NodeRunWhen::AllSucceeded => outcome == "succeeded",
        };
        let configured_event_matches = finalizer
            .config
            .get("events")
            .and_then(Value::as_array)
            .map(|events| events.iter().any(|event| event.as_str() == Some(outcome)))
            .unwrap_or(true);
        if !run_when_matches || !configured_event_matches {
            let now = current_timestamp_ms();
            if let Err(error) = database.transition_deployment_run_node(
                &plan.run_id,
                &finalizer.id,
                DeploymentRunNodeStatus::Pending,
                DeploymentRunNodeStatus::Skipped,
                None,
                "deployment.node.skipped",
                Some(&serde_json::json!({ "outcome": outcome })),
                None,
                Some(now),
                now,
            ) {
                errors.push(error);
            }
            continue;
        }
        if let Err(error) = persist_and_execute_node(
            database,
            executors,
            descriptors,
            plan,
            finalizer,
            BTreeMap::from([("runOutcome".into(), Value::String(outcome.into()))]),
            CancellationToken::new(),
        )
        .await
        {
            errors.push(error);
        }
    }
    errors
}

pub(crate) async fn execute_approved_run(
    database: Database,
    runtime: DeploymentWorkflowRuntime,
    executors: DeploymentNodeExecutorRegistry,
    run_id: String,
    expected_plan_digest: String,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let (run, plan) = load_and_verify_plan(&database, &run_id, &expected_plan_digest)?;
    if run.status != DeploymentRunStatus::InProgress {
        return Err("DEPLOYMENT_WORKFLOW_RUN_NOT_IN_PROGRESS".into());
    }
    ensure_plan_unexpired(plan.expires_at)?;
    ensure_frozen_plan_integrity(&database, &runtime, &run, &plan)?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    // Serialize effects by the actual endpoint, including aliases with distinct
    // profile/environment IDs. Revalidate after waiting, before any remote write.
    let profile = database
        .get_profile(&plan.target.connection_profile_id)?
        .ok_or("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND")?;
    let endpoint = canonical_sha256(&serde_json::json!({
        "host": profile.host, "port": profile.port, "jumpHost": profile.jump_host_config,
    }))
    .map_err(|error| error.to_string())?;
    let _target_guard = runtime.acquire_target_lock(&endpoint).await?;
    let revalidation = async {
        ensure_plan_unexpired(plan.expires_at)?;
        ensure_workflow_head_matches_plan(&database, &run, &plan)?;
        for unfinished in database.list_unfinished_deployment_runs()? {
            if unfinished.id == run_id || unfinished.status != DeploymentRunStatus::StateUnknown {
                continue;
            }
            let other: ImmutableRunPlan = serde_json::from_value(unfinished.plan)
                .map_err(|_| "DEPLOYMENT_WORKFLOW_STORED_PLAN_INVALID")?;
            let other_profile = database
                .get_profile(&other.target.connection_profile_id)?
                .ok_or("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND")?;
            if other_profile.host == profile.host && other_profile.port == profile.port {
                return Err("DEPLOYMENT_WORKFLOW_TARGET_STATE_UNKNOWN".into());
            }
        }
        verify_pre_start_frozen_inputs(
            &database,
            &runtime,
            &executors,
            &run_id,
            &expected_plan_digest,
        )
        .await
    }
    .await;
    if let Err(error) = revalidation {
        database.transition_deployment_run(
            &run_id,
            DeploymentRunStatus::InProgress,
            DeploymentRunStatus::Failed,
            None,
            "deployment.run.preStartRejected",
            Some(&serde_json::json!({"reason":error,"remoteEffectsStarted":false})),
            None,
            Some(current_timestamp_ms()),
            current_timestamp_ms(),
        )?;
        release_artifact_leases(&database, &runtime, &plan);
        runtime.finish_run(&run_id);
        return Err(error);
    }
    let descriptors = DeploymentNodeRegistry::mvp();
    let mut outputs = load_outputs(&database, &run_id)?;
    let existing_nodes = database
        .list_deployment_run_nodes(&run_id)?
        .into_iter()
        .map(|node| (node.node_id, node.status))
        .collect::<BTreeMap<_, _>>();
    let node_map = workflow
        .definition
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node))
        .collect::<BTreeMap<_, _>>();
    let mut completed_effects = Vec::new();
    let effect_lane = plan
        .compiled
        .target_effect_lanes
        .get(&plan.target.target_id)
        .cloned()
        .unwrap_or_default();
    let mut next_effect = 0_usize;
    let finalizers = workflow
        .definition
        .nodes
        .iter()
        .filter(|node| {
            descriptors
                .find(&node.type_name, node.type_version)
                .is_some_and(|descriptor| descriptor.is_finalizer)
        })
        .cloned()
        .collect::<Vec<_>>();
    let approval_id = workflow
        .definition
        .nodes
        .iter()
        .find(|node| node.type_name == "control.approval")
        .map(|node| node.id.clone())
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_APPROVAL_NOT_FOUND".to_string())?;
    let mut after_approval = false;
    let mut main_error = None;
    let mut current_status = DeploymentRunStatus::InProgress;
    'layers: for layer in &plan.compiled.topology_layers {
        if layer.iter().any(|id| id == &approval_id) {
            after_approval = true;
            continue;
        }
        if !after_approval {
            continue;
        }
        for node_id in layer {
            let node = node_map
                .get(node_id)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_PLAN_NODE_MISSING".to_string())?;
            let descriptor = descriptors
                .find(&node.type_name, node.type_version)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
            if descriptor.is_finalizer {
                continue;
            }
            if descriptor.effect_class.requires_approval() {
                if effect_lane.get(next_effect).map(String::as_str) != Some(node.id.as_str()) {
                    return Err("DEPLOYMENT_WORKFLOW_EFFECT_LANE_MISMATCH".into());
                }
                next_effect = next_effect.saturating_add(1);
            }
            if existing_nodes
                .get(node_id)
                .is_some_and(|status| status == "succeeded")
            {
                continue;
            }
            if cancellation.is_cancelled() {
                main_error = Some("DEPLOYMENT_WORKFLOW_CANCELED".to_string());
                break 'layers;
            }
            if descriptor.is_verification && current_status == DeploymentRunStatus::InProgress {
                let now = current_timestamp_ms();
                database.transition_deployment_run(
                    &run_id,
                    DeploymentRunStatus::InProgress,
                    DeploymentRunStatus::Verifying,
                    None,
                    "deployment.run.verifying",
                    None,
                    None,
                    None,
                    now,
                )?;
                current_status = DeploymentRunStatus::Verifying;
            }
            let inputs = node_inputs(node, &outputs)?;
            match persist_and_execute_node(
                &database,
                &executors,
                &descriptors,
                &plan,
                node,
                inputs,
                cancellation.clone(),
            )
            .await
            {
                Ok(completed) => {
                    for (name, output) in &completed.result.outputs {
                        outputs.insert((completed.node_id.clone(), name.clone()), output.clone());
                    }
                    if descriptor.effect_class.requires_approval() {
                        completed_effects.push(completed);
                    }
                }
                Err(error) => {
                    main_error = Some(error);
                    break 'layers;
                }
            }
        }
    }

    if main_error.is_none() && next_effect != effect_lane.len() {
        main_error = Some("DEPLOYMENT_WORKFLOW_EFFECT_LANE_INCOMPLETE".into());
    }

    if main_error.is_none()
        && database
            .get_deployment_run(&run_id)?
            .is_some_and(|run| run.status == DeploymentRunStatus::CancelRequested)
    {
        main_error = Some("DEPLOYMENT_WORKFLOW_CANCELED".into());
    }

    let now = current_timestamp_ms();
    if let Some(error) = main_error {
        let was_canceled = error.starts_with("DEPLOYMENT_WORKFLOW_CANCELED");
        let state_unknown = error.starts_with("DEPLOYMENT_WORKFLOW_STATE_UNKNOWN");
        let compensated = if workflow.definition.policy.automatic_restore
            && !completed_effects.is_empty()
            && !state_unknown
        {
            compensate_completed(
                &database,
                &executors,
                &plan,
                &workflow.definition,
                &completed_effects,
                CancellationToken::new(),
            )
            .await?
        } else {
            completed_effects.is_empty()
        };
        let observed = database
            .get_deployment_run(&run_id)?
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
        let expected = observed.status;
        let next = if state_unknown || !compensated {
            DeploymentRunStatus::StateUnknown
        } else if was_canceled || expected == DeploymentRunStatus::CancelRequested {
            DeploymentRunStatus::Canceled
        } else {
            DeploymentRunStatus::Failed
        };
        let finalizer_errors = execute_finalizers(
            &database,
            &executors,
            &descriptors,
            &plan,
            &finalizers,
            match next {
                DeploymentRunStatus::Canceled => "canceled",
                DeploymentRunStatus::StateUnknown => "stateUnknown",
                _ => "failed",
            },
        )
        .await;
        database.transition_deployment_run(
            &run_id,
            expected,
            next,
            None,
            if next == DeploymentRunStatus::StateUnknown {
                "deployment.run.stateUnknown"
            } else if next == DeploymentRunStatus::Canceled {
                "deployment.run.canceled"
            } else {
                "deployment.run.failed"
            },
            Some(&serde_json::json!({
                "failureCode": safe_failure_code(&error),
                "compensated": compensated,
                "finalizerFailures": finalizer_errors.len(),
            })),
            None,
            Some(now),
            now,
        )?;
        if next != DeploymentRunStatus::StateUnknown {
            release_artifact_leases(&database, &runtime, &plan);
        }
    } else {
        if current_status == DeploymentRunStatus::InProgress {
            database.transition_deployment_run(
                &run_id,
                DeploymentRunStatus::InProgress,
                DeploymentRunStatus::Verifying,
                None,
                "deployment.run.verifying",
                None,
                None,
                None,
                now,
            )?;
            current_status = DeploymentRunStatus::Verifying;
        }
        commit_active_artifact_projection(&database, &plan, now)?;
        let finalizer_errors = execute_finalizers(
            &database,
            &executors,
            &descriptors,
            &plan,
            &finalizers,
            "succeeded",
        )
        .await;
        database.transition_deployment_run(
            &run_id,
            current_status,
            DeploymentRunStatus::Succeeded,
            None,
            "deployment.run.succeeded",
            Some(&serde_json::json!({ "finalizerFailures": finalizer_errors.len() })),
            None,
            Some(now),
            now,
        )?;
        let checks = outputs.iter().filter(|(_, output)| output.kind == NodeOutputKind::Evidence)
            .filter(|(_, output)| output.value.pointer("/evidence/outcome").and_then(Value::as_str) == Some("passed"))
            .map(|((node_id, _), output)| serde_json::json!({"nodeId":node_id,"location":"server","evidence":output.value}))
            .collect::<Vec<_>>();
        if let Some(checked_at) = checks
            .iter()
            .filter_map(|check| {
                check
                    .pointer("/evidence/evidence/observedAt")
                    .and_then(Value::as_i64)
            })
            .min()
        {
            database.append_deployment_run_event(&run_id, &super::repository::DeploymentRunEventWrite {
                node_id: None, attempt: None, event_kind: "serviceObservation".into(), status: None,
                summary_key: "deployment.service.observed".into(),
                payload: Some(serde_json::json!({"status":"passed","checkedAt":checked_at,"checks":checks})),
                recorded_at: current_timestamp_ms(),
            })?;
        }
        release_artifact_leases(&database, &runtime, &plan);
    }
    runtime.finish_run(&run_id);
    Ok(())
}

pub(crate) fn begin_start_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    run_id: &str,
    expected_plan_digest: &str,
) -> Result<(RunProjection, CancellationToken), String> {
    let (run, plan) = load_and_verify_plan(database, run_id, expected_plan_digest)?;
    if run.status != DeploymentRunStatus::Approved {
        return Err("DEPLOYMENT_WORKFLOW_RUN_NOT_APPROVED".into());
    }
    ensure_plan_unexpired(plan.expires_at)?;
    ensure_frozen_plan_integrity(database, runtime, &run, &plan)?;
    ensure_workflow_head_matches_plan(database, &run, &plan)?;
    let approval = database
        .list_deployment_run_outputs(run_id)?
        .into_iter()
        .find(|output| output.output_name == "approval")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_APPROVAL_MISSING".to_string())?;
    if approval.value.get("planDigest").and_then(Value::as_str) != Some(expected_plan_digest) {
        return Err("DEPLOYMENT_WORKFLOW_APPROVAL_PLAN_MISMATCH".into());
    }
    let cancellation = runtime.register_run_cancellation(run_id)?;
    let now = current_timestamp_ms();
    if let Err(error) = database.transition_deployment_run(
        run_id,
        DeploymentRunStatus::Approved,
        DeploymentRunStatus::InProgress,
        None,
        "deployment.run.started",
        Some(&serde_json::json!({ "planDigest": expected_plan_digest })),
        Some(now),
        None,
        now,
    ) {
        runtime.finish_run(run_id);
        return Err(error);
    }
    Ok((
        RunProjection {
            run_id: run_id.to_string(),
            status: DeploymentRunStatus::InProgress.as_str().to_string(),
            plan_digest: expected_plan_digest.to_string(),
        },
        cancellation,
    ))
}

pub(crate) async fn verify_pre_start_frozen_inputs(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    run_id: &str,
    expected_plan_digest: &str,
) -> Result<(), String> {
    let (run, plan) = load_and_verify_plan(database, run_id, expected_plan_digest)?;
    ensure_plan_unexpired(plan.expires_at)?;
    ensure_workflow_head_matches_plan(database, &run, &plan)?;
    ensure_frozen_plan_integrity(database, runtime, &run, &plan)?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    let preflight = workflow
        .definition
        .nodes
        .iter()
        .find(|node| node.type_name == "target.preflight")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_PREFLIGHT_NOT_FOUND".to_string())?;
    let outputs = load_outputs(database, run_id)?;
    let frozen = FrozenNodeInput {
        run_id: run_id.to_string(),
        node: preflight.clone(),
        targets: workflow.definition.targets.clone(),
        inputs: node_inputs(preflight, &outputs)?,
    };
    let executor = executors.get(&preflight.type_name, preflight.type_version)?;
    let planned = executor.plan(frozen.clone())?;
    if plan
        .executor_versions
        .get(&preflight.id)
        .map(String::as_str)
        != Some(planned.executor_version.as_str())
    {
        return Err("DEPLOYMENT_WORKFLOW_EXECUTOR_VERSION_DRIFT".into());
    }
    let observed = executor
        .execute(
            VerifiedNodeInput {
                frozen,
                planned,
                immutable_plan: Some(plan.clone()),
                attempt: 1,
                idempotency_key: idempotency_key(run_id, &preflight.id, 1, expected_plan_digest),
            },
            NodeExecutionContext {
                cancellation: CancellationToken::new(),
            },
        )
        .await
        .map_err(|failure| {
            format!(
                "DEPLOYMENT_WORKFLOW_TARGET_REVALIDATION_FAILED:{}",
                failure.category
            )
        })?;
    let target_output = observed
        .outputs
        .get("target")
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_TARGET_REVALIDATION_MISSING".to_string())?;
    let identity = parse_target(
        target_output
            .value
            .get("identity")
            .unwrap_or(&target_output.value),
    )?;
    if identity != plan.target {
        return Err("DEPLOYMENT_WORKFLOW_TARGET_DRIFT".into());
    }
    Ok(())
}

/// Re-observe the committed release through read-only nodes. This never admits
/// transfer, activation, commit, or compensation and never changes run outcome.
pub(crate) async fn observe_service(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    run_id: &str,
) -> Result<Value, String> {
    let run = database
        .get_deployment_run(run_id)?
        .ok_or("DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND")?;
    let (_, plan) = load_and_verify_plan(database, run_id, &run.plan_digest)?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or("DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND")?;
    let check = async {
        ensure_frozen_plan_integrity(database, runtime, &run, &plan)?;
        if !database.list_deployment_releases(&run.workflow_id)?.iter().any(|release|
            release.position == "current" && release.release_id == plan.target_release.release_id) {
            return Err("DEPLOYMENT_SERVICE_NOT_CURRENT_RELEASE".to_string());
        }
        if database.list_unfinished_deployment_runs()?.iter().any(|other|
            other.id != run_id && !matches!(other.status, DeploymentRunStatus::AwaitingApproval | DeploymentRunStatus::Approved | DeploymentRunStatus::Planned)) {
            return Err("DEPLOYMENT_SERVICE_ACTIVE_OR_UNKNOWN_RUN".to_string());
        }
        let outputs = load_outputs(database, run_id)?;
        let mut checks = Vec::new();
        let nodes = workflow.definition.nodes.iter().filter(|node| node.type_name == "target.preflight")
            .chain(workflow.definition.nodes.iter().filter(|node| node.type_name == "verify.http"));
        for node in nodes {
            let frozen = FrozenNodeInput { run_id: run_id.into(), node: node.clone(),
                targets: workflow.definition.targets.clone(), inputs: node_inputs(node, &outputs)? };
            let executor = executors.get(&node.type_name, node.type_version)?;
            let planned = executor.plan(frozen.clone())?;
            let result = executor.execute(VerifiedNodeInput { frozen, planned,
                immutable_plan: Some(plan.clone()), attempt: 1,
                idempotency_key: idempotency_key(run_id, &node.id, 1, &plan.plan_digest) },
                NodeExecutionContext { cancellation: CancellationToken::new() }).await
                .map_err(|error| format!("DEPLOYMENT_SERVICE_CHECK_FAILED:{}", error.category))?;
            if node.type_name == "target.preflight" {
                let observed = &result.outputs.get("target").ok_or("DEPLOYMENT_SERVICE_IDENTITY_MISSING")?.value;
                if observed.get("currentRelease") != Some(&serde_json::to_value(&plan.target_release).map_err(|e|e.to_string())?) {
                    return Err("DEPLOYMENT_SERVICE_RELEASE_DRIFT".into());
                }
            } else {
                checks.push(serde_json::json!({"nodeId": node.id, "location":"server", "name":node.display_name,
                    "evidence":result.outputs.get("evidence").map(|output| &output.value)}));
            }
        }
        if checks.is_empty() { return Err("DEPLOYMENT_SERVICE_NO_CHECKS".into()); }
        Ok(checks)
    }.await;
    let observation = match check {
        Ok(checks) => {
            serde_json::json!({"status":"passed","checkedAt":current_timestamp_ms(),"checks":checks})
        }
        Err(error) => {
            serde_json::json!({"status":"unknown","checkedAt":current_timestamp_ms(),"reason":error,"checks":[]})
        }
    };
    database.append_deployment_run_event(
        run_id,
        &super::repository::DeploymentRunEventWrite {
            node_id: None,
            attempt: None,
            event_kind: "serviceObservation".into(),
            status: None,
            summary_key: "deployment.service.observed".into(),
            payload: Some(observation.clone()),
            recorded_at: current_timestamp_ms(),
        },
    )?;
    Ok(observation)
}

pub(crate) fn cancel_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    run_id: &str,
) -> Result<(), String> {
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
    let now = current_timestamp_ms();
    match run.status {
        DeploymentRunStatus::Planned | DeploymentRunStatus::AwaitingApproval => {
            database.transition_deployment_run(
                run_id,
                run.status,
                DeploymentRunStatus::Canceled,
                None,
                "deployment.run.canceled",
                Some(&serde_json::json!({ "beforeEffects": true })),
                None,
                Some(now),
                now,
            )?;
            if let Ok(plan) = serde_json::from_value::<ImmutableRunPlan>(run.plan) {
                release_artifact_leases(database, runtime, &plan);
            }
        }
        DeploymentRunStatus::Approved => {
            database.transition_deployment_run(
                run_id,
                run.status,
                DeploymentRunStatus::CancelRequested,
                None,
                "deployment.run.cancelRequested",
                None,
                None,
                None,
                now,
            )?;
            database.transition_deployment_run(
                run_id,
                DeploymentRunStatus::CancelRequested,
                DeploymentRunStatus::Canceled,
                None,
                "deployment.run.canceled",
                Some(&serde_json::json!({ "beforeEffects": true })),
                None,
                Some(now),
                now,
            )?;
            if let Ok(plan) = serde_json::from_value::<ImmutableRunPlan>(run.plan) {
                release_artifact_leases(database, runtime, &plan);
            }
        }
        DeploymentRunStatus::InProgress | DeploymentRunStatus::Verifying => {
            database.transition_deployment_run(
                run_id,
                run.status,
                DeploymentRunStatus::CancelRequested,
                None,
                "deployment.run.cancelRequested",
                None,
                None,
                None,
                now,
            )?;
            let _ = runtime.cancel_run(run_id)?;
        }
        DeploymentRunStatus::CancelRequested => {
            let _ = runtime.cancel_run(run_id)?;
        }
        DeploymentRunStatus::Reconciling | DeploymentRunStatus::StateUnknown => {
            return Err("DEPLOYMENT_WORKFLOW_RECONCILIATION_REQUIRED".into())
        }
        status if status.is_terminal() => {}
        _ => return Err("DEPLOYMENT_WORKFLOW_CANCEL_NOT_ALLOWED".into()),
    }
    Ok(())
}

pub(crate) async fn reconcile_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    run_id: &str,
) -> Result<ReconciliationProjection, String> {
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND".to_string())?;
    if run.status.is_terminal() {
        return Ok(ReconciliationProjection {
            run_id: run_id.to_string(),
            status: run.status.as_str().to_string(),
            evidence_complete: true,
        });
    }
    let plan: ImmutableRunPlan = match serde_json::from_value(run.plan.clone()) {
        Ok(plan) => plan,
        Err(_) => {
            return mark_integrity_unknown(
                database,
                &run,
                "DEPLOYMENT_WORKFLOW_STORED_PLAN_INVALID",
            )
        }
    };
    if let Err(error) = ensure_frozen_plan_integrity_for_mode(database, runtime, &run, &plan, true)
    {
        return mark_integrity_unknown(database, &run, &error);
    }
    let profile = database
        .get_profile(&plan.target.connection_profile_id)?
        .ok_or("DEPLOYMENT_WORKFLOW_PROFILE_NOT_FOUND")?;
    let endpoint = canonical_sha256(&serde_json::json!({
        "host": profile.host, "port": profile.port, "jumpHost": profile.jump_host_config,
    }))
    .map_err(|error| error.to_string())?;
    let _target_guard = runtime.acquire_target_lock(&endpoint).await?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    let now = current_timestamp_ms();
    let mut status = run.status;
    if matches!(
        status,
        DeploymentRunStatus::Approved
            | DeploymentRunStatus::InProgress
            | DeploymentRunStatus::Verifying
            | DeploymentRunStatus::CancelRequested
            | DeploymentRunStatus::StateUnknown
    ) {
        database.transition_deployment_run(
            run_id,
            status,
            DeploymentRunStatus::Reconciling,
            None,
            "deployment.run.reconciling",
            None,
            None,
            None,
            now,
        )?;
        status = DeploymentRunStatus::Reconciling;
    }
    let outputs = load_outputs(database, run_id)?;
    let nodes = database.list_deployment_run_nodes(run_id)?;
    let definition_nodes = workflow
        .definition
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let descriptor_registry = DeploymentNodeRegistry::mvp();
    let receipts = database.list_deployment_effect_receipts(run_id)?;
    let mut evidence_complete = true;
    let mut all_succeeded = true;
    let mut definite_failure = false;
    for projection in nodes {
        let Some(node) = definition_nodes.get(projection.node_id.as_str()) else {
            evidence_complete = false;
            continue;
        };
        let descriptor = descriptor_registry
            .find(&node.type_name, node.type_version)
            .cloned()
            .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
        if descriptor.is_finalizer {
            continue;
        }
        match recovery_boundary_state(&projection.status) {
            RecoveryBoundaryState::Completed | RecoveryBoundaryState::Compensated => {
                if descriptor.effect_class.requires_approval()
                    && !receipts.iter().any(|receipt| {
                        receipt_is_bound(receipt, &plan, &node.id, projection.last_attempt)
                    })
                {
                    evidence_complete = false;
                    all_succeeded = false;
                }
                continue;
            }
            RecoveryBoundaryState::NotStarted => {
                all_succeeded = false;
                continue;
            }
            RecoveryBoundaryState::EvidenceIncomplete => {
                if projection.status != "skipped" {
                    evidence_complete = false;
                    all_succeeded = false;
                }
                continue;
            }
            RecoveryBoundaryState::InProgress => {}
        }
        let executor = executors.get(&node.type_name, node.type_version)?;
        if plan.executor_versions.get(&node.id).map(String::as_str)
            != Some(executor.executor_version())
            && !plan.executor_versions.get(&node.id).is_some_and(|version| {
                supports_reconciliation_version(version)
                    && executor.executor_version() == DOCKER_COMPOSE_EXECUTOR_VERSION
            })
        {
            evidence_complete = false;
            all_succeeded = false;
            continue;
        }
        let planned = executor.plan(FrozenNodeInput {
            run_id: run_id.to_string(),
            node: (*node).clone(),
            targets: workflow.definition.targets.clone(),
            inputs: node_inputs(node, &outputs).unwrap_or_default(),
        })?;
        let attempt = projection.last_attempt.max(1);
        let verified = VerifiedNodeInput {
            frozen: FrozenNodeInput {
                run_id: run_id.to_string(),
                node: (*node).clone(),
                targets: workflow.definition.targets.clone(),
                inputs: node_inputs(node, &outputs).unwrap_or_default(),
            },
            planned,
            immutable_plan: Some(plan.clone()),
            attempt,
            idempotency_key: idempotency_key(run_id, &node.id, attempt, &plan.plan_digest),
        };
        match executor
            .reconcile(
                verified,
                NodeExecutionContext {
                    cancellation: CancellationToken::new(),
                },
            )
            .await
        {
            Ok(NodeReconcileResult::Succeeded(result)) => {
                let observed_at = current_timestamp_ms();
                for (name, output) in &result.outputs {
                    if !outputs.contains_key(&(node.id.clone(), name.clone())) {
                        persist_output(database, run_id, &node.id, name, output, observed_at)?;
                    }
                }
                if let Some(receipt) = &result.receipt {
                    if !database
                        .list_deployment_effect_receipts(run_id)?
                        .iter()
                        .any(|stored| stored.operation_id == receipt.operation_id)
                    {
                        database.record_deployment_effect_receipt(receipt, observed_at)?;
                    }
                }
                if matches!(
                    projection.status.as_str(),
                    "running" | "state_unknown" | "cancel_requested"
                ) {
                    database.transition_deployment_run_node(
                        run_id,
                        &node.id,
                        match projection.status.as_str() {
                            "running" => DeploymentRunNodeStatus::Running,
                            "state_unknown" => DeploymentRunNodeStatus::StateUnknown,
                            _ => DeploymentRunNodeStatus::CancelRequested,
                        },
                        DeploymentRunNodeStatus::Succeeded,
                        Some(&result.summary),
                        "deployment.node.reconciledSucceeded",
                        None,
                        None,
                        Some(observed_at),
                        observed_at,
                    )?;
                }
                let attempts = database.list_deployment_node_attempts(run_id, &node.id, None, 1)?;
                if let Some(attempt_record) = attempts.items.first() {
                    if matches!(
                        attempt_record.status,
                        NodeAttemptStatus::Running | NodeAttemptStatus::StateUnknown
                    ) {
                        database.transition_deployment_node_attempt(
                            run_id,
                            &node.id,
                            attempt_record.attempt,
                            attempt_record.status,
                            NodeAttemptStatus::Succeeded,
                            None,
                            None,
                            Some(observed_at),
                            observed_at,
                        )?;
                    }
                }
            }
            Ok(NodeReconcileResult::NotStarted | NodeReconcileResult::SafeToRetry) => {
                all_succeeded = false;
                let observed_at = current_timestamp_ms();
                if matches!(
                    projection.status.as_str(),
                    "running" | "state_unknown" | "cancel_requested"
                ) {
                    database.transition_deployment_run_node(
                        run_id,
                        &node.id,
                        match projection.status.as_str() {
                            "running" => DeploymentRunNodeStatus::Running,
                            "state_unknown" => DeploymentRunNodeStatus::StateUnknown,
                            _ => DeploymentRunNodeStatus::CancelRequested,
                        },
                        DeploymentRunNodeStatus::Pending,
                        None,
                        "deployment.node.reconciledNotStarted",
                        None,
                        None,
                        None,
                        observed_at,
                    )?;
                }
                let attempts = database.list_deployment_node_attempts(run_id, &node.id, None, 1)?;
                if let Some(attempt_record) = attempts.items.first() {
                    if matches!(
                        attempt_record.status,
                        NodeAttemptStatus::Running | NodeAttemptStatus::StateUnknown
                    ) {
                        database.transition_deployment_node_attempt(
                            run_id,
                            &node.id,
                            attempt_record.attempt,
                            attempt_record.status,
                            NodeAttemptStatus::Failed,
                            Some("reconciledNotStarted"),
                            None,
                            Some(observed_at),
                            observed_at,
                        )?;
                    }
                }
            }
            Ok(NodeReconcileResult::FailedDefinitely(_)) => {
                all_succeeded = false;
                definite_failure = true;
            }
            Ok(NodeReconcileResult::StateUnknown(_)) | Err(_) => {
                evidence_complete = false;
                all_succeeded = false;
            }
        }
    }
    let cancel_requested = run.status == DeploymentRunStatus::CancelRequested;
    let mut cancellation_compensated = true;
    if cancel_requested && evidence_complete {
        let refreshed_outputs = load_outputs(database, run_id)?;
        let projections = database
            .list_deployment_run_nodes(run_id)?
            .into_iter()
            .map(|node| (node.node_id.clone(), node))
            .collect::<BTreeMap<_, _>>();
        let mut completed_effects = Vec::new();
        for node in &workflow.definition.nodes {
            let descriptor = descriptor_registry
                .find(&node.type_name, node.type_version)
                .ok_or_else(|| "DEPLOYMENT_WORKFLOW_EXECUTOR_DESCRIPTOR_MISSING".to_string())?;
            let Some(projection) = projections.get(&node.id) else {
                evidence_complete = false;
                continue;
            };
            if !descriptor.effect_class.requires_approval() || projection.status != "succeeded" {
                continue;
            }
            let executor = executors.get(&node.type_name, node.type_version)?;
            let inputs = node_inputs(node, &refreshed_outputs).unwrap_or_default();
            let frozen = FrozenNodeInput {
                run_id: run_id.to_string(),
                node: node.clone(),
                targets: workflow.definition.targets.clone(),
                inputs,
            };
            let planned = executor.plan(frozen)?;
            let node_outputs = refreshed_outputs
                .iter()
                .filter(|((node_id, _), _)| node_id == &node.id)
                .map(|((_, name), output)| (name.clone(), output.clone()))
                .collect::<BTreeMap<_, _>>();
            let receipt = receipts
                .iter()
                .find(|receipt| {
                    receipt.node_id == node.id && receipt.attempt == projection.last_attempt
                })
                .cloned();
            completed_effects.push(CompletedNode {
                node_id: node.id.clone(),
                planned,
                attempt: projection.last_attempt,
                result: NodeExecutionResult {
                    outputs: node_outputs,
                    receipt,
                    evidence: None,
                    summary: serde_json::json!({ "recovered": true }),
                },
            });
        }
        cancellation_compensated = if completed_effects.is_empty() {
            true
        } else if workflow.definition.policy.automatic_restore {
            compensate_completed(
                database,
                executors,
                &plan,
                &workflow.definition,
                &completed_effects,
                CancellationToken::new(),
            )
            .await?
        } else {
            false
        };
    }
    let next = if !evidence_complete || (cancel_requested && !cancellation_compensated) {
        DeploymentRunStatus::StateUnknown
    } else if cancel_requested {
        DeploymentRunStatus::Canceled
    } else if definite_failure {
        DeploymentRunStatus::Failed
    } else if all_succeeded {
        DeploymentRunStatus::Succeeded
    } else {
        DeploymentRunStatus::Approved
    };
    if next == DeploymentRunStatus::Succeeded {
        commit_active_artifact_projection(database, &plan, now)?;
    }
    let finalizers = workflow
        .definition
        .nodes
        .iter()
        .filter(|node| {
            descriptor_registry
                .find(&node.type_name, node.type_version)
                .is_some_and(|descriptor| descriptor.is_finalizer)
        })
        .cloned()
        .collect::<Vec<_>>();
    let finalizer_errors = if next.is_terminal() || next == DeploymentRunStatus::StateUnknown {
        execute_finalizers(
            database,
            executors,
            &descriptor_registry,
            &plan,
            &finalizers,
            match next {
                DeploymentRunStatus::Succeeded => "succeeded",
                DeploymentRunStatus::Canceled => "canceled",
                DeploymentRunStatus::StateUnknown => "stateUnknown",
                _ => "failed",
            },
        )
        .await
    } else {
        Vec::new()
    };
    database.transition_deployment_run(
        run_id,
        status,
        next,
        None,
        "deployment.run.reconciled",
        Some(&serde_json::json!({
            "evidenceComplete": evidence_complete,
            "compensated": cancellation_compensated,
            "finalizerFailures": finalizer_errors.len(),
        })),
        None,
        if next.is_terminal() { Some(now) } else { None },
        now,
    )?;
    if next.is_terminal() {
        release_artifact_leases(database, runtime, &plan);
    }
    Ok(ReconciliationProjection {
        run_id: run_id.to_string(),
        status: next.as_str().to_string(),
        evidence_complete,
    })
}
