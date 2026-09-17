import type { Connection } from '@xyflow/react';
import type {
  DeploymentNodePortSpec,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentPortBinding,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';

export type DeploymentHandleDirection = 'input' | 'output';

export interface DeploymentHandleDescriptor {
  direction: DeploymentHandleDirection;
  portName: string;
}

export interface DeploymentBindingEndpoint {
  targetNodeId: string;
  targetPort: string;
}

export interface DeploymentConnectionValidationOptions {
  replacing?: DeploymentBindingEndpoint;
}

export type DeploymentConnectionFailureCode =
  | 'INVALID_HANDLE_DIRECTION'
  | 'UNKNOWN_SOURCE_NODE'
  | 'UNKNOWN_TARGET_NODE'
  | 'UNKNOWN_SOURCE_NODE_TYPE'
  | 'UNKNOWN_TARGET_NODE_TYPE'
  | 'UNKNOWN_OUTPUT_PORT'
  | 'UNKNOWN_INPUT_PORT'
  | 'SELF_CONNECTION'
  | 'PORT_TYPE_MISMATCH'
  | 'ARTIFACT_TYPE_MISMATCH'
  | 'INPUT_OCCUPIED'
  | 'CYCLE_DETECTED';

export interface DeploymentConnectionFailureReason {
  code: DeploymentConnectionFailureCode;
  sourceNodeId?: string;
  sourcePort?: string;
  targetNodeId?: string;
  targetPort?: string;
  sourcePortType?: string;
  targetPortType?: string;
}

export type DeploymentConnectionValidationResult =
  | {
      valid: true;
      sourceNodeId: string;
      sourcePort: string;
      targetNodeId: string;
      targetPort: string;
      binding: DeploymentPortBinding;
    }
  | { valid: false; reason: DeploymentConnectionFailureReason };

export function deploymentInputHandleId(portName: string): string {
  return `input:${portName}`;
}

export function deploymentOutputHandleId(portName: string): string {
  return `output:${portName}`;
}

export function parseDeploymentHandleId(handleId: string | null): DeploymentHandleDescriptor | null {
  if (!handleId) return null;
  const separator = handleId.indexOf(':');
  if (separator < 0) return null;
  const direction = handleId.slice(0, separator);
  const portName = handleId.slice(separator + 1);
  if ((direction !== 'input' && direction !== 'output') || portName.length === 0) return null;
  return { direction, portName };
}

function nodeSpec(
  node: DeploymentWorkflowNode,
  catalog: DeploymentNodeTypeCatalog,
): DeploymentNodeTypeSpec | undefined {
  return catalog.nodes.find(
    (item) => item.typeName === node.type && item.typeVersion === node.typeVersion,
  );
}

function artifactPortsCompatible(
  output: DeploymentNodePortSpec,
  input: DeploymentNodePortSpec,
): boolean {
  if (output.portType !== 'artifact.bundle' || input.portType !== 'artifact.bundle') return true;
  const produced = output.artifactTypes ?? [];
  const accepted = input.artifactTypes ?? [];
  return produced.length === 0 || accepted.length === 0
    || produced.some((artifactType) => accepted.includes(artifactType));
}

function isReplacedBinding(
  targetNodeId: string,
  targetPort: string,
  replacing: DeploymentBindingEndpoint | undefined,
): boolean {
  return replacing?.targetNodeId === targetNodeId && replacing.targetPort === targetPort;
}

function wouldCreateCycle(
  definition: DeploymentWorkflowDefinition,
  sourceNodeId: string,
  targetNodeId: string,
  replacing: DeploymentBindingEndpoint | undefined,
): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const node of definition.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const targetNode of definition.nodes) {
    for (const [targetPort, binding] of Object.entries(targetNode.inputs)) {
      if (isReplacedBinding(targetNode.id, targetPort, replacing)) continue;
      adjacency.get(binding.fromNodeId)?.add(targetNode.id);
    }
  }
  adjacency.get(sourceNodeId)?.add(targetNodeId);

  const pending = [targetNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === sourceNodeId) return true;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function failure(reason: DeploymentConnectionFailureReason): DeploymentConnectionValidationResult {
  return { valid: false, reason };
}

export function validateDeploymentFlowConnection(
  definition: DeploymentWorkflowDefinition,
  catalog: DeploymentNodeTypeCatalog,
  connection: Connection,
  options: DeploymentConnectionValidationOptions = {},
): DeploymentConnectionValidationResult {
  const sourceHandle = parseDeploymentHandleId(connection.sourceHandle);
  const targetHandle = parseDeploymentHandleId(connection.targetHandle);
  if (sourceHandle?.direction !== 'output' || targetHandle?.direction !== 'input') {
    return failure({
      code: 'INVALID_HANDLE_DIRECTION',
      sourceNodeId: connection.source,
      targetNodeId: connection.target,
    });
  }

  const coordinates = {
    sourceNodeId: connection.source,
    sourcePort: sourceHandle.portName,
    targetNodeId: connection.target,
    targetPort: targetHandle.portName,
  };
  const sourceNode = definition.nodes.find((node) => node.id === connection.source);
  if (!sourceNode) return failure({ code: 'UNKNOWN_SOURCE_NODE', ...coordinates });
  const targetNode = definition.nodes.find((node) => node.id === connection.target);
  if (!targetNode) return failure({ code: 'UNKNOWN_TARGET_NODE', ...coordinates });
  if (sourceNode.id === targetNode.id) {
    return failure({ code: 'SELF_CONNECTION', ...coordinates });
  }

  const sourceSpec = nodeSpec(sourceNode, catalog);
  if (!sourceSpec) return failure({ code: 'UNKNOWN_SOURCE_NODE_TYPE', ...coordinates });
  const targetSpec = nodeSpec(targetNode, catalog);
  if (!targetSpec) return failure({ code: 'UNKNOWN_TARGET_NODE_TYPE', ...coordinates });
  const output = sourceSpec.outputs.find((port) => port.name === sourceHandle.portName);
  if (!output) return failure({ code: 'UNKNOWN_OUTPUT_PORT', ...coordinates });
  const input = targetSpec.inputs.find((port) => port.name === targetHandle.portName);
  if (!input) return failure({ code: 'UNKNOWN_INPUT_PORT', ...coordinates });
  if (output.portType !== input.portType) {
    return failure({
      code: 'PORT_TYPE_MISMATCH',
      ...coordinates,
      sourcePortType: output.portType,
      targetPortType: input.portType,
    });
  }
  if (!artifactPortsCompatible(output, input)) {
    return failure({ code: 'ARTIFACT_TYPE_MISMATCH', ...coordinates });
  }
  if (targetNode.inputs[targetHandle.portName]
    && !isReplacedBinding(targetNode.id, targetHandle.portName, options.replacing)) {
    return failure({ code: 'INPUT_OCCUPIED', ...coordinates });
  }
  if (wouldCreateCycle(
    definition,
    sourceNode.id,
    targetNode.id,
    options.replacing,
  )) {
    return failure({ code: 'CYCLE_DETECTED', ...coordinates });
  }

  return {
    valid: true,
    ...coordinates,
    binding: { fromNodeId: sourceNode.id, fromPort: output.name },
  };
}
