use super::canonicalization::canonical_sha256;
use super::node_registry::{
    validate_identifier, validate_remote_root, DeploymentNodeRegistry, DeploymentNodeTypeSpec,
    ValidatedNodeConfig,
};
use super::port_types::DeploymentPortType;
use super::validation_error::{
    WorkflowValidationCode, WorkflowValidationError, WorkflowValidationErrors,
};
use super::workflow_schema::{
    ArtifactBundleManifest, ArtifactHandle, CompiledNodePlan, CompiledRunPlanDraft,
    DeploymentWorkflowDefinition, DeploymentWorkflowLayout, EffectClass, NodeCondition,
    NodeRunWhen, PlanRiskEntry, PlanRiskSummary, PlannedCompensation, PortBinding, RiskLevel,
    ScalarValue, WorkflowParameterType, ARTIFACT_MANIFEST_SCHEMA_VERSION,
    COMPILED_PLAN_DRAFT_SCHEMA_VERSION, LAYOUT_SCHEMA_VERSION, MAX_ARTIFACT_COMPONENTS,
    MAX_ARTIFACT_COMPONENT_BYTES, MAX_ARTIFACT_TOTAL_BYTES, MAX_CONDITION_VALUES,
    MAX_DISPLAY_NAME_BYTES, MAX_LAYOUT_JSON_BYTES, MAX_NODES, MAX_NODE_INPUTS, MAX_NODE_OUTPUTS,
    MAX_PARALLEL_LOCAL_NODES, MAX_PARAMETERS, MAX_RELEASES_TO_KEEP, MAX_RETRY_ATTEMPTS,
    MAX_RETRY_BACKOFF_SECONDS, MAX_SCALAR_STRING_BYTES, MAX_TARGETS, MAX_TIMEOUT_SECONDS,
    MAX_WORKFLOW_JSON_BYTES, MAX_WORKFLOW_OUTPUTS, WORKFLOW_SCHEMA_VERSION,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanDigestPayload<'a> {
    schema_version: u32,
    definition_digest: &'a str,
    topology_layers: &'a [Vec<String>],
    target_effect_lanes: &'a BTreeMap<String, Vec<String>>,
    nodes: &'a [CompiledNodePlan],
    risks: &'a PlanRiskSummary,
    compensations: &'a [PlannedCompensation],
    policy: &'a super::workflow_schema::WorkflowPolicy,
}

#[cfg(test)]
pub(crate) fn compile_workflow_json(
    json: &str,
    registry: &DeploymentNodeRegistry,
) -> Result<CompiledRunPlanDraft, WorkflowValidationErrors> {
    if json.len() > MAX_WORKFLOW_JSON_BYTES {
        return Err(WorkflowValidationErrors::one(
            WorkflowValidationError::new(
                WorkflowValidationCode::JsonTooLarge,
                format!("workflow JSON exceeds {MAX_WORKFLOW_JSON_BYTES} bytes"),
            )
            .at_path("$"),
        ));
    }
    let definition =
        serde_json::from_str::<DeploymentWorkflowDefinition>(json).map_err(|error| {
            WorkflowValidationErrors::one(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidJson,
                    format!("workflow JSON does not match the workflow schema: {error}"),
                )
                .at_path("$"),
            )
        })?;
    compile_workflow_definition(&definition, registry)
}

pub(crate) fn compile_workflow_definition(
    definition: &DeploymentWorkflowDefinition,
    registry: &DeploymentNodeRegistry,
) -> Result<CompiledRunPlanDraft, WorkflowValidationErrors> {
    let encoded_size = serde_json::to_vec(definition)
        .map_err(|error| {
            WorkflowValidationErrors::one(WorkflowValidationError::new(
                WorkflowValidationCode::InvalidJson,
                format!("failed to encode workflow definition: {error}"),
            ))
        })?
        .len();
    if encoded_size > MAX_WORKFLOW_JSON_BYTES {
        return Err(WorkflowValidationErrors::one(
            WorkflowValidationError::new(
                WorkflowValidationCode::JsonTooLarge,
                format!("workflow JSON exceeds {MAX_WORKFLOW_JSON_BYTES} bytes"),
            )
            .at_path("$"),
        ));
    }

    let mut errors = Vec::new();
    if definition.nodes.iter().any(|node| {
        node.type_name == "artifact.bundle-compose"
            && node
                .config
                .get("hostCompose")
                .is_some_and(|value| !value.is_null())
    }) && definition.nodes.iter().any(|node| {
        node.type_name == "source.snapshot"
            && node
                .config
                .get("sourceRef")
                .and_then(serde_json::Value::as_str)
                == Some("workspace")
    }) {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidNodeConfig,
                "existing Compose deployments require a committed Git sourceRef",
            )
            .at_path("nodes.source.config.sourceRef"),
        );
    }
    if definition.policy.automatic_restore
        && definition.nodes.iter().any(|node| {
            node.type_name == "artifact.bundle-compose"
                && node
                    .config
                    .get("hostCompose")
                    .is_some_and(|value| !value.is_null())
        })
    {
        errors.push(WorkflowValidationError::new(WorkflowValidationCode::InvalidNodeConfig,
            "existing Compose deployments require reviewed recovery; automaticRestore must be false")
            .at_path("policy.automaticRestore"));
    }
    validate_top_level(definition, &mut errors);

    let mut targets = BTreeSet::new();
    for (index, target) in definition.targets.iter().enumerate() {
        if let Err(message) = validate_identifier("target id", &target.id) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .at_path(format!("targets.{index}.id")),
            );
        }
        if !targets.insert(target.id.clone()) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::DuplicateIdentifier,
                    format!("duplicate target id '{}'", target.id),
                )
                .at_path(format!("targets.{index}.id")),
            );
        }
        if let Err(message) = validate_identifier(
            "connection profile reference",
            &target.connection_profile_id,
        ) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .at_path(format!("targets.{index}.connectionProfileId")),
            );
        }
        if let Err(message) = validate_remote_root(&target.remote_root) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidPath, message)
                    .at_path(format!("targets.{index}.remoteRoot")),
            );
        }
    }

    validate_parameters(definition, &mut errors);

    let mut node_by_id = BTreeMap::new();
    let mut spec_by_node = BTreeMap::new();
    let mut config_by_node = BTreeMap::new();
    for (index, node) in definition.nodes.iter().enumerate() {
        if let Err(message) = validate_identifier("node id", &node.id) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .for_node(node.id.clone())
                    .at_path(format!("nodes.{index}.id")),
            );
        }
        if node.display_name.is_empty() || node.display_name.len() > MAX_DISPLAY_NAME_BYTES {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!(
                        "displayName must contain between 1 and {MAX_DISPLAY_NAME_BYTES} bytes"
                    ),
                )
                .for_node(node.id.clone())
                .at_path(format!("nodes.{index}.displayName")),
            );
        }
        if node_by_id.insert(node.id.clone(), node).is_some() {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::DuplicateIdentifier,
                    format!("duplicate node id '{}'", node.id),
                )
                .for_node(node.id.clone())
                .at_path(format!("nodes.{index}.id")),
            );
            continue;
        }
        if node.inputs.len() > MAX_NODE_INPUTS {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("node inputs exceed {MAX_NODE_INPUTS}"),
                )
                .for_node(node.id.clone())
                .at_path(format!("nodes.{index}.inputs")),
            );
        }
        if node.timeout_seconds == 0 || node.timeout_seconds > MAX_TIMEOUT_SECONDS {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("timeoutSeconds must be between 1 and {MAX_TIMEOUT_SECONDS}"),
                )
                .for_node(node.id.clone())
                .at_path(format!("nodes.{index}.timeoutSeconds")),
            );
        }

        let Some(spec) = registry.find(&node.type_name, node.type_version) else {
            let versions = registry.versions_for(&node.type_name);
            let (code, message) = if versions.is_empty() {
                (
                    WorkflowValidationCode::UnknownNodeType,
                    format!("unknown node type '{}'", node.type_name),
                )
            } else {
                (
                    WorkflowValidationCode::UnsupportedNodeVersion,
                    format!(
                        "unsupported version {} for node type '{}'; registered versions: {:?}",
                        node.type_version, node.type_name, versions
                    ),
                )
            };
            errors.push(
                WorkflowValidationError::new(code, message)
                    .for_node(node.id.clone())
                    .at_path(format!("nodes.{index}.typeVersion")),
            );
            continue;
        };
        if spec.outputs.len() > MAX_NODE_OUTPUTS {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("registered node outputs exceed {MAX_NODE_OUTPUTS}"),
                )
                .for_node(node.id.clone()),
            );
        }
        validate_retry(node, spec, &mut errors);
        validate_run_when(node, spec, &mut errors);
        match registry.validate_config(spec, &node.id, &node.config) {
            Ok(config) => {
                if let Some(target_id) = config.target_id.as_deref() {
                    if !targets.contains(target_id) {
                        errors.push(
                            WorkflowValidationError::new(
                                WorkflowValidationCode::UnknownTarget,
                                format!("node references unknown target '{target_id}'"),
                            )
                            .for_node(node.id.clone())
                            .at_path(format!("nodes.{}.config.targetId", node.id)),
                        );
                    }
                }
                config_by_node.insert(node.id.clone(), config);
            }
            Err(config_errors) => errors.extend(config_errors),
        }
        spec_by_node.insert(node.id.clone(), spec);
    }

    if !errors.is_empty() {
        return Err(WorkflowValidationErrors { errors });
    }

    let mut adjacency = definition
        .nodes
        .iter()
        .map(|node| (node.id.clone(), BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    let mut reverse = adjacency.clone();
    validate_bindings(
        definition,
        &node_by_id,
        &spec_by_node,
        &config_by_node,
        &mut adjacency,
        &mut reverse,
        &mut errors,
    );
    validate_workflow_outputs(definition, &node_by_id, &spec_by_node, &mut errors);
    if !errors.is_empty() {
        return Err(WorkflowValidationErrors { errors });
    }

    let topology_layers = topological_layers(&adjacency, &reverse).ok_or_else(|| {
        WorkflowValidationErrors::one(WorkflowValidationError::new(
            WorkflowValidationCode::CycleDetected,
            "workflow graph contains a cycle",
        ))
    })?;

    validate_artifact_flow(
        definition,
        &spec_by_node,
        &config_by_node,
        &topology_layers,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(WorkflowValidationErrors { errors });
    }

    validate_graph_semantics(
        definition,
        &spec_by_node,
        &config_by_node,
        &adjacency,
        &reverse,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(WorkflowValidationErrors { errors });
    }

    build_plan(definition, &spec_by_node, &config_by_node, topology_layers)
}

fn validate_top_level(
    definition: &DeploymentWorkflowDefinition,
    errors: &mut Vec<WorkflowValidationError>,
) {
    if definition.schema_version != WORKFLOW_SCHEMA_VERSION {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::UnsupportedSchemaVersion,
                format!(
                    "schemaVersion must be exactly {WORKFLOW_SCHEMA_VERSION}; legacy and mixed-version workflows are not accepted"
                ),
            )
            .at_path("schemaVersion"),
        );
    }
    for (path, actual, max) in [
        ("targets", definition.targets.len(), MAX_TARGETS),
        ("parameters", definition.parameters.len(), MAX_PARAMETERS),
        ("nodes", definition.nodes.len(), MAX_NODES),
        ("outputs", definition.outputs.len(), MAX_WORKFLOW_OUTPUTS),
    ] {
        if actual == 0 && matches!(path, "targets" | "nodes" | "outputs") {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("{path} must not be empty"),
                )
                .at_path(path),
            );
        } else if actual > max {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("{path} exceeds {max} entries"),
                )
                .at_path(path),
            );
        }
    }
    if !definition.policy.fail_fast {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidPolicy,
                "policy.failFast must be true for deployment workflows",
            )
            .at_path("policy.failFast"),
        );
    }
    if definition.policy.max_parallel_local_nodes == 0
        || definition.policy.max_parallel_local_nodes > MAX_PARALLEL_LOCAL_NODES
    {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidPolicy,
                format!("maxParallelLocalNodes must be between 1 and {MAX_PARALLEL_LOCAL_NODES}"),
            )
            .at_path("policy.maxParallelLocalNodes"),
        );
    }
    if definition.policy.releases_to_keep == 0
        || definition.policy.releases_to_keep > MAX_RELEASES_TO_KEEP
    {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidPolicy,
                format!("releasesToKeep must be between 1 and {MAX_RELEASES_TO_KEEP}"),
            )
            .at_path("policy.releasesToKeep"),
        );
    }
}

fn validate_parameters(
    definition: &DeploymentWorkflowDefinition,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let mut ids = BTreeSet::new();
    for (index, parameter) in definition.parameters.iter().enumerate() {
        if let Err(message) = validate_identifier("parameter id", &parameter.id) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .at_path(format!("parameters.{index}.id")),
            );
        }
        if !ids.insert(&parameter.id) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::DuplicateIdentifier,
                    format!("duplicate parameter id '{}'", parameter.id),
                )
                .at_path(format!("parameters.{index}.id")),
            );
        }
        if parameter.display_name.is_empty()
            || parameter.display_name.len() > MAX_DISPLAY_NAME_BYTES
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    "parameter displayName is empty or too long",
                )
                .at_path(format!("parameters.{index}.displayName")),
            );
        }
        if let Some(default) = &parameter.default_value {
            let valid = matches!(
                (&parameter.parameter_type, default),
                (WorkflowParameterType::String, ScalarValue::String(_))
                    | (WorkflowParameterType::Boolean, ScalarValue::Boolean(_))
                    | (WorkflowParameterType::Integer, ScalarValue::Integer(_))
            );
            if !valid {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::InvalidNodeConfig,
                        "parameter defaultValue does not match its type",
                    )
                    .at_path(format!("parameters.{index}.defaultValue")),
                );
            }
            if matches!(default, ScalarValue::String(value) if value.len() > MAX_SCALAR_STRING_BYTES)
            {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::LimitExceeded,
                        format!("string defaults exceed {MAX_SCALAR_STRING_BYTES} bytes"),
                    )
                    .at_path(format!("parameters.{index}.defaultValue")),
                );
            }
        }
    }
}

fn validate_retry(
    node: &super::workflow_schema::WorkflowNodeDefinition,
    spec: &DeploymentNodeTypeSpec,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let retry = &node.retry;
    let invalid_bounds = retry.max_attempts == 0
        || retry.max_attempts > MAX_RETRY_ATTEMPTS
        || retry.initial_backoff_seconds > MAX_RETRY_BACKOFF_SECONDS
        || retry.max_backoff_seconds > MAX_RETRY_BACKOFF_SECONDS
        || retry.initial_backoff_seconds > retry.max_backoff_seconds;
    if invalid_bounds || (!spec.retryable && retry.max_attempts != 1) {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidRetry,
                if spec.retryable {
                    format!(
                        "retry must use 1..={MAX_RETRY_ATTEMPTS} attempts and ordered backoff values no greater than {MAX_RETRY_BACKOFF_SECONDS} seconds"
                    )
                } else {
                    "this node type is not automatically retryable and maxAttempts must be 1".into()
                },
            )
            .for_node(node.id.clone())
            .at_path(format!("nodes.{}.retry", node.id)),
        );
    }
}

fn validate_run_when(
    node: &super::workflow_schema::WorkflowNodeDefinition,
    spec: &DeploymentNodeTypeSpec,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let valid = match node.run_when {
        NodeRunWhen::AllSucceeded => !spec.is_finalizer,
        NodeRunWhen::AnyFailed | NodeRunWhen::Always => spec.is_finalizer,
    };
    if !valid {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidRunCondition,
                "always and anyFailed are reserved for finalizers; ordinary nodes must use allSucceeded",
            )
            .for_node(node.id.clone())
            .at_path(format!("nodes.{}.runWhen", node.id)),
        );
    }
    if spec.is_finalizer && node.condition.is_some() {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidCondition,
                "finalizers use runWhen and cannot define a scalar condition",
            )
            .for_node(node.id.clone())
            .at_path(format!("nodes.{}.condition", node.id)),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_bindings<'a>(
    definition: &'a DeploymentWorkflowDefinition,
    node_by_id: &BTreeMap<String, &'a super::workflow_schema::WorkflowNodeDefinition>,
    spec_by_node: &BTreeMap<String, &'a DeploymentNodeTypeSpec>,
    config_by_node: &BTreeMap<String, ValidatedNodeConfig>,
    adjacency: &mut BTreeMap<String, BTreeSet<String>>,
    reverse: &mut BTreeMap<String, BTreeSet<String>>,
    errors: &mut Vec<WorkflowValidationError>,
) {
    for node in &definition.nodes {
        let spec = spec_by_node[&node.id];
        for port in spec.inputs.iter().filter(|port| port.required) {
            if !node.inputs.contains_key(&port.name) {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::MissingInput,
                        format!("required input '{}' is not bound", port.name),
                    )
                    .for_node(node.id.clone())
                    .at_path(format!("nodes.{}.inputs.{}", node.id, port.name)),
                );
            }
        }
        for (input_name, binding) in &node.inputs {
            let Some(input_spec) = spec.input(input_name) else {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::UnknownInputPort,
                        format!("node type has no input port '{input_name}'"),
                    )
                    .for_node(node.id.clone())
                    .at_path(format!("nodes.{}.inputs.{input_name}", node.id)),
                );
                continue;
            };
            validate_binding(
                &node.id,
                input_name,
                input_spec.port_type,
                &input_spec.artifact_types,
                binding,
                node_by_id,
                spec_by_node,
                config_by_node,
                adjacency,
                reverse,
                errors,
            );
        }
        if let Some(condition) = &node.condition {
            validate_condition(
                &node.id,
                condition,
                node_by_id,
                spec_by_node,
                adjacency,
                reverse,
                errors,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_binding<'a>(
    consumer_id: &str,
    input_name: &str,
    input_type: DeploymentPortType,
    accepted_artifact_types: &[String],
    binding: &PortBinding,
    node_by_id: &BTreeMap<String, &'a super::workflow_schema::WorkflowNodeDefinition>,
    spec_by_node: &BTreeMap<String, &'a DeploymentNodeTypeSpec>,
    config_by_node: &BTreeMap<String, ValidatedNodeConfig>,
    adjacency: &mut BTreeMap<String, BTreeSet<String>>,
    reverse: &mut BTreeMap<String, BTreeSet<String>>,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let path = format!("nodes.{consumer_id}.inputs.{input_name}");
    if binding.from_node_id == consumer_id {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::CycleDetected,
                "a node cannot bind an input to itself",
            )
            .for_node(consumer_id)
            .at_path(path),
        );
        return;
    }
    let Some(_) = node_by_id.get(&binding.from_node_id) else {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::DanglingBinding,
                format!("binding references missing node '{}'", binding.from_node_id),
            )
            .for_node(consumer_id)
            .at_path(path),
        );
        return;
    };
    let producer_spec = spec_by_node[&binding.from_node_id];
    let Some(output_spec) = producer_spec.output(&binding.from_port) else {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::UnknownOutputPort,
                format!(
                    "node '{}' has no output port '{}'",
                    binding.from_node_id, binding.from_port
                ),
            )
            .for_node(consumer_id)
            .at_path(path),
        );
        return;
    };
    if output_spec.port_type != input_type {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::PortTypeMismatch,
                format!(
                    "port type mismatch: producer is {:?}, consumer requires {:?}",
                    output_spec.port_type, input_type
                ),
            )
            .for_node(consumer_id)
            .at_path(path),
        );
        return;
    }
    if input_type == DeploymentPortType::ArtifactBundle
        && !accepted_artifact_types.is_empty()
        && !output_spec.artifact_types.is_empty()
        && !accepted_artifact_types
            .iter()
            .any(|accepted| output_spec.artifact_types.contains(accepted))
    {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::ArtifactTypeMismatch,
                format!(
                    "artifact contract mismatch: producer {:?}, consumer accepts {:?}",
                    output_spec.artifact_types, accepted_artifact_types
                ),
            )
            .for_node(consumer_id)
            .at_path(path),
        );
        return;
    }
    let producer_target = config_by_node
        .get(&binding.from_node_id)
        .and_then(|config| config.target_id.as_deref());
    let consumer_target = config_by_node
        .get(consumer_id)
        .and_then(|config| config.target_id.as_deref());
    if let (Some(producer), Some(consumer)) = (producer_target, consumer_target) {
        if producer != consumer {
            let code = if producer_spec.effect_class.requires_approval()
                || spec_by_node[consumer_id].effect_class.requires_approval()
            {
                WorkflowValidationCode::CrossTargetEffects
            } else {
                WorkflowValidationCode::TargetMismatch
            };
            errors.push(
                WorkflowValidationError::new(
                    code,
                    format!(
                        "connected target-scoped nodes reference different targets '{producer}' and '{consumer}'"
                    ),
                )
                .for_node(consumer_id)
                .at_path(path),
            );
            return;
        }
    }
    adjacency
        .get_mut(&binding.from_node_id)
        .expect("validated producer exists")
        .insert(consumer_id.to_string());
    reverse
        .get_mut(consumer_id)
        .expect("validated consumer exists")
        .insert(binding.from_node_id.clone());
}

fn validate_condition<'a>(
    node_id: &str,
    condition: &NodeCondition,
    node_by_id: &BTreeMap<String, &'a super::workflow_schema::WorkflowNodeDefinition>,
    spec_by_node: &BTreeMap<String, &'a DeploymentNodeTypeSpec>,
    adjacency: &mut BTreeMap<String, BTreeSet<String>>,
    reverse: &mut BTreeMap<String, BTreeSet<String>>,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let binding = condition.input();
    let path = format!("nodes.{node_id}.condition");
    if binding.from_node_id == node_id {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::CycleDetected,
                "a node condition cannot reference its own output",
            )
            .for_node(node_id)
            .at_path(path),
        );
        return;
    }
    let Some(_) = node_by_id.get(&binding.from_node_id) else {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::DanglingBinding,
                "condition references a missing node",
            )
            .for_node(node_id)
            .at_path(path),
        );
        return;
    };
    let Some(output) = spec_by_node[&binding.from_node_id].output(&binding.from_port) else {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::UnknownOutputPort,
                "condition references a missing output port",
            )
            .for_node(node_id)
            .at_path(path),
        );
        return;
    };
    if !output.port_type.is_scalar() {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidCondition,
                "conditions may only reference bounded scalar outputs",
            )
            .for_node(node_id)
            .at_path(path),
        );
        return;
    }
    let values: &[ScalarValue] = match condition {
        NodeCondition::Equals { value, .. } => std::slice::from_ref(value),
        NodeCondition::In { values, .. } => values,
        NodeCondition::Exists { .. } => &[],
    };
    if matches!(condition, NodeCondition::In { values, .. } if values.is_empty() || values.len() > MAX_CONDITION_VALUES)
    {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidCondition,
                format!("in conditions require 1..={MAX_CONDITION_VALUES} values"),
            )
            .for_node(node_id)
            .at_path(path.clone()),
        );
    }
    if values.iter().any(|value| {
        !value.matches_port(output.port_type)
            || matches!(value, ScalarValue::String(text) if text.len() > MAX_SCALAR_STRING_BYTES)
    }) {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidCondition,
                "condition literal type or size does not match the referenced scalar output",
            )
            .for_node(node_id)
            .at_path(path),
        );
    }
    adjacency
        .get_mut(&binding.from_node_id)
        .expect("validated condition producer exists")
        .insert(node_id.to_string());
    reverse
        .get_mut(node_id)
        .expect("validated condition consumer exists")
        .insert(binding.from_node_id.clone());
}

fn validate_workflow_outputs<'a>(
    definition: &DeploymentWorkflowDefinition,
    node_by_id: &BTreeMap<String, &'a super::workflow_schema::WorkflowNodeDefinition>,
    spec_by_node: &BTreeMap<String, &'a DeploymentNodeTypeSpec>,
    errors: &mut Vec<WorkflowValidationError>,
) {
    for (name, binding) in &definition.outputs {
        if let Err(message) = validate_identifier("workflow output name", name) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .at_path(format!("outputs.{name}")),
            );
        }
        if !node_by_id.contains_key(&binding.from_node_id) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::DanglingBinding,
                    format!(
                        "workflow output references missing node '{}'",
                        binding.from_node_id
                    ),
                )
                .at_path(format!("outputs.{name}")),
            );
            continue;
        }
        if spec_by_node[&binding.from_node_id]
            .output(&binding.from_port)
            .is_none()
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::UnknownOutputPort,
                    format!(
                        "workflow output references missing port '{}.{}'",
                        binding.from_node_id, binding.from_port
                    ),
                )
                .at_path(format!("outputs.{name}")),
            );
        }
    }
}

fn topological_layers(
    adjacency: &BTreeMap<String, BTreeSet<String>>,
    reverse: &BTreeMap<String, BTreeSet<String>>,
) -> Option<Vec<Vec<String>>> {
    let mut indegree = reverse
        .iter()
        .map(|(node, parents)| (node.clone(), parents.len()))
        .collect::<BTreeMap<_, _>>();
    let mut ready = indegree
        .iter()
        .filter_map(|(node, degree)| (*degree == 0).then_some(node.clone()))
        .collect::<BTreeSet<_>>();
    let mut layers = Vec::new();
    let mut visited = 0;
    while !ready.is_empty() {
        let layer = ready.iter().cloned().collect::<Vec<_>>();
        ready.clear();
        for node in &layer {
            visited += 1;
            for child in &adjacency[node] {
                let degree = indegree.get_mut(child).expect("child exists");
                *degree -= 1;
                if *degree == 0 {
                    ready.insert(child.clone());
                }
            }
        }
        layers.push(layer);
    }
    (visited == adjacency.len()).then_some(layers)
}

fn reachable(start: &str, graph: &BTreeMap<String, BTreeSet<String>>) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut pending = VecDeque::from([start.to_string()]);
    while let Some(node) = pending.pop_front() {
        if !found.insert(node.clone()) {
            continue;
        }
        if let Some(neighbors) = graph.get(&node) {
            pending.extend(neighbors.iter().cloned());
        }
    }
    found
}

fn validate_artifact_flow(
    definition: &DeploymentWorkflowDefinition,
    spec_by_node: &BTreeMap<String, &DeploymentNodeTypeSpec>,
    config_by_node: &BTreeMap<String, ValidatedNodeConfig>,
    topology_layers: &[Vec<String>],
    errors: &mut Vec<WorkflowValidationError>,
) {
    let node_by_id = definition
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let mut output_types = BTreeMap::<(String, String), BTreeSet<String>>::new();

    for node_id in topology_layers.iter().flatten() {
        let node = node_by_id[node_id.as_str()];
        let spec = spec_by_node[node_id];
        let mut input_types = BTreeMap::<String, BTreeSet<String>>::new();
        for input_spec in &spec.inputs {
            if input_spec.artifact_types.is_empty() {
                continue;
            }
            let Some(binding) = node.inputs.get(&input_spec.name) else {
                continue;
            };
            let produced = output_types
                .get(&(binding.from_node_id.clone(), binding.from_port.clone()))
                .cloned()
                .unwrap_or_default();
            let accepted = input_spec
                .artifact_types
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            if produced.is_empty() || produced.is_disjoint(&accepted) {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::ArtifactTypeMismatch,
                        format!(
                            "artifact lineage mismatch on '{}': producer {:?}, consumer accepts {:?}",
                            input_spec.name, produced, accepted
                        ),
                    )
                    .for_node(node.id.clone())
                    .at_path(format!("nodes.{}.inputs.{}", node.id, input_spec.name)),
                );
            }
            input_types.insert(input_spec.name.clone(), produced);
        }

        for output_spec in &spec.outputs {
            let configured = config_by_node[node_id]
                .artifact_outputs
                .get(&output_spec.name)
                .cloned();
            let inherited = match (spec.type_name.as_str(), output_spec.name.as_str()) {
                ("transfer.sftp", "transfer") => input_types.get("bundle").cloned(),
                ("release.prepare-files", "release") => input_types.get("transfer").cloned(),
                ("runtime.load-image", "image") => input_types.get("transfer").cloned(),
                _ => None,
            };
            let artifact_types = configured.or(inherited).unwrap_or_else(|| {
                output_spec
                    .artifact_types
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>()
            });
            if !artifact_types.is_empty() {
                output_types.insert((node.id.clone(), output_spec.name.clone()), artifact_types);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_graph_semantics(
    definition: &DeploymentWorkflowDefinition,
    spec_by_node: &BTreeMap<String, &DeploymentNodeTypeSpec>,
    config_by_node: &BTreeMap<String, ValidatedNodeConfig>,
    adjacency: &BTreeMap<String, BTreeSet<String>>,
    reverse: &BTreeMap<String, BTreeSet<String>>,
    errors: &mut Vec<WorkflowValidationError>,
) {
    let output_nodes = definition
        .outputs
        .values()
        .map(|binding| binding.from_node_id.clone())
        .collect::<Vec<_>>();
    let mut contributes_to_output = BTreeSet::new();
    for output in output_nodes {
        contributes_to_output.extend(reachable(&output, reverse));
    }
    for node in &definition.nodes {
        if !spec_by_node[&node.id].is_finalizer && !contributes_to_output.contains(&node.id) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::UnreachableNode,
                    "node does not contribute to any declared workflow output",
                )
                .for_node(node.id.clone()),
            );
        }
    }

    let artifact_producers = spec_by_node
        .iter()
        .filter_map(|(id, spec)| spec.is_artifact_producer.then_some(id.clone()))
        .collect::<BTreeSet<_>>();
    if artifact_producers.is_empty() {
        errors.push(WorkflowValidationError::new(
            WorkflowValidationCode::MissingArtifactProducer,
            "workflow requires at least one Artifact Bundle producer",
        ));
    }

    let approvals = spec_by_node
        .iter()
        .filter_map(|(id, spec)| (spec.type_name == "control.approval").then_some(id.clone()))
        .collect::<Vec<_>>();
    if approvals.len() != 1 {
        errors.push(WorkflowValidationError::new(
            WorkflowValidationCode::MissingApproval,
            format!(
                "workflow requires exactly one approval node; found {}",
                approvals.len()
            ),
        ));
    }

    let deployments = spec_by_node
        .iter()
        .filter_map(|(id, spec)| spec.is_deployment.then_some(id.clone()))
        .collect::<Vec<_>>();
    if deployments.is_empty() {
        errors.push(WorkflowValidationError::new(
            WorkflowValidationCode::MissingDeployment,
            "workflow requires at least one deployment node",
        ));
    }
    let verifications = spec_by_node
        .iter()
        .filter_map(|(id, spec)| spec.is_verification.then_some(id.clone()))
        .collect::<Vec<_>>();
    if verifications.is_empty() {
        errors.push(WorkflowValidationError::new(
            WorkflowValidationCode::MissingVerification,
            "workflow requires at least one verification node",
        ));
    }

    for deployment in deployments {
        let descendants = reachable(&deployment, adjacency);
        if !verifications
            .iter()
            .any(|verification| descendants.contains(verification))
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::VerificationNotCovered,
                    "deployment node has no downstream verification node",
                )
                .for_node(deployment),
            );
        }
    }

    let effect_nodes = spec_by_node
        .iter()
        .filter_map(|(id, spec)| spec.effect_class.requires_approval().then_some(id.clone()))
        .collect::<Vec<_>>();
    let mut effect_targets = BTreeSet::new();
    if let Some(approval) = approvals.first() {
        let approval_ancestors = reachable(approval, reverse);
        if approval_ancestors
            .iter()
            .any(|node| spec_by_node[node].effect_class.requires_approval())
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::ApprovalBypass,
                    "approval node has an effectful ancestor",
                )
                .for_node(approval.clone()),
            );
        }
        let approved_descendants = reachable(approval, adjacency);
        for node in &effect_nodes {
            if !approved_descendants.contains(node) {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::ApprovalBypass,
                        "effectful node is not downstream of the approval node",
                    )
                    .for_node(node.clone()),
                );
            }
            let ancestors = reachable(node, reverse);
            if !artifact_producers
                .iter()
                .any(|producer| ancestors.contains(producer))
            {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::UnreachableNode,
                        "effectful node is not reachable from an Artifact Bundle producer",
                    )
                    .for_node(node.clone()),
                );
            }
            if spec_by_node[node].compensation.is_none() {
                errors.push(
                    WorkflowValidationError::new(
                        WorkflowValidationCode::CompensationNotCovered,
                        "effectful node type has no fixed compensation declaration",
                    )
                    .for_node(node.clone()),
                );
            }
        }
        let approval_target = config_by_node[approval].target_id.as_deref();
        for node in &effect_nodes {
            if let Some(target) = config_by_node[node].target_id.as_deref() {
                effect_targets.insert(target.to_string());
                if approval_target != Some(target) {
                    errors.push(
                        WorkflowValidationError::new(
                            WorkflowValidationCode::TargetMismatch,
                            "effectful node target does not match the approval target",
                        )
                        .for_node(node.clone()),
                    );
                }
            }
        }
    }
    if effect_targets.len() > 1 {
        errors.push(WorkflowValidationError::new(
            WorkflowValidationCode::CrossTargetEffects,
            "one workflow run cannot contain side effects for more than one target",
        ));
    }

    for node in &definition.nodes {
        let spec = spec_by_node[&node.id];
        if spec.execution_domain != super::workflow_schema::ExecutionDomain::Target
            || spec.type_name == "target.preflight"
        {
            continue;
        }
        let target_id = config_by_node[&node.id].target_id.as_deref();
        let ancestors = reachable(&node.id, reverse);
        let mut covered = BTreeSet::new();
        for ancestor in ancestors {
            let ancestor_spec = spec_by_node[&ancestor];
            let ancestor_config = &config_by_node[&ancestor];
            if ancestor_spec.type_name == "target.preflight"
                && ancestor_config.target_id.as_deref() == target_id
            {
                covered.extend(ancestor_config.required_target_capabilities.iter().copied());
            }
        }
        let missing = spec
            .capabilities
            .iter()
            .filter(|capability| !covered.contains(capability))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::CapabilityNotCovered,
                    format!("target preflight does not cover required capabilities {missing:?}"),
                )
                .for_node(node.id.clone()),
            );
        }
    }
}

fn build_plan(
    definition: &DeploymentWorkflowDefinition,
    spec_by_node: &BTreeMap<String, &DeploymentNodeTypeSpec>,
    config_by_node: &BTreeMap<String, ValidatedNodeConfig>,
    topology_layers: Vec<Vec<String>>,
) -> Result<CompiledRunPlanDraft, WorkflowValidationErrors> {
    let definition_digest = canonical_sha256(definition)?;
    let mut nodes = Vec::with_capacity(definition.nodes.len());
    let mut target_effect_lanes = BTreeMap::<String, Vec<String>>::new();
    let mut risks = Vec::new();
    let mut compensations = Vec::new();
    let node_by_id = definition
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();

    for node_id in topology_layers.iter().flatten() {
        let node = node_by_id[node_id.as_str()];
        let spec = spec_by_node[node_id];
        let target_id = config_by_node[node_id].target_id.clone();
        let config_digest = canonical_sha256(&node.config)?;
        let input_digest = canonical_sha256(&serde_json::json!({
            "inputs": node.inputs,
            "condition": node.condition,
            "runWhen": node.run_when,
        }))?;
        if spec.effect_class.requires_approval() {
            target_effect_lanes
                .entry(target_id.clone().expect("validated effect target"))
                .or_default()
                .push(node.id.clone());
        }
        if !matches!(
            spec.effect_class,
            EffectClass::Pure | EffectClass::LocalRead | EffectClass::RemoteRead
        ) {
            risks.push(PlanRiskEntry {
                node_id: node.id.clone(),
                level: spec.risk_level,
                effect_class: spec.effect_class,
                summary_key: format!(
                    "deployment.risk.{}",
                    spec.type_name.replace(['.', '-'], "_")
                ),
            });
        }
        if let Some(compensation) = &spec.compensation {
            compensations.push(PlannedCompensation {
                node_id: node.id.clone(),
                compensation_kind: compensation.kind.clone(),
                fixed_actions: compensation.fixed_actions.clone(),
            });
        }
        nodes.push(CompiledNodePlan {
            node_id: node.id.clone(),
            display_name: node.display_name.clone(),
            node_type: spec.type_name.clone(),
            node_type_version: spec.type_version,
            execution_domain: spec.execution_domain,
            effect_class: spec.effect_class,
            target_id,
            config_digest,
            input_digest,
            timeout_seconds: node.timeout_seconds,
            retry: node.retry.clone(),
            fixed_actions: spec.fixed_actions.clone(),
        });
    }
    let risk_summary = PlanRiskSummary {
        highest_level: risks
            .iter()
            .map(|risk| risk.level)
            .max()
            .unwrap_or(RiskLevel::Low),
        entries: risks,
    };
    let payload = PlanDigestPayload {
        schema_version: COMPILED_PLAN_DRAFT_SCHEMA_VERSION,
        definition_digest: &definition_digest,
        topology_layers: &topology_layers,
        target_effect_lanes: &target_effect_lanes,
        nodes: &nodes,
        risks: &risk_summary,
        compensations: &compensations,
        policy: &definition.policy,
    };
    let plan_digest = canonical_sha256(&payload)?;
    Ok(CompiledRunPlanDraft {
        schema_version: COMPILED_PLAN_DRAFT_SCHEMA_VERSION,
        definition_digest,
        plan_digest,
        topology_layers,
        target_effect_lanes,
        nodes,
        risks: risk_summary,
        compensations,
        policy: definition.policy.clone(),
    })
}

pub(crate) fn validate_layout_json(
    json: &str,
) -> Result<DeploymentWorkflowLayout, WorkflowValidationErrors> {
    if json.len() > MAX_LAYOUT_JSON_BYTES {
        return Err(WorkflowValidationErrors::one(
            WorkflowValidationError::new(
                WorkflowValidationCode::JsonTooLarge,
                format!("layout JSON exceeds {MAX_LAYOUT_JSON_BYTES} bytes"),
            )
            .at_path("$"),
        ));
    }
    let layout = serde_json::from_str::<DeploymentWorkflowLayout>(json).map_err(|error| {
        WorkflowValidationErrors::one(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidJson,
                format!("layout JSON does not match the layout schema: {error}"),
            )
            .at_path("$"),
        )
    })?;
    let mut errors = Vec::new();
    if layout.schema_version != LAYOUT_SCHEMA_VERSION {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::UnsupportedSchemaVersion,
                format!("layout schemaVersion must be {LAYOUT_SCHEMA_VERSION}"),
            )
            .at_path("schemaVersion"),
        );
    }
    if layout.nodes.len() > MAX_NODES {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::LimitExceeded,
                format!("layout nodes exceed {MAX_NODES}"),
            )
            .at_path("nodes"),
        );
    }
    for (node_id, position) in &layout.nodes {
        if let Err(message) = validate_identifier("layout node id", node_id) {
            errors.push(
                WorkflowValidationError::new(WorkflowValidationCode::InvalidIdentifier, message)
                    .at_path(format!("nodes.{node_id}")),
            );
        }
        if !position.x.is_finite() || !position.y.is_finite() {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidNodeConfig,
                    "layout coordinates must be finite",
                )
                .at_path(format!("nodes.{node_id}")),
            );
        }
    }
    if let Some(viewport) = &layout.viewport {
        if !viewport.x.is_finite()
            || !viewport.y.is_finite()
            || !viewport.zoom.is_finite()
            || !(0.1..=4.0).contains(&viewport.zoom)
        {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidNodeConfig,
                    "viewport must use finite coordinates and zoom between 0.1 and 4.0",
                )
                .at_path("viewport"),
            );
        }
    }
    WorkflowValidationErrors::from_vec(errors)?;
    Ok(layout)
}

pub(crate) fn validate_artifact_manifest(
    manifest: &ArtifactBundleManifest,
) -> Result<(), WorkflowValidationErrors> {
    let mut errors = Vec::new();
    if manifest.schema_version != ARTIFACT_MANIFEST_SCHEMA_VERSION {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::UnsupportedSchemaVersion,
                format!(
                    "artifact manifest schemaVersion must be {ARTIFACT_MANIFEST_SCHEMA_VERSION}"
                ),
            )
            .at_path("schemaVersion"),
        );
    }
    if manifest.artifact_type.is_empty() || manifest.artifact_type.len() > 128 {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidArtifact,
                "artifactType is empty or too long",
            )
            .at_path("artifactType"),
        );
    }
    if manifest.components.is_empty() || manifest.components.len() > MAX_ARTIFACT_COMPONENTS {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::LimitExceeded,
                format!("components must contain between 1 and {MAX_ARTIFACT_COMPONENTS} entries"),
            )
            .at_path("components"),
        );
    }
    for (path, digest) in [
        ("source.snapshotDigest", &manifest.source.snapshot_digest),
        ("producer.configDigest", &manifest.producer.config_digest),
    ] {
        if !valid_sha256_digest(digest) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidArtifact,
                    "digest must use sha256:<64 lowercase hex characters>",
                )
                .at_path(path),
            );
        }
    }
    let mut names = BTreeSet::new();
    let mut total = 0_u64;
    for (index, component) in manifest.components.iter().enumerate() {
        if !valid_component_name(&component.name) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidArtifact,
                    "component name must be a normalized relative POSIX path",
                )
                .at_path(format!("components.{index}.name")),
            );
        }
        if !names.insert(&component.name) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::DuplicateIdentifier,
                    format!("duplicate artifact component name '{}'", component.name),
                )
                .at_path(format!("components.{index}.name")),
            );
        }
        if component.media_type.is_empty() || component.media_type.len() > 255 {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidArtifact,
                    "component mediaType is empty or too long",
                )
                .at_path(format!("components.{index}.mediaType")),
            );
        }
        if !valid_sha256_digest(&component.digest) {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::InvalidArtifact,
                    "component digest is invalid",
                )
                .at_path(format!("components.{index}.digest")),
            );
        }
        if component.size > MAX_ARTIFACT_COMPONENT_BYTES {
            errors.push(
                WorkflowValidationError::new(
                    WorkflowValidationCode::LimitExceeded,
                    format!("component exceeds {MAX_ARTIFACT_COMPONENT_BYTES} bytes"),
                )
                .at_path(format!("components.{index}.size")),
            );
        }
        total = total.saturating_add(component.size);
    }
    if total > MAX_ARTIFACT_TOTAL_BYTES {
        errors.push(
            WorkflowValidationError::new(
                WorkflowValidationCode::LimitExceeded,
                format!("artifact exceeds {MAX_ARTIFACT_TOTAL_BYTES} total bytes"),
            )
            .at_path("components"),
        );
    }
    WorkflowValidationErrors::from_vec(errors)
}

pub(crate) fn validate_artifact_handle(
    handle: &ArtifactHandle,
) -> Result<(), WorkflowValidationErrors> {
    let reference_digest = handle
        .artifact_reference
        .strip_prefix("deployment-artifact:");
    if !matches!(reference_digest, Some(digest) if valid_sha256_digest(digest))
        || !valid_sha256_digest(&handle.manifest_digest)
        || !valid_sha256_digest(&handle.content_digest)
    {
        return Err(WorkflowValidationErrors::one(
            WorkflowValidationError::new(
                WorkflowValidationCode::InvalidArtifact,
                "artifact handle contains an invalid opaque reference or digest",
            )
            .at_path("artifactHandle"),
        ));
    }
    Ok(())
}

fn valid_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn valid_component_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.contains("//")
        && !value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const STATIC_SITE: &str =
        include_str!("../../../protocol/deployment/fixtures/static-site-workflow.json");
    const DOCKER_COMPOSE: &str =
        include_str!("../../../protocol/deployment/fixtures/docker-compose-workflow.json");

    fn registry() -> DeploymentNodeRegistry {
        DeploymentNodeRegistry::mvp()
    }

    fn fixture() -> Value {
        serde_json::from_str(STATIC_SITE).unwrap()
    }

    fn compile_value(value: &Value) -> Result<CompiledRunPlanDraft, WorkflowValidationErrors> {
        compile_workflow_json(&serde_json::to_string(value).unwrap(), &registry())
    }

    fn has_code(error: &WorkflowValidationErrors, code: WorkflowValidationCode) -> bool {
        error.errors.iter().any(|entry| entry.code == code)
    }

    #[test]
    fn static_site_and_docker_compose_fixtures_compile() {
        for fixture in [STATIC_SITE, DOCKER_COMPOSE] {
            let plan = compile_workflow_json(fixture, &registry()).unwrap();
            assert!(!plan.topology_layers.is_empty());
            assert_eq!(plan.target_effect_lanes.len(), 1);
            assert!(plan.plan_digest.starts_with("sha256:"));
            assert!(!plan.compensations.is_empty());
            assert!(plan
                .nodes
                .iter()
                .all(|node| node.config_digest.starts_with("sha256:")
                    && node.input_digest.starts_with("sha256:")
                    && !node.fixed_actions.is_empty()));
        }
        let static_plan = compile_workflow_json(STATIC_SITE, &registry()).unwrap();
        assert_eq!(
            static_plan.target_effect_lanes["production"]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["transfer", "prepare", "switch", "commit"]
        );
        assert_eq!(static_plan.risks.highest_level, RiskLevel::Critical);
    }

    #[test]
    fn shared_fixture_round_trips_with_expected_wire_shape() {
        let definition: DeploymentWorkflowDefinition = serde_json::from_str(STATIC_SITE).unwrap();
        let encoded = serde_json::to_value(&definition).unwrap();
        assert_eq!(encoded["schemaVersion"], 3);
        assert_eq!(encoded["nodes"][0]["type"], "source.snapshot");
        assert_eq!(encoded["nodes"][1]["retry"]["maxAttempts"], 2);
        assert_eq!(encoded["policy"]["maxParallelLocalNodes"], 4);
    }

    #[test]
    fn rejects_cycle_dangling_binding_type_error_and_unknown_node() {
        let mut cycle = fixture();
        cycle["nodes"][0]["inputs"] = serde_json::json!({
            "loop": {"fromNodeId": "commit", "fromPort": "activeRelease"}
        });
        assert!(has_code(
            &compile_value(&cycle).unwrap_err(),
            WorkflowValidationCode::UnknownInputPort
        ));

        let mut cycle = fixture();
        cycle["nodes"][1]["inputs"]["source"] =
            serde_json::json!({"fromNodeId": "verify", "fromPort": "evidence"});
        assert!(has_code(
            &compile_value(&cycle).unwrap_err(),
            WorkflowValidationCode::PortTypeMismatch
        ));

        let mut dangling = fixture();
        dangling["nodes"][1]["inputs"]["source"]["fromNodeId"] = Value::String("missing".into());
        assert!(has_code(
            &compile_value(&dangling).unwrap_err(),
            WorkflowValidationCode::DanglingBinding
        ));

        let mut unknown = fixture();
        unknown["nodes"][1]["type"] = Value::String("build.shell".into());
        assert!(has_code(
            &compile_value(&unknown).unwrap_err(),
            WorkflowValidationCode::UnknownNodeType
        ));

        let mut actual_cycle = fixture();
        actual_cycle["nodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "nginx",
                "type": "proxy.nginx-reload",
                "typeVersion": 2,
                "displayName": "Reload proxy",
                "inputs": {"evidence": {"fromNodeId": "verify", "fromPort": "evidence"}},
                "config": {"targetId": "production"},
                "timeoutSeconds": 60,
                "retry": {"maxAttempts": 1, "initialBackoffSeconds": 0, "maxBackoffSeconds": 0},
                "runWhen": "allSucceeded"
            }));
        actual_cycle["nodes"][8]["inputs"]["activation"] =
            serde_json::json!({"fromNodeId": "nginx", "fromPort": "activation"});
        assert!(has_code(
            &compile_value(&actual_cycle).unwrap_err(),
            WorkflowValidationCode::CycleDetected
        ));
    }

    #[test]
    fn rejects_approval_bypass_unreachable_effect_and_cross_target_effects() {
        let base_registry = registry();
        let mut node_specs = base_registry.nodes().to_vec();
        let mut unsafe_transfer = base_registry.find("transfer.sftp", 2).unwrap().clone();
        unsafe_transfer.type_name = "transfer.unsafe-test".into();
        unsafe_transfer
            .inputs
            .retain(|input| input.name != "approval");
        node_specs.push(unsafe_transfer);
        let unsafe_registry = DeploymentNodeRegistry::from_test_nodes(node_specs);
        let mut bypass = fixture();
        bypass["nodes"][5]["type"] = Value::String("transfer.unsafe-test".into());
        bypass["nodes"][5]["inputs"]
            .as_object_mut()
            .unwrap()
            .remove("approval");
        assert!(has_code(
            &compile_workflow_json(&serde_json::to_string(&bypass).unwrap(), &unsafe_registry)
                .unwrap_err(),
            WorkflowValidationCode::ApprovalBypass
        ));

        let mut cross_target = fixture();
        cross_target["targets"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "secondary",
                "connectionProfileId": "profile-secondary",
                "remoteRoot": "/srv/secondary"
            }));
        cross_target["nodes"][6]["config"]["targetId"] = Value::String("secondary".into());
        assert!(has_code(
            &compile_value(&cross_target).unwrap_err(),
            WorkflowValidationCode::CrossTargetEffects
        ));

        let mut unreachable = fixture();
        unreachable["nodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "unused",
                "type": "artifact.collect",
                "typeVersion": 1,
                "displayName": "Unused artifact",
                "inputs": {"source": {"fromNodeId": "source", "fromPort": "source"}},
                "config": {"kind": "fileTree", "paths": ["public"]},
                "timeoutSeconds": 60,
                "retry": {"maxAttempts": 1, "initialBackoffSeconds": 0, "maxBackoffSeconds": 0},
                "runWhen": "allSucceeded"
            }));
        assert!(has_code(
            &compile_value(&unreachable).unwrap_err(),
            WorkflowValidationCode::UnreachableNode
        ));

        let mut duplicate_approval = fixture();
        let mut second_approval = duplicate_approval["nodes"][4].clone();
        second_approval["id"] = Value::String("approval-2".into());
        second_approval["displayName"] = Value::String("Second approval".into());
        duplicate_approval["nodes"]
            .as_array_mut()
            .unwrap()
            .push(second_approval);
        duplicate_approval["outputs"]["secondApproval"] =
            serde_json::json!({"fromNodeId": "approval-2", "fromPort": "approval"});
        assert!(has_code(
            &compile_value(&duplicate_approval).unwrap_err(),
            WorkflowValidationCode::MissingApproval
        ));

        let mut missing_verification = fixture();
        missing_verification["nodes"]
            .as_array_mut()
            .unwrap()
            .retain(|node| node["id"] != "verify" && node["id"] != "commit");
        missing_verification["outputs"] = serde_json::json!({
            "activation": {"fromNodeId": "switch", "fromPort": "activation"}
        });
        assert!(has_code(
            &compile_value(&missing_verification).unwrap_err(),
            WorkflowValidationCode::MissingVerification
        ));

        let mut uncompensated_nodes = registry().nodes().to_vec();
        uncompensated_nodes
            .iter_mut()
            .find(|spec| spec.type_name == "deploy.static-switch")
            .unwrap()
            .compensation = None;
        let uncompensated_registry = DeploymentNodeRegistry::from_test_nodes(uncompensated_nodes);
        assert!(has_code(
            &compile_workflow_json(STATIC_SITE, &uncompensated_registry).unwrap_err(),
            WorkflowValidationCode::CompensationNotCovered
        ));
    }

    #[test]
    fn rejects_non_scalar_and_mistyped_conditions() {
        let mut non_scalar = fixture();
        non_scalar["nodes"][2]["condition"] = serde_json::json!({
            "op": "exists",
            "input": {"fromNodeId": "build", "fromPort": "bundle"}
        });
        assert!(has_code(
            &compile_value(&non_scalar).unwrap_err(),
            WorkflowValidationCode::InvalidCondition
        ));

        let mut bad_mode = fixture();
        bad_mode["nodes"][2]["runWhen"] = Value::String("always".into());
        assert!(has_code(
            &compile_value(&bad_mode).unwrap_err(),
            WorkflowValidationCode::InvalidRunCondition
        ));
    }

    #[test]
    fn rejects_artifact_lineage_version_and_structural_limits() {
        let mut wrong_artifact = fixture();
        wrong_artifact["nodes"][1]["type"] = Value::String("artifact.collect".into());
        wrong_artifact["nodes"][1]["typeVersion"] = Value::from(1);
        wrong_artifact["nodes"][1]["config"] =
            serde_json::json!({"kind": "zip", "paths": ["dist.zip"]});
        assert!(has_code(
            &compile_value(&wrong_artifact).unwrap_err(),
            WorkflowValidationCode::ArtifactTypeMismatch
        ));

        let mut unknown_version = fixture();
        unknown_version["nodes"][1]["typeVersion"] = Value::from(99);
        assert!(has_code(
            &compile_value(&unknown_version).unwrap_err(),
            WorkflowValidationCode::UnsupportedNodeVersion
        ));

        let mut legacy_schema = fixture();
        legacy_schema["schemaVersion"] = Value::from(2);
        assert!(has_code(
            &compile_value(&legacy_schema).unwrap_err(),
            WorkflowValidationCode::UnsupportedSchemaVersion
        ));

        let mut too_many_nodes = fixture();
        let source = too_many_nodes["nodes"][0].clone();
        for index in 0..=MAX_NODES - too_many_nodes["nodes"].as_array().unwrap().len() {
            let mut extra = source.clone();
            extra["id"] = Value::String(format!("extra-{index}"));
            too_many_nodes["nodes"].as_array_mut().unwrap().push(extra);
        }
        assert!(has_code(
            &compile_value(&too_many_nodes).unwrap_err(),
            WorkflowValidationCode::LimitExceeded
        ));

        let mut missing_capability = fixture();
        missing_capability["nodes"][2]["config"]["requiredCapabilities"] =
            serde_json::json!(["sftp", "http"]);
        assert!(has_code(
            &compile_value(&missing_capability).unwrap_err(),
            WorkflowValidationCode::CapabilityNotCovered
        ));
    }

    #[test]
    fn rejects_dangerous_config_paths_and_oversized_json() {
        let mut command = fixture();
        command["nodes"][0]["config"]["command"] = Value::String("echo unsafe".into());
        assert!(has_code(
            &compile_value(&command).unwrap_err(),
            WorkflowValidationCode::DangerousConfig
        ));

        let mut path = fixture();
        path["nodes"][1]["config"]["outputDirectory"] = Value::String("../outside".into());
        assert!(has_code(
            &compile_value(&path).unwrap_err(),
            WorkflowValidationCode::InvalidNodeConfig
        ));

        let mut environment = fixture();
        environment["nodes"][1]["config"]["environmentRefs"] = serde_json::json!(["PATH"]);
        assert!(has_code(
            &compile_value(&environment).unwrap_err(),
            WorkflowValidationCode::InvalidNodeConfig
        ));

        let oversized = format!(
            "{{\"padding\":\"{}\"}}",
            "x".repeat(MAX_WORKFLOW_JSON_BYTES)
        );
        assert!(has_code(
            &compile_workflow_json(&oversized, &registry()).unwrap_err(),
            WorkflowValidationCode::JsonTooLarge
        ));
    }

    #[test]
    fn canonical_digest_is_stable_and_tracks_semantic_changes_only() {
        let original = fixture();
        let reordered: Value =
            serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        let first = compile_value(&original).unwrap();
        let second = compile_value(&reordered).unwrap();
        assert_eq!(first.plan_digest, second.plan_digest);

        let normalized_static_site = STATIC_SITE.replace("\r\n", "\n");
        let reordered_keys = normalized_static_site.replace(
            "\"packageManager\": \"pnpm\",\n        \"workingDirectory\": \".\",\n        \"installMode\": \"frozen\"",
            "\"installMode\": \"frozen\",\n        \"workingDirectory\": \".\",\n        \"packageManager\": \"pnpm\"",
        );
        assert_ne!(reordered_keys, normalized_static_site);
        assert_eq!(
            first.plan_digest,
            compile_workflow_json(&reordered_keys, &registry())
                .unwrap()
                .plan_digest
        );

        let mut config_change = original.clone();
        config_change["nodes"][1]["config"]["scriptName"] = Value::String("build:prod".into());
        assert_ne!(
            first.plan_digest,
            compile_value(&config_change).unwrap().plan_digest
        );

        let mut connection_change = original.clone();
        let mut alternate_verify = connection_change["nodes"][8].clone();
        alternate_verify["id"] = Value::String("verify-alt".into());
        alternate_verify["displayName"] = Value::String("Verify alternate".into());
        connection_change["nodes"]
            .as_array_mut()
            .unwrap()
            .push(alternate_verify);
        connection_change["nodes"][9]["inputs"]["evidence"]["fromNodeId"] =
            Value::String("verify-alt".into());
        assert_ne!(
            first.plan_digest,
            compile_value(&connection_change).unwrap().plan_digest
        );

        let mut parameter_change = original.clone();
        parameter_change["parameters"] = serde_json::json!([{
            "id": "release-note",
            "displayName": "Release note",
            "type": "string",
            "required": false,
            "defaultValue": "stable"
        }]);
        assert_ne!(
            first.plan_digest,
            compile_value(&parameter_change).unwrap().plan_digest
        );

        let layout_a = r#"{"schemaVersion":1,"nodes":{"source":{"x":0,"y":0}},"groups":[]}"#;
        let layout_b = r#"{"schemaVersion":1,"nodes":{"source":{"x":900,"y":300}},"groups":[]}"#;
        validate_layout_json(layout_a).unwrap();
        validate_layout_json(layout_b).unwrap();
        assert_eq!(
            first.plan_digest,
            compile_value(&original).unwrap().plan_digest
        );
    }

    #[test]
    fn artifact_manifest_and_opaque_handle_are_strictly_validated() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let manifest = ArtifactBundleManifest {
            schema_version: 2,
            artifact_type: "application/vnd.shellspan.file-tree".into(),
            source: super::super::workflow_schema::ArtifactSource {
                revision: "abc123".into(),
                dirty: false,
                snapshot_digest: digest.clone(),
            },
            components: vec![super::super::workflow_schema::ArtifactDescriptor {
                name: "dist/index.html".into(),
                role: super::super::workflow_schema::ArtifactRole::Application,
                media_type: "text/html".into(),
                digest: digest.clone(),
                size: 12,
                platform: None,
                annotations: BTreeMap::new(),
            }],
            producer: super::super::workflow_schema::ArtifactProducer {
                node_type: "artifact.collect".into(),
                node_type_version: 1,
                config_digest: digest.clone(),
            },
            annotations: BTreeMap::new(),
        };
        validate_artifact_manifest(&manifest).unwrap();
        validate_artifact_handle(&ArtifactHandle {
            artifact_reference: format!("deployment-artifact:{digest}"),
            manifest_digest: digest.clone(),
            content_digest: digest,
        })
        .unwrap();

        let mut invalid = manifest;
        invalid.components[0].name = "../escape".into();
        assert!(has_code(
            &validate_artifact_manifest(&invalid).unwrap_err(),
            WorkflowValidationCode::InvalidArtifact
        ));
    }
}
