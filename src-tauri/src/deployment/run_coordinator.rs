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
                            result,
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
    Ok(PreparationState { outputs, completed })
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

pub(crate) async fn prepare_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    request: PrepareRunRequest,
) -> Result<PreparedRun, String> {
    prepare_run_internal(database, runtime, executors, request, None, None).await
}

pub(crate) async fn prepare_rollback_run(
    database: &Database,
    runtime: &DeploymentWorkflowRuntime,
    executors: &DeploymentNodeExecutorRegistry,
    request: PrepareRunRequest,
    rollback_release_id: String,
) -> Result<PreparedRun, String> {
    if request.operation_kind != WorkflowRunOperationKind::Rollback {
        return Err("DEPLOYMENT_WORKFLOW_ROLLBACK_OPERATION_REQUIRED".into());
    }
    prepare_run_internal(
        database,
        runtime,
        executors,
        request,
        Some(rollback_release_id),
        None,
    )
    .await
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
    let mut source = parse_source(find_output(
        &preparation,
        "source.snapshot",
        &workflow.definition,
        "source",
    )?)?;
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
            plan.executor_versions.get(&node.id).map(String::as_str)
                != Some(DOCKER_COMPOSE_EXECUTOR_VERSION)
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
    if now > plan.expires_at {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_EXPIRED".into());
    }
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
                            result,
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
    if current_timestamp_ms() > plan.expires_at {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_EXPIRED".into());
    }
    ensure_frozen_plan_integrity(&database, &runtime, &run, &plan)?;
    let workflow = database
        .get_deployment_workflow_revision(&run.workflow_id, run.workflow_revision)?
        .ok_or_else(|| "DEPLOYMENT_WORKFLOW_REVISION_NOT_FOUND".to_string())?;
    let _target_guard = runtime.acquire_target_lock(&plan.target.target_id).await?;
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
    if current_timestamp_ms() > plan.expires_at {
        return Err("DEPLOYMENT_WORKFLOW_PLAN_EXPIRED".into());
    }
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
    if let Err(error) = ensure_frozen_plan_integrity(database, runtime, &run, &plan) {
        return mark_integrity_unknown(database, &run, &error);
    }
    let _target_guard = runtime.acquire_target_lock(&plan.target.target_id).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::test_db;
    use crate::deployment::artifact_cas::{ArtifactBlobSource, DeploymentArtifactCas};
    use crate::deployment::docker_compose_executor::{
        docker_compose_executor_registry, DockerComposeExecutionBackend,
    };
    use crate::deployment::node_executor::{
        plan_from_descriptor, CompensationResult, DeploymentNodeExecutor, NodeFailure,
    };
    use crate::deployment::repository::{
        CreateDeploymentWorkflowInput, UpdateDeploymentWorkflowInput,
    };
    use crate::deployment::workflow_schema::{
        ArtifactBundleManifest, ArtifactDescriptor, ArtifactProducer, ArtifactRole, ArtifactSource,
        EffectReceipt, FrozenReleaseIdentity, FrozenSourceSnapshot, FrozenTargetIdentity,
        VerificationEvidence, WorkflowNodeDefinition,
    };
    use async_trait::async_trait;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct TestExecutor {
        node_type: &'static str,
        version: u32,
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
        order: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl DeploymentNodeExecutor for TestExecutor {
        fn node_type(&self) -> (&'static str, u32) {
            (self.node_type, self.version)
        }

        fn executor_version(&self) -> &'static str {
            "test-executor"
        }

        fn validate_config(&self, _config: &Value) -> Result<(), String> {
            Ok(())
        }

        fn plan(&self, input: FrozenNodeInput) -> Result<PlannedNode, String> {
            let registry = DeploymentNodeRegistry::mvp();
            let descriptor = registry
                .find(&input.node.type_name, input.node.type_version)
                .unwrap();
            plan_from_descriptor(descriptor, self.executor_version(), &input)
        }

        async fn execute(
            &self,
            input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeExecutionResult, NodeFailure> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            self.order
                .lock()
                .unwrap()
                .push(input.frozen.node.id.clone());
            Ok(NodeExecutionResult::output(
                "source",
                NodeOutputValue {
                    kind: NodeOutputKind::Scalar,
                    value: serde_json::json!({ "node": input.frozen.node.id }),
                    artifact_reference: None,
                },
            ))
        }

        async fn reconcile(
            &self,
            _input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeReconcileResult, NodeFailure> {
            Ok(NodeReconcileResult::SafeToRetry)
        }

        async fn compensate(
            &self,
            _input: CompensationInput,
            _context: NodeExecutionContext,
        ) -> Result<CompensationResult, NodeFailure> {
            Ok(CompensationResult::NotRequired)
        }
    }

    #[test]
    fn immutable_plan_digest_excludes_only_its_own_digest() {
        let value =
            serde_json::json!({ "planDigest": "sha256:old", "nested": { "planDigest": "kept" } });
        let mut stripped = value.clone();
        stripped.as_object_mut().unwrap().remove("planDigest");
        assert_ne!(
            canonical_sha256(&value).unwrap(),
            canonical_sha256(&stripped).unwrap()
        );
        assert_eq!(
            stripped.pointer("/nested/planDigest"),
            Some(&Value::String("kept".into()))
        );
    }

    #[test]
    fn attempt_idempotency_is_exact_and_attempt_scoped() {
        let digest = format!("sha256:{}", "a".repeat(64));
        assert_eq!(
            idempotency_key("run", "node", 1, &digest),
            idempotency_key("run", "node", 1, &digest)
        );
        assert_ne!(
            idempotency_key("run", "node", 1, &digest),
            idempotency_key("run", "node", 2, &digest)
        );
    }

    #[test]
    fn startup_recovery_matrix_is_explicit_for_every_effect_boundary_state() {
        assert_eq!(
            recovery_boundary_state("pending"),
            RecoveryBoundaryState::NotStarted
        );
        assert_eq!(
            recovery_boundary_state("running"),
            RecoveryBoundaryState::InProgress
        );
        assert_eq!(
            recovery_boundary_state("succeeded"),
            RecoveryBoundaryState::Completed
        );
        assert_eq!(
            recovery_boundary_state("compensated"),
            RecoveryBoundaryState::Compensated
        );
        assert_eq!(
            recovery_boundary_state("failed"),
            RecoveryBoundaryState::EvidenceIncomplete
        );
    }

    #[test]
    fn receipts_fail_closed_on_target_plan_attempt_or_digest_drift() {
        let plan_digest = format!("sha256:{}", "a".repeat(64));
        let plan = ImmutableRunPlan {
            schema_version: 1,
            workflow_id: "workflow".into(),
            workflow_revision: 1,
            run_id: "run".into(),
            operation_kind: WorkflowRunOperationKind::Deploy,
            trigger_kind: WorkflowRunTriggerKind::Manual,
            definition_digest: format!("sha256:{}", "b".repeat(64)),
            parameters: BTreeMap::new(),
            source: FrozenSourceSnapshot {
                source_ref: "workspace".into(),
                revision: "0123456789abcdef0123456789abcdef01234567".into(),
                dirty: false,
                snapshot_digest: format!("sha256:{}", "c".repeat(64)),
                metadata_digest: format!("sha256:{}", "d".repeat(64)),
            },
            target: FrozenTargetIdentity {
                target_id: "production".into(),
                connection_profile_id: "profile".into(),
                profile_revision: 1,
                host_identity_digest: format!("sha256:{}", "e".repeat(64)),
                remote_root: "/srv/app".into(),
                capabilities_digest: format!("sha256:{}", "f".repeat(64)),
            },
            artifacts: Vec::new(),
            current_release: None,
            previous_release: None,
            target_release: FrozenReleaseIdentity {
                release_id: "release-target".into(),
                artifact_content_digest: format!("sha256:{}", "1".repeat(64)),
                layout_digest: format!("sha256:{}", "2".repeat(64)),
            },
            executor_versions: BTreeMap::new(),
            compiled: compile_workflow_definition(
                &serde_json::from_str(include_str!(
                    "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
                ))
                .unwrap(),
                &DeploymentNodeRegistry::mvp(),
            )
            .unwrap(),
            prepared_at: 1,
            expires_at: 2,
            plan_digest: plan_digest.clone(),
        };
        let receipt = EffectReceipt {
            schema_version: 1,
            receipt_type: "transfer.sftp".into(),
            operation_id: "operation".into(),
            run_id: "run".into(),
            node_id: "transfer".into(),
            attempt: 1,
            target_id: "production".into(),
            plan_digest,
            payload_digest: format!("sha256:{}", "3".repeat(64)),
        };
        assert!(receipt_is_bound(&receipt, &plan, "transfer", 1));
        let mut drifted = receipt.clone();
        drifted.target_id = "staging".into();
        assert!(!receipt_is_bound(&drifted, &plan, "transfer", 1));
        let mut drifted = receipt.clone();
        drifted.plan_digest = format!("sha256:{}", "4".repeat(64));
        assert!(!receipt_is_bound(&drifted, &plan, "transfer", 1));
        let mut drifted = receipt;
        drifted.payload_digest = "remote text".into();
        assert!(!receipt_is_bound(&drifted, &plan, "transfer", 1));
    }

    #[test]
    fn preparation_parameters_are_typed_resolved_and_frozen() {
        let mut definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        definition.parameters = vec![
            super::super::workflow_schema::WorkflowParameterDefinition {
                id: "replicas".into(),
                display_name: "Replicas".into(),
                parameter_type: super::super::workflow_schema::WorkflowParameterType::Integer,
                required: true,
                default_value: Some(super::super::workflow_schema::ScalarValue::Integer(2)),
            },
            super::super::workflow_schema::WorkflowParameterDefinition {
                id: "label".into(),
                display_name: "Label".into(),
                parameter_type: super::super::workflow_schema::WorkflowParameterType::String,
                required: false,
                default_value: None,
            },
        ];
        let resolved = resolve_parameters(&definition, &BTreeMap::new()).unwrap();
        assert_eq!(
            resolved.get("replicas"),
            Some(&super::super::workflow_schema::ScalarValue::Integer(2))
        );
        assert!(!resolved.contains_key("label"));
        assert!(resolve_parameters(
            &definition,
            &BTreeMap::from([(
                "replicas".into(),
                super::super::workflow_schema::ScalarValue::String("two".into())
            )])
        )
        .is_err());
    }

    #[tokio::test]
    async fn ready_local_nodes_respect_the_parallel_limit() {
        let mut definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        let source = definition.nodes[0].clone();
        let mut left = source.clone();
        left.id = "source-left".into();
        let mut right = source;
        right.id = "source-right".into();
        let approval = definition
            .nodes
            .iter()
            .find(|node| node.type_name == "control.approval")
            .unwrap()
            .clone();
        definition.nodes = vec![left, right, approval.clone()];
        definition.policy.max_parallel_local_nodes = 2;
        let mut compiled = compile_workflow_definition(
            &serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap(),
            &DeploymentNodeRegistry::mvp(),
        )
        .unwrap();
        compiled.topology_layers = vec![
            vec!["source-left".into(), "source-right".into()],
            vec![approval.id],
        ];
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut executors = DeploymentNodeExecutorRegistry::default();
        executors
            .register(Arc::new(TestExecutor {
                node_type: "source.snapshot",
                version: 1,
                active,
                maximum: maximum.clone(),
                order,
            }))
            .unwrap();
        let progress_events = Arc::new(Mutex::new(Vec::<PreparationProgress>::new()));
        let observer: PreparationProgressObserver = {
            let progress_events = progress_events.clone();
            Arc::new(move |event| progress_events.lock().unwrap().push(event))
        };
        let result = execute_pre_approval(
            "run-parallel",
            &definition,
            &compiled,
            &executors,
            CancellationToken::new(),
            None,
            Some(&observer),
        )
        .await
        .unwrap();
        assert_eq!(result.completed.len(), 2);
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
        let progress_events = progress_events.lock().unwrap();
        assert_eq!(
            progress_events
                .iter()
                .filter(|event| event.status == "running")
                .count(),
            2
        );
        assert_eq!(progress_events.last().unwrap().completed, 2);
        assert_eq!(progress_events.last().unwrap().total, 2);
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FakeMode {
        Success,
        VerificationFailure,
        AmbiguousDeploy,
        BlockDeploy,
        BlockSource,
        FinalizerFailure,
    }

    struct FakeDockerBackend {
        mode: FakeMode,
        image: ArtifactHandle,
        bundle: ArtifactHandle,
        static_bundle: ArtifactHandle,
        ledgers: Mutex<BTreeMap<String, NodeExecutionResult>>,
        compensations: AtomicUsize,
        static_restore_reverified: AtomicUsize,
        deploy_started: tokio::sync::Notify,
        host_identity_digest: String,
    }

    impl FakeDockerBackend {
        fn receipt(input: &VerifiedNodeInput, receipt_type: &str) -> EffectReceipt {
            let plan = input.immutable_plan.as_ref().unwrap();
            EffectReceipt {
                schema_version: 1,
                receipt_type: receipt_type.into(),
                operation_id: format!(
                    "fake-effect-{}-{}-{}",
                    input.frozen.run_id, input.frozen.node.id, input.attempt
                ),
                run_id: input.frozen.run_id.clone(),
                node_id: input.frozen.node.id.clone(),
                attempt: input.attempt,
                target_id: plan.target.target_id.clone(),
                plan_digest: plan.plan_digest.clone(),
                payload_digest: format!("sha256:{}", "b".repeat(64)),
            }
        }

        fn effect_result(input: &VerifiedNodeInput, output: &str) -> NodeExecutionResult {
            let receipt = Self::receipt(input, &format!("fake.{}", input.frozen.node.type_name));
            NodeExecutionResult {
                outputs: BTreeMap::from([(
                    output.into(),
                    NodeOutputValue {
                        kind: NodeOutputKind::Receipt,
                        value: serde_json::json!({ "receipt": receipt, "node": input.frozen.node.id }),
                        artifact_reference: None,
                    },
                )]),
                receipt: Some(receipt),
                evidence: None,
                summary: serde_json::json!({ "fake": true }),
            }
        }
    }

    #[async_trait]
    impl DockerComposeExecutionBackend for FakeDockerBackend {
        async fn execute(
            &self,
            node_type: &str,
            input: VerifiedNodeInput,
            context: NodeExecutionContext,
        ) -> Result<NodeExecutionResult, NodeFailure> {
            let result = match node_type {
                "source.snapshot" => {
                    if self.mode == FakeMode::BlockSource {
                        self.deploy_started.notify_waiters();
                        context.cancellation.cancelled().await;
                        return Err(NodeFailure::canceled());
                    }
                    NodeExecutionResult::output(
                        "source",
                        NodeOutputValue {
                            kind: NodeOutputKind::Scalar,
                            value: serde_json::to_value(FrozenSourceSnapshot {
                                source_ref: "workspace".into(),
                                revision: "0123456789abcdef0123456789abcdef01234567".into(),
                                dirty: false,
                                snapshot_digest: format!("sha256:{}", "1".repeat(64)),
                                metadata_digest: format!("sha256:{}", "2".repeat(64)),
                            })
                            .unwrap(),
                            artifact_reference: None,
                        },
                    )
                }
                "build.docker-buildx" => NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&self.image).unwrap(),
                        artifact_reference: Some(self.image.artifact_reference.clone()),
                    },
                ),
                "build.package-script" | "artifact.collect" => NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&self.static_bundle).unwrap(),
                        artifact_reference: Some(self.static_bundle.artifact_reference.clone()),
                    },
                ),
                "artifact.bundle-compose" => NodeExecutionResult::output(
                    "bundle",
                    NodeOutputValue {
                        kind: NodeOutputKind::Artifact,
                        value: serde_json::to_value(&self.bundle).unwrap(),
                        artifact_reference: Some(self.bundle.artifact_reference.clone()),
                    },
                ),
                "target.preflight" => NodeExecutionResult::output(
                    "target",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: serde_json::json!({
                            "identity": FrozenTargetIdentity {
                                target_id: input.frozen.targets[0].id.clone(),
                                connection_profile_id: input.frozen.targets[0].connection_profile_id.clone(),
                                profile_revision: 1,
                                host_identity_digest: self.host_identity_digest.clone(),
                                remote_root: input.frozen.targets[0].remote_root.clone(),
                                capabilities_digest: format!("sha256:{}", "4".repeat(64)),
                            },
                            "currentRelease": FrozenReleaseIdentity {
                                release_id: "release-previous".into(),
                                artifact_content_digest: format!("sha256:{}", "5".repeat(64)),
                                layout_digest: format!("sha256:{}", "6".repeat(64)),
                            },
                        }),
                        artifact_reference: None,
                    },
                ),
                "release.create-candidate" => {
                    let content_digest = if input
                        .frozen
                        .node
                        .config
                        .get("strategy")
                        .and_then(Value::as_str)
                        == Some("staticFiles")
                    {
                        self.static_bundle.content_digest.clone()
                    } else {
                        self.bundle.content_digest.clone()
                    };
                    NodeExecutionResult::output(
                        "candidate",
                        NodeOutputValue {
                            kind: NodeOutputKind::Scalar,
                            value: serde_json::json!({
                                "targetId": "production",
                                "targetRelease": FrozenReleaseIdentity {
                                    release_id: "release-target".into(),
                                    artifact_content_digest: content_digest,
                                    layout_digest: format!("sha256:{}", "7".repeat(64)),
                                },
                                "currentRelease": FrozenReleaseIdentity {
                                    release_id: "release-previous".into(),
                                    artifact_content_digest: format!("sha256:{}", "5".repeat(64)),
                                    layout_digest: format!("sha256:{}", "6".repeat(64)),
                                },
                                "previousRelease": FrozenReleaseIdentity {
                                    release_id: "release-previous".into(),
                                    artifact_content_digest: format!("sha256:{}", "5".repeat(64)),
                                    layout_digest: format!("sha256:{}", "6".repeat(64)),
                                },
                            }),
                            artifact_reference: None,
                        },
                    )
                }
                "transfer.sftp" => Self::effect_result(&input, "transfer"),
                "release.prepare-compose" => Self::effect_result(&input, "release"),
                "release.prepare-files" => Self::effect_result(&input, "release"),
                "runtime.load-image" => Self::effect_result(&input, "image"),
                "deploy.compose" if self.mode == FakeMode::AmbiguousDeploy => {
                    return Err(NodeFailure::ambiguous(
                        "disconnect",
                        "connection dropped after launch",
                    ));
                }
                "deploy.compose" | "deploy.static-switch" if self.mode == FakeMode::BlockDeploy => {
                    self.deploy_started.notify_waiters();
                    context.cancellation.cancelled().await;
                    return Err(NodeFailure::canceled());
                }
                "deploy.compose" => Self::effect_result(&input, "activation"),
                "deploy.static-switch" => Self::effect_result(&input, "activation"),
                "verify.http" if self.mode == FakeMode::VerificationFailure => {
                    return Err(NodeFailure::definite(
                        "verificationFailed",
                        "simulated health failure",
                    ));
                }
                "verify.http" => {
                    let plan = input.immutable_plan.as_ref().unwrap();
                    let evidence = VerificationEvidence {
                        schema_version: 1,
                        evidence_type: "verify.http".into(),
                        run_id: input.frozen.run_id.clone(),
                        node_id: input.frozen.node.id.clone(),
                        target_id: plan.target.target_id.clone(),
                        plan_digest: plan.plan_digest.clone(),
                        observed_at: current_timestamp_ms(),
                        outcome: "passed".into(),
                        payload_digest: format!("sha256:{}", "8".repeat(64)),
                    };
                    NodeExecutionResult {
                        outputs: BTreeMap::from([(
                            "evidence".into(),
                            NodeOutputValue {
                                kind: NodeOutputKind::Evidence,
                                value: serde_json::json!({ "evidence": evidence }),
                                artifact_reference: None,
                            },
                        )]),
                        receipt: None,
                        evidence: Some(evidence),
                        summary: serde_json::json!({ "healthy": true }),
                    }
                }
                "proxy.nginx-reload" => Self::effect_result(&input, "activation"),
                "release.commit" => Self::effect_result(&input, "activeRelease"),
                "finalize.notify" if self.mode == FakeMode::FinalizerFailure => {
                    return Err(NodeFailure::definite(
                        "notification",
                        "simulated notification failure",
                    ));
                }
                "finalize.notify" => NodeExecutionResult::output(
                    "notified",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: Value::Bool(true),
                        artifact_reference: None,
                    },
                ),
                other => {
                    return Err(NodeFailure::definite(
                        "unsupported",
                        format!("unexpected fake node {other}"),
                    ))
                }
            };
            if result.receipt.is_some() {
                self.ledgers
                    .lock()
                    .unwrap()
                    .insert(input.idempotency_key, result.clone());
            }
            Ok(result)
        }

        async fn reconcile(
            &self,
            _node_type: &str,
            input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeReconcileResult, NodeFailure> {
            Ok(self
                .ledgers
                .lock()
                .unwrap()
                .get(&input.idempotency_key)
                .cloned()
                .map(NodeReconcileResult::Succeeded)
                .unwrap_or(NodeReconcileResult::NotStarted))
        }

        async fn compensate(
            &self,
            node_type: &str,
            input: CompensationInput,
            _context: NodeExecutionContext,
        ) -> Result<CompensationResult, NodeFailure> {
            self.compensations.fetch_add(1, Ordering::SeqCst);
            if node_type == "deploy.static-switch" && input.frozen_verification.is_some() {
                self.static_restore_reverified
                    .fetch_add(1, Ordering::SeqCst);
            }
            let plan = input.verified.immutable_plan.as_ref().unwrap();
            Ok(CompensationResult::Succeeded(EffectReceipt {
                schema_version: 1,
                receipt_type: format!("fake.compensate.{node_type}"),
                operation_id: format!(
                    "fake-compensate-{}-{}",
                    input.verified.frozen.node.id, input.verified.attempt
                ),
                run_id: input.verified.frozen.run_id.clone(),
                node_id: input.verified.frozen.node.id.clone(),
                attempt: input.verified.attempt,
                target_id: plan.target.target_id.clone(),
                plan_digest: plan.plan_digest.clone(),
                payload_digest: format!("sha256:{}", "9".repeat(64)),
            }))
        }
    }

    struct CoordinatorFixture {
        _directory: tempfile::TempDir,
        database: Database,
        runtime: DeploymentWorkflowRuntime,
        executors: DeploymentNodeExecutorRegistry,
        backend: Arc<FakeDockerBackend>,
        workflow_id: String,
    }

    fn digest(bytes: &[u8]) -> String {
        let digest = Sha256::digest(bytes);
        format!(
            "sha256:{}",
            digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    }

    fn publish_fake_artifacts(
        cas: &DeploymentArtifactCas,
        directory: &Path,
    ) -> (ArtifactHandle, ArtifactHandle, ArtifactHandle) {
        let image_path = directory.join("fake-image.tar");
        let compose_path = directory.join("compose.yml");
        fs::write(&image_path, b"fake image archive").unwrap();
        fs::write(
            &compose_path,
            b"services:\n  web:\n    image: example/web:release-target\n",
        )
        .unwrap();
        let image_digest = digest(b"fake image archive");
        let compose_digest = digest(b"services:\n  web:\n    image: example/web:release-target\n");
        let source = ArtifactSource {
            revision: "0123456789abcdef0123456789abcdef01234567".into(),
            dirty: false,
            snapshot_digest: format!("sha256:{}", "1".repeat(64)),
        };
        let image_component = ArtifactDescriptor {
            name: "image.tar".into(),
            role: ArtifactRole::Application,
            media_type: "application/vnd.shellspan.oci-image.tar".into(),
            digest: image_digest.clone(),
            size: b"fake image archive".len() as u64,
            platform: None,
            annotations: BTreeMap::from([
                ("imageReference".into(), "example/web:release-target".into()),
                ("imageId".into(), format!("sha256:{}", "a".repeat(64))),
            ]),
        };
        let image = cas
            .publish_bundle(
                &ArtifactBundleManifest {
                    schema_version: 2,
                    artifact_type: super::super::node_registry::ARTIFACT_TYPE_DOCKER_IMAGE.into(),
                    source: source.clone(),
                    components: vec![image_component.clone()],
                    producer: ArtifactProducer {
                        node_type: "build.docker-buildx".into(),
                        node_type_version: 2,
                        config_digest: format!("sha256:{}", "2".repeat(64)),
                    },
                    annotations: BTreeMap::new(),
                },
                &[ArtifactBlobSource {
                    digest: image_digest.clone(),
                    path: image_path.clone(),
                }],
            )
            .unwrap()
            .handle;
        let bundle = cas
            .publish_bundle(
                &ArtifactBundleManifest {
                    schema_version: 2,
                    artifact_type: super::super::node_registry::ARTIFACT_TYPE_COMPOSE_RELEASE
                        .into(),
                    source,
                    components: vec![
                        image_component,
                        ArtifactDescriptor {
                            name: "compose.yml".into(),
                            role: ArtifactRole::DeploymentConfig,
                            media_type: "application/vnd.shellspan.compose+yaml".into(),
                            digest: compose_digest.clone(),
                            size: b"services:\n  web:\n    image: example/web:release-target\n"
                                .len() as u64,
                            platform: None,
                            annotations: BTreeMap::new(),
                        },
                    ],
                    producer: ArtifactProducer {
                        node_type: "artifact.bundle-compose".into(),
                        node_type_version: 1,
                        config_digest: format!("sha256:{}", "3".repeat(64)),
                    },
                    annotations: BTreeMap::new(),
                },
                &[
                    ArtifactBlobSource {
                        digest: image_digest,
                        path: image_path,
                    },
                    ArtifactBlobSource {
                        digest: compose_digest,
                        path: compose_path,
                    },
                ],
            )
            .unwrap()
            .handle;
        let static_path = directory.join("file-tree.tar.zst");
        fs::write(&static_path, b"fake deterministic file tree").unwrap();
        let static_digest = digest(b"fake deterministic file tree");
        let static_bundle = cas
            .publish_bundle(
                &ArtifactBundleManifest {
                    schema_version: 2,
                    artifact_type: super::super::node_registry::ARTIFACT_TYPE_FILE_TREE.into(),
                    source: ArtifactSource {
                        revision: "0123456789abcdef0123456789abcdef01234567".into(),
                        dirty: false,
                        snapshot_digest: format!("sha256:{}", "1".repeat(64)),
                    },
                    components: vec![ArtifactDescriptor {
                        name: "file-tree.tar.zst".into(),
                        role: ArtifactRole::Application,
                        media_type: "application/vnd.shellspan.file-tree.tar+zstd".into(),
                        digest: static_digest.clone(),
                        size: b"fake deterministic file tree".len() as u64,
                        platform: None,
                        annotations: BTreeMap::new(),
                    }],
                    producer: ArtifactProducer {
                        node_type: "build.package-script".into(),
                        node_type_version: 1,
                        config_digest: format!("sha256:{}", "4".repeat(64)),
                    },
                    annotations: BTreeMap::new(),
                },
                &[ArtifactBlobSource {
                    digest: static_digest,
                    path: static_path,
                }],
            )
            .unwrap()
            .handle;
        (image, bundle, static_bundle)
    }

    fn coordinator_fixture(
        mode: FakeMode,
        with_finalizer: bool,
        with_nginx: bool,
    ) -> CoordinatorFixture {
        let directory = tempfile::tempdir().unwrap();
        let database = test_db();
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO profiles (
                            id, name, host, port, username, auth_method, created_at, updated_at
                         ) VALUES (
                            'profile-production', 'Production', 'example.test', 22,
                            'deploy', 'password', 1, 1
                         )",
                        [],
                    )
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let runtime = DeploymentWorkflowRuntime::enabled_for_tests(directory.path()).unwrap();
        let (image, bundle, static_bundle) =
            publish_fake_artifacts(runtime.artifacts(), directory.path());
        let backend = Arc::new(FakeDockerBackend {
            mode,
            image,
            bundle,
            static_bundle,
            ledgers: Mutex::new(BTreeMap::new()),
            compensations: AtomicUsize::new(0),
            static_restore_reverified: AtomicUsize::new(0),
            deploy_started: tokio::sync::Notify::new(),
            host_identity_digest: canonical_sha256(&serde_json::json!({
                "profileId": "profile-production",
                "host": "example.test",
                "port": 22,
                "username": "deploy",
                "authMethod": "password",
                "jumpHost": Value::Null,
            }))
            .unwrap(),
        });
        let executors = docker_compose_executor_registry(backend.clone()).unwrap();
        let mut definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        if with_finalizer {
            definition.nodes.push(WorkflowNodeDefinition {
                id: "notify".into(),
                type_name: "finalize.notify".into(),
                type_version: 1,
                display_name: "Notify".into(),
                inputs: BTreeMap::new(),
                config: serde_json::json!({ "channel": "system", "events": ["succeeded", "failed"] }),
                timeout_seconds: 30,
                retry: super::super::workflow_schema::NodeRetryPolicy {
                    max_attempts: 1,
                    initial_backoff_seconds: 0,
                    max_backoff_seconds: 0,
                },
                run_when: super::super::workflow_schema::NodeRunWhen::Always,
                condition: None,
            });
        }
        if with_nginx {
            let preflight = definition
                .nodes
                .iter_mut()
                .find(|node| node.id == "preflight")
                .unwrap();
            preflight
                .config
                .get_mut("requiredCapabilities")
                .and_then(Value::as_array_mut)
                .unwrap()
                .push(Value::String("nginx".into()));
            definition.nodes.push(WorkflowNodeDefinition {
                id: "nginx".into(),
                type_name: "proxy.nginx-reload".into(),
                type_version: 2,
                display_name: "Reload Nginx".into(),
                inputs: BTreeMap::from([(
                    "evidence".into(),
                    super::super::workflow_schema::PortBinding {
                        from_node_id: "verify".into(),
                        from_port: "evidence".into(),
                    },
                )]),
                config: serde_json::json!({ "targetId": "production" }),
                timeout_seconds: 60,
                retry: super::super::workflow_schema::NodeRetryPolicy {
                    max_attempts: 1,
                    initial_backoff_seconds: 0,
                    max_backoff_seconds: 0,
                },
                run_when: super::super::workflow_schema::NodeRunWhen::AllSucceeded,
                condition: None,
            });
            let commit = definition
                .nodes
                .iter_mut()
                .find(|node| node.id == "commit")
                .unwrap();
            commit.inputs.insert(
                "activation".into(),
                super::super::workflow_schema::PortBinding {
                    from_node_id: "nginx".into(),
                    from_port: "activation".into(),
                },
            );
            definition.outputs.insert(
                "nginxActivation".into(),
                super::super::workflow_schema::PortBinding {
                    from_node_id: "nginx".into(),
                    from_port: "activation".into(),
                },
            );
        }
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Compose production".into(),
                definition,
                layout: None,
                enabled: true,
            })
            .unwrap();
        CoordinatorFixture {
            _directory: directory,
            database,
            runtime,
            executors,
            backend,
            workflow_id: workflow.id,
        }
    }

    fn static_coordinator_fixture(mode: FakeMode) -> CoordinatorFixture {
        let directory = tempfile::tempdir().unwrap();
        let database = test_db();
        database
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO profiles (
                            id, name, host, port, username, auth_method, created_at, updated_at
                         ) VALUES (
                            'profile-production', 'Production', 'example.test', 22,
                            'deploy', 'password', 1, 1
                         )",
                        [],
                    )
                    .unwrap();
                Ok(())
            })
            .unwrap();
        let runtime = DeploymentWorkflowRuntime::enabled_for_tests(directory.path()).unwrap();
        let (image, bundle, static_bundle) =
            publish_fake_artifacts(runtime.artifacts(), directory.path());
        let backend = Arc::new(FakeDockerBackend {
            mode,
            image,
            bundle,
            static_bundle,
            ledgers: Mutex::new(BTreeMap::new()),
            compensations: AtomicUsize::new(0),
            static_restore_reverified: AtomicUsize::new(0),
            deploy_started: tokio::sync::Notify::new(),
            host_identity_digest: canonical_sha256(&serde_json::json!({
                "profileId": "profile-production",
                "host": "example.test",
                "port": 22,
                "username": "deploy",
                "authMethod": "password",
                "jumpHost": Value::Null,
            }))
            .unwrap(),
        });
        let executors = docker_compose_executor_registry(backend.clone()).unwrap();
        let definition = serde_json::from_str(include_str!(
            "../../../protocol/deployment/fixtures/static-site-workflow.json"
        ))
        .unwrap();
        let workflow = database
            .create_deployment_workflow(&CreateDeploymentWorkflowInput {
                name: "Static production".into(),
                definition,
                layout: None,
                enabled: true,
            })
            .unwrap();
        CoordinatorFixture {
            _directory: directory,
            database,
            runtime,
            executors,
            backend,
            workflow_id: workflow.id,
        }
    }

    async fn prepare_and_approve(fixture: &CoordinatorFixture) -> PreparedRun {
        let prepared = prepare_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            PrepareRunRequest {
                run_id: format!("run-{}", uuid::Uuid::new_v4()),
                workflow_id: fixture.workflow_id.clone(),
                workflow_revision: 1,
                operation_kind: WorkflowRunOperationKind::Deploy,
                trigger_kind: WorkflowRunTriggerKind::Manual,
                parameters: BTreeMap::new(),
            },
        )
        .await
        .unwrap();
        approve_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        prepared
    }

    async fn execute_prepared(fixture: &CoordinatorFixture, prepared: &PreparedRun) {
        verify_pre_start_frozen_inputs(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .await
        .unwrap();
        let (_, cancellation) = begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        execute_approved_run(
            fixture.database.clone(),
            fixture.runtime.clone(),
            fixture.executors.clone(),
            prepared.run_id.clone(),
            prepared.plan_digest.clone(),
            cancellation,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn frozen_target_artifact_plan_and_executor_drift_fail_closed() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            PrepareRunRequest {
                run_id: format!("run-{}", uuid::Uuid::new_v4()),
                workflow_id: fixture.workflow_id.clone(),
                workflow_revision: 1,
                operation_kind: WorkflowRunOperationKind::Deploy,
                trigger_kind: WorkflowRunTriggerKind::Manual,
                parameters: BTreeMap::new(),
            },
        )
        .await
        .unwrap();
        let stored = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        let original: ImmutableRunPlan = serde_json::from_value(stored.plan.clone()).unwrap();

        let mut plan = original.clone();
        plan.plan_digest = format!("sha256:{}", "0".repeat(64));
        assert!(
            ensure_frozen_plan_integrity(&fixture.database, &fixture.runtime, &stored, &plan)
                .unwrap_err()
                .contains("PLAN_INTEGRITY")
        );

        let mut plan = original.clone();
        plan.target.profile_revision = plan.target.profile_revision.saturating_add(1);
        plan.plan_digest = plan_digest(&plan).unwrap();
        let mut run = stored.clone();
        run.plan_digest = plan.plan_digest.clone();
        assert_eq!(
            ensure_frozen_plan_integrity(&fixture.database, &fixture.runtime, &run, &plan)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_TARGET_DRIFT"
        );

        let mut plan = original.clone();
        plan.target_release.artifact_content_digest = format!("sha256:{}", "9".repeat(64));
        plan.plan_digest = plan_digest(&plan).unwrap();
        let mut run = stored.clone();
        run.plan_digest = plan.plan_digest.clone();
        assert_eq!(
            ensure_frozen_plan_integrity(&fixture.database, &fixture.runtime, &run, &plan)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_ARTIFACT_DRIFT"
        );

        let mut plan = original;
        *plan.executor_versions.values_mut().next().unwrap() = "drifted/2".into();
        plan.plan_digest = plan_digest(&plan).unwrap();
        let mut run = stored;
        run.plan_digest = plan.plan_digest.clone();
        assert_eq!(
            ensure_frozen_plan_integrity(&fixture.database, &fixture.runtime, &run, &plan)
                .unwrap_err(),
            "DEPLOYMENT_WORKFLOW_EXECUTOR_VERSION_DRIFT"
        );
    }

    #[tokio::test]
    async fn mock_compose_end_to_end_succeeds_and_releases_the_cas_lease() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::Succeeded);
        let receipts = fixture
            .database
            .list_deployment_effect_receipts(&prepared.run_id)
            .unwrap();
        assert_eq!(receipts.len(), 5);
        assert!(receipts
            .iter()
            .all(|receipt| receipt.plan_digest == prepared.plan_digest));
        let plan: ImmutableRunPlan = serde_json::from_value(run.plan).unwrap();
        let active = plan
            .artifacts
            .iter()
            .find(|handle| handle.content_digest == plan.target_release.artifact_content_digest)
            .unwrap();
        let retention = fixture
            .database
            .deployment_artifact_retention(&active.artifact_reference, current_timestamp_ms())
            .unwrap();
        assert_eq!(retention.lease_count, 0);
        assert!(retention.current_release);
    }

    #[tokio::test]
    async fn manual_rollback_creates_and_executes_a_new_approved_run() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let original = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &original).await;
        let original_run = fixture
            .database
            .get_deployment_run(&original.run_id)
            .unwrap()
            .unwrap();
        let original_plan: ImmutableRunPlan =
            serde_json::from_value(original_run.plan.clone()).unwrap();
        let selected_release_id = original_plan.target_release.release_id.clone();
        fixture
            .database
            .commit_deployment_release_artifact(
                &fixture.workflow_id,
                &original.run_id,
                &fixture.backend.image.artifact_reference,
                "release-previous",
                current_timestamp_ms(),
            )
            .unwrap();
        let releases = fixture
            .database
            .list_deployment_releases(&fixture.workflow_id)
            .unwrap();
        assert!(releases
            .iter()
            .any(|release| { release.release_id == selected_release_id && release.rollbackable }));

        let rollback = prepare_rollback_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            PrepareRunRequest {
                run_id: format!("run-{}", uuid::Uuid::new_v4()),
                workflow_id: fixture.workflow_id.clone(),
                workflow_revision: 1,
                operation_kind: WorkflowRunOperationKind::Rollback,
                trigger_kind: WorkflowRunTriggerKind::Manual,
                parameters: BTreeMap::new(),
            },
            selected_release_id.clone(),
        )
        .await
        .unwrap();
        let prepared = fixture
            .database
            .get_deployment_run(&rollback.run_id)
            .unwrap()
            .unwrap();
        let rollback_plan: ImmutableRunPlan = serde_json::from_value(prepared.plan).unwrap();
        assert_eq!(prepared.operation_kind, WorkflowRunOperationKind::Rollback);
        assert_eq!(rollback_plan.target_release.release_id, selected_release_id);
        assert_eq!(rollback_plan.artifacts.len(), 1);
        assert_ne!(rollback.run_id, original.run_id);

        approve_run(
            &fixture.database,
            &fixture.runtime,
            &rollback.run_id,
            &rollback.plan_digest,
        )
        .unwrap();
        execute_prepared(&fixture, &rollback).await;
        let rollback_record = fixture
            .database
            .get_deployment_run(&rollback.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(rollback_record.status, DeploymentRunStatus::Succeeded);
        assert_eq!(
            fixture
                .database
                .get_deployment_run(&original.run_id)
                .unwrap()
                .unwrap()
                .status,
            DeploymentRunStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn audit_export_is_bounded_redacted_and_complete_after_execution() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let document = super::super::audit::build_deployment_audit_document(
            &fixture.database,
            &prepared.run_id,
        )
        .unwrap();
        let text = String::from_utf8(document.bytes).unwrap();
        assert!(text.contains("\"schemaVersion\": 3"));
        assert!(text.contains(&prepared.plan_digest));
        assert!(text.contains("\"remoteText\""));
        assert!(!text.contains("password="));
        assert!(!text.contains("example.test"));
        assert!(text.len() <= super::super::security::MAX_AUDIT_EXPORT_BYTES);
    }

    #[tokio::test]
    async fn mock_static_site_end_to_end_uses_the_shared_coordinator_and_ledger() {
        let fixture = static_coordinator_fixture(FakeMode::Success);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::Succeeded);
        let receipts = fixture
            .database
            .list_deployment_effect_receipts(&prepared.run_id)
            .unwrap();
        assert_eq!(receipts.len(), 4);
        assert!(receipts.iter().any(|receipt| receipt.node_id == "switch"));
        assert!(fixture
            .database
            .list_deployment_run_nodes(&prepared.run_id)
            .unwrap()
            .iter()
            .all(|node| node.status == "succeeded"));
    }

    #[tokio::test]
    async fn static_verification_failure_restores_only_the_frozen_release_and_reverifies() {
        let fixture = static_coordinator_fixture(FakeMode::VerificationFailure);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::Failed);
        assert_eq!(
            fixture
                .backend
                .static_restore_reverified
                .load(Ordering::SeqCst),
            1
        );
        assert_eq!(fixture.backend.compensations.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn static_cancel_before_switch_never_activates_the_target_release() {
        let fixture = static_coordinator_fixture(FakeMode::BlockDeploy);
        let prepared = prepare_and_approve(&fixture).await;
        let (_, cancellation) = begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        let database = fixture.database.clone();
        let runtime = fixture.runtime.clone();
        let executors = fixture.executors.clone();
        let run_id = prepared.run_id.clone();
        let plan_digest = prepared.plan_digest.clone();
        let execution = tokio::spawn(async move {
            execute_approved_run(
                database,
                runtime,
                executors,
                run_id,
                plan_digest,
                cancellation,
            )
            .await
            .unwrap();
        });
        fixture.backend.deploy_started.notified().await;
        cancel_run(&fixture.database, &fixture.runtime, &prepared.run_id).unwrap();
        execution.await.unwrap();
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::Canceled);
        assert_eq!(fixture.backend.compensations.load(Ordering::SeqCst), 2);
        let nodes = fixture
            .database
            .list_deployment_run_nodes(&prepared.run_id)
            .unwrap();
        assert_eq!(
            nodes
                .iter()
                .find(|node| node.node_id == "switch")
                .unwrap()
                .status,
            "canceled"
        );
    }

    #[tokio::test]
    async fn effect_execution_rejects_missing_or_different_exact_approval_digest() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            PrepareRunRequest {
                run_id: format!("run-{}", uuid::Uuid::new_v4()),
                workflow_id: fixture.workflow_id.clone(),
                workflow_revision: 1,
                operation_kind: WorkflowRunOperationKind::Deploy,
                trigger_kind: WorkflowRunTriggerKind::Manual,
                parameters: BTreeMap::new(),
            },
        )
        .await
        .unwrap();
        assert!(begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .is_err());
        assert!(approve_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &format!("sha256:{}", "f".repeat(64)),
        )
        .is_err());
        let mut changed: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        changed.nodes[0].display_name = "Changed source".into();
        fixture
            .database
            .update_deployment_workflow(
                &fixture.workflow_id,
                1,
                &UpdateDeploymentWorkflowInput {
                    name: "Changed workflow".into(),
                    definition: changed,
                    enabled: true,
                },
            )
            .unwrap();
        assert!(approve_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap_err()
        .contains("DRIFT"));
        assert!(fixture
            .database
            .list_deployment_effect_receipts(&prepared.run_id)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn health_failure_runs_frozen_compensation_and_finishes_failed() {
        let fixture = coordinator_fixture(FakeMode::VerificationFailure, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::Failed);
        assert_eq!(fixture.backend.compensations.load(Ordering::SeqCst), 4);
        assert!(fixture
            .database
            .list_deployment_run_nodes(&prepared.run_id)
            .unwrap()
            .iter()
            .filter(|node| {
                matches!(
                    node.node_id.as_str(),
                    "transfer" | "prepare" | "load" | "deploy"
                )
            })
            .all(|node| node.status == "compensated"));
    }

    #[tokio::test]
    async fn ambiguous_effect_is_state_unknown_and_is_not_blindly_retried() {
        let fixture = coordinator_fixture(FakeMode::AmbiguousDeploy, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let run = fixture
            .database
            .get_deployment_run(&prepared.run_id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, DeploymentRunStatus::StateUnknown);
        assert_eq!(fixture.backend.compensations.load(Ordering::SeqCst), 0);
        let attempts = fixture
            .database
            .list_deployment_node_attempts(&prepared.run_id, "deploy", None, 10)
            .unwrap();
        assert_eq!(attempts.items.len(), 1);
        assert_eq!(attempts.items[0].status, NodeAttemptStatus::StateUnknown);
    }

    #[tokio::test]
    async fn startup_reconciliation_proves_no_effect_then_allows_exact_plan_resume() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        let (_, cancellation) = begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        drop(cancellation);
        fixture.runtime.finish_run(&prepared.run_id);
        let reconciled = reconcile_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            &prepared.run_id,
        )
        .await
        .unwrap();
        assert_eq!(reconciled.status, "approved");
        assert!(reconciled.evidence_complete);
        execute_prepared(&fixture, &prepared).await;
        assert_eq!(
            fixture
                .database
                .get_deployment_run(&prepared.run_id)
                .unwrap()
                .unwrap()
                .status,
            DeploymentRunStatus::Succeeded
        );
    }

    #[tokio::test]
    async fn startup_reconciliation_honors_a_cancel_requested_before_effects() {
        let fixture = coordinator_fixture(FakeMode::Success, false, false);
        let prepared = prepare_and_approve(&fixture).await;
        let (_, cancellation) = begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        cancel_run(&fixture.database, &fixture.runtime, &prepared.run_id).unwrap();
        drop(cancellation);
        fixture.runtime.finish_run(&prepared.run_id);
        let reconciled = reconcile_run(
            &fixture.database,
            &fixture.runtime,
            &fixture.executors,
            &prepared.run_id,
        )
        .await
        .unwrap();
        assert_eq!(reconciled.status, "canceled");
        assert!(reconciled.evidence_complete);
    }

    #[tokio::test]
    async fn cooperative_cancel_after_effects_compensates_before_canceled() {
        let fixture = Arc::new(coordinator_fixture(FakeMode::BlockDeploy, false, false));
        let prepared = prepare_and_approve(&fixture).await;
        let (_, cancellation) = begin_start_run(
            &fixture.database,
            &fixture.runtime,
            &prepared.run_id,
            &prepared.plan_digest,
        )
        .unwrap();
        let execution_fixture = fixture.clone();
        let execution_prepared = prepared.clone();
        let task = tokio::spawn(async move {
            execute_approved_run(
                execution_fixture.database.clone(),
                execution_fixture.runtime.clone(),
                execution_fixture.executors.clone(),
                execution_prepared.run_id.clone(),
                execution_prepared.plan_digest.clone(),
                cancellation,
            )
            .await
            .unwrap();
        });
        fixture.backend.deploy_started.notified().await;
        cancel_run(&fixture.database, &fixture.runtime, &prepared.run_id).unwrap();
        task.await.unwrap();
        assert_eq!(
            fixture
                .database
                .get_deployment_run(&prepared.run_id)
                .unwrap()
                .unwrap()
                .status,
            DeploymentRunStatus::Canceled
        );
        assert_eq!(fixture.backend.compensations.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn preparation_build_is_cooperatively_cancelable_before_plan_freeze() {
        let fixture = Arc::new(coordinator_fixture(FakeMode::BlockSource, false, false));
        let run_id = format!("run-{}", uuid::Uuid::new_v4());
        let task_fixture = fixture.clone();
        let task_run_id = run_id.clone();
        let task = tokio::spawn(async move {
            prepare_run(
                &task_fixture.database,
                &task_fixture.runtime,
                &task_fixture.executors,
                PrepareRunRequest {
                    run_id: task_run_id,
                    workflow_id: task_fixture.workflow_id.clone(),
                    workflow_revision: 1,
                    operation_kind: WorkflowRunOperationKind::Deploy,
                    trigger_kind: WorkflowRunTriggerKind::Manual,
                    parameters: BTreeMap::new(),
                },
            )
            .await
        });
        fixture.backend.deploy_started.notified().await;
        assert!(fixture.runtime.cancel_run(&run_id).unwrap());
        assert!(task.await.unwrap().unwrap_err().contains("CANCELED"));
        assert!(fixture
            .database
            .get_deployment_run(&run_id)
            .unwrap()
            .is_none());
        assert!(!fixture.runtime.cancel_run(&run_id).unwrap());
    }

    #[tokio::test]
    async fn finalizer_failure_does_not_forge_the_main_deployment_result() {
        let fixture = coordinator_fixture(FakeMode::FinalizerFailure, true, false);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        assert_eq!(
            fixture
                .database
                .get_deployment_run(&prepared.run_id)
                .unwrap()
                .unwrap()
                .status,
            DeploymentRunStatus::Succeeded
        );
        let notify = fixture
            .database
            .list_deployment_run_nodes(&prepared.run_id)
            .unwrap()
            .into_iter()
            .find(|node| node.node_id == "notify")
            .unwrap();
        assert_eq!(notify.status, "failed");
    }

    #[tokio::test]
    async fn optional_nginx_action_is_ordered_before_release_commit_and_receipted() {
        let fixture = coordinator_fixture(FakeMode::Success, false, true);
        let prepared = prepare_and_approve(&fixture).await;
        execute_prepared(&fixture, &prepared).await;
        let nodes = fixture
            .database
            .list_deployment_run_nodes(&prepared.run_id)
            .unwrap();
        assert_eq!(
            nodes
                .iter()
                .find(|node| node.node_id == "nginx")
                .unwrap()
                .status,
            "succeeded"
        );
        let receipts = fixture
            .database
            .list_deployment_effect_receipts(&prepared.run_id)
            .unwrap();
        assert!(receipts.iter().any(|receipt| receipt.node_id == "nginx"));
        assert_eq!(
            fixture
                .database
                .get_deployment_run(&prepared.run_id)
                .unwrap()
                .unwrap()
                .status,
            DeploymentRunStatus::Succeeded
        );
    }

    struct RetryExecutor {
        executions: AtomicUsize,
        reconciliations: AtomicUsize,
        keys: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DeploymentNodeExecutor for RetryExecutor {
        fn node_type(&self) -> (&'static str, u32) {
            ("source.snapshot", 1)
        }

        fn executor_version(&self) -> &'static str {
            "retry-test"
        }

        fn validate_config(&self, _config: &Value) -> Result<(), String> {
            Ok(())
        }

        fn plan(&self, input: FrozenNodeInput) -> Result<PlannedNode, String> {
            let registry = DeploymentNodeRegistry::mvp();
            plan_from_descriptor(
                registry.find("source.snapshot", 1).unwrap(),
                self.executor_version(),
                &input,
            )
        }

        async fn execute(
            &self,
            input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeExecutionResult, NodeFailure> {
            self.keys.lock().unwrap().push(input.idempotency_key);
            if self.executions.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(NodeFailure::definite("transient", "retry me"));
            }
            Ok(NodeExecutionResult::output(
                "source",
                NodeOutputValue {
                    kind: NodeOutputKind::Scalar,
                    value: Value::String("ok".into()),
                    artifact_reference: None,
                },
            ))
        }

        async fn reconcile(
            &self,
            _input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeReconcileResult, NodeFailure> {
            self.reconciliations.fetch_add(1, Ordering::SeqCst);
            Ok(NodeReconcileResult::SafeToRetry)
        }

        async fn compensate(
            &self,
            _input: CompensationInput,
            _context: NodeExecutionContext,
        ) -> Result<CompensationResult, NodeFailure> {
            Ok(CompensationResult::NotRequired)
        }
    }

    #[tokio::test]
    async fn retry_is_attempt_scoped_and_always_reconciles_first() {
        let mut definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        let mut node = definition.nodes.remove(0);
        node.retry.max_attempts = 2;
        let executor = Arc::new(RetryExecutor {
            executions: AtomicUsize::new(0),
            reconciliations: AtomicUsize::new(0),
            keys: Mutex::new(Vec::new()),
        });
        let mut executors = DeploymentNodeExecutorRegistry::default();
        executors.register(executor.clone()).unwrap();
        let result = execute_with_retry(
            &executors,
            &DeploymentNodeRegistry::mvp(),
            FrozenNodeInput {
                run_id: "run-retry".into(),
                node,
                targets: definition.targets,
                inputs: BTreeMap::new(),
            },
            None,
            &format!("sha256:{}", "a".repeat(64)),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.attempt, 2);
        assert_eq!(executor.executions.load(Ordering::SeqCst), 2);
        assert_eq!(executor.reconciliations.load(Ordering::SeqCst), 1);
        let keys = executor.keys.lock().unwrap();
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    struct FailFastExecutor {
        executed: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DeploymentNodeExecutor for FailFastExecutor {
        fn node_type(&self) -> (&'static str, u32) {
            ("source.snapshot", 1)
        }

        fn executor_version(&self) -> &'static str {
            "fail-fast-test"
        }

        fn validate_config(&self, _config: &Value) -> Result<(), String> {
            Ok(())
        }

        fn plan(&self, input: FrozenNodeInput) -> Result<PlannedNode, String> {
            plan_from_descriptor(
                DeploymentNodeRegistry::mvp()
                    .find("source.snapshot", 1)
                    .unwrap(),
                self.executor_version(),
                &input,
            )
        }

        async fn execute(
            &self,
            input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeExecutionResult, NodeFailure> {
            self.executed
                .lock()
                .unwrap()
                .push(input.frozen.node.id.clone());
            if input.frozen.node.id == "fail" {
                Err(NodeFailure::definite("expected", "stop"))
            } else {
                Ok(NodeExecutionResult::output(
                    "source",
                    NodeOutputValue {
                        kind: NodeOutputKind::Scalar,
                        value: Value::Bool(true),
                        artifact_reference: None,
                    },
                ))
            }
        }

        async fn reconcile(
            &self,
            _input: VerifiedNodeInput,
            _context: NodeExecutionContext,
        ) -> Result<NodeReconcileResult, NodeFailure> {
            Ok(NodeReconcileResult::FailedDefinitely(
                NodeFailure::definite("expected", "stop"),
            ))
        }

        async fn compensate(
            &self,
            _input: CompensationInput,
            _context: NodeExecutionContext,
        ) -> Result<CompensationResult, NodeFailure> {
            Ok(CompensationResult::NotRequired)
        }
    }

    #[tokio::test]
    async fn fail_fast_never_schedules_a_later_ready_layer() {
        let mut definition: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        let source = definition.nodes[0].clone();
        let mut fail = source.clone();
        fail.id = "fail".into();
        let mut later = source;
        later.id = "later".into();
        let approval = definition
            .nodes
            .iter()
            .find(|node| node.type_name == "control.approval")
            .unwrap()
            .clone();
        definition.nodes = vec![fail, later, approval.clone()];
        let base: super::super::workflow_schema::DeploymentWorkflowDefinition =
            serde_json::from_str(include_str!(
                "../../../protocol/deployment/fixtures/docker-compose-workflow.json"
            ))
            .unwrap();
        let mut compiled =
            compile_workflow_definition(&base, &DeploymentNodeRegistry::mvp()).unwrap();
        compiled.topology_layers =
            vec![vec!["fail".into()], vec!["later".into()], vec![approval.id]];
        let executor = Arc::new(FailFastExecutor {
            executed: Mutex::new(Vec::new()),
        });
        let mut executors = DeploymentNodeExecutorRegistry::default();
        executors.register(executor.clone()).unwrap();
        assert!(execute_pre_approval(
            "run-fail-fast",
            &definition,
            &compiled,
            &executors,
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .is_err());
        assert_eq!(*executor.executed.lock().unwrap(), vec!["fail"]);
    }
}
