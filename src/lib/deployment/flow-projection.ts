import type { Edge, Node } from '@xyflow/react';
import {
  deploymentInputHandleId,
  deploymentOutputHandleId,
} from '@/lib/deployment/flow-connection';
import type {
  DeploymentNodePortSpec,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowLayout,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';
import { DEPLOYMENT_FLOW_CONTENT_PADDING } from '@/lib/deployment/editor';

const EDGE_ID_PREFIX = 'deployment-edge:';
const FALLBACK_NODE_COLUMN_WIDTH = 280;
const FALLBACK_NODE_ROW_HEIGHT = 190;
const FALLBACK_NODE_COLUMNS = 4;

export interface DeploymentFlowEdgeKey {
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export type DeploymentFlowNodeData = {
  workflowNode: DeploymentWorkflowNode;
  catalogNode: DeploymentNodeTypeSpec | null;
  inputPorts: readonly DeploymentNodePortSpec[];
  outputPorts: readonly DeploymentNodePortSpec[];
  collapsed: boolean;
};

export type DeploymentFlowEdgeData = {
  binding: DeploymentFlowEdgeKey;
};

export type DeploymentFlowNode = Node<DeploymentFlowNodeData, 'deployment'>;
export type DeploymentFlowEdge = Edge<DeploymentFlowEdgeData, 'deployment'>;

export interface DeploymentFlowProjection {
  nodes: DeploymentFlowNode[];
  edges: DeploymentFlowEdge[];
}

export function deploymentFlowEdgeId(key: DeploymentFlowEdgeKey): string {
  return EDGE_ID_PREFIX + [
    key.sourceNodeId,
    key.sourcePort,
    key.targetNodeId,
    key.targetPort,
  ].map(encodeURIComponent).join(':');
}

export function parseDeploymentFlowEdgeId(edgeId: string): DeploymentFlowEdgeKey | null {
  if (!edgeId.startsWith(EDGE_ID_PREFIX)) return null;
  const parts = edgeId.slice(EDGE_ID_PREFIX.length).split(':');
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) return null;
  try {
    const [sourceNodeId, sourcePort, targetNodeId, targetPort] = parts.map(decodeURIComponent);
    if (!sourceNodeId || !sourcePort || !targetNodeId || !targetPort) return null;
    return { sourceNodeId, sourcePort, targetNodeId, targetPort };
  } catch {
    return null;
  }
}

function catalogNodeFor(
  workflowNode: DeploymentWorkflowNode,
  catalog: DeploymentNodeTypeCatalog | null,
): DeploymentNodeTypeSpec | null {
  return catalog?.nodes.find(
    (item) => item.typeName === workflowNode.type && item.typeVersion === workflowNode.typeVersion,
  ) ?? null;
}

function fallbackPosition(index: number): { x: number; y: number } {
  return {
    x: DEPLOYMENT_FLOW_CONTENT_PADDING + (index % FALLBACK_NODE_COLUMNS) * FALLBACK_NODE_COLUMN_WIDTH,
    y: DEPLOYMENT_FLOW_CONTENT_PADDING + Math.floor(index / FALLBACK_NODE_COLUMNS) * FALLBACK_NODE_ROW_HEIGHT,
  };
}

function nodePosition(
  nodeId: string,
  index: number,
  layout: DeploymentWorkflowLayout | null,
): { x: number; y: number } {
  const saved = layout?.nodes[nodeId];
  return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
    ? { x: saved.x, y: saved.y }
    : fallbackPosition(index);
}

export function projectDeploymentFlow(
  definition: DeploymentWorkflowDefinition,
  layout: DeploymentWorkflowLayout | null,
  catalog: DeploymentNodeTypeCatalog | null,
  selectedNodeId: string | null,
): DeploymentFlowProjection {
  const nodes = definition.nodes.map<DeploymentFlowNode>((workflowNode, index) => {
    const catalogNode = catalogNodeFor(workflowNode, catalog);
    return {
      id: workflowNode.id,
      type: 'deployment',
      position: nodePosition(workflowNode.id, index, layout),
      selected: workflowNode.id === selectedNodeId,
      data: {
        workflowNode,
        catalogNode,
        inputPorts: catalogNode?.inputs ?? [],
        outputPorts: catalogNode?.outputs ?? [],
        collapsed: layout?.nodes[workflowNode.id]?.collapsed ?? false,
      },
    };
  });

  const edges = definition.nodes.flatMap((targetNode) => Object.entries(targetNode.inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map<DeploymentFlowEdge>(([targetPort, binding]) => {
      const key: DeploymentFlowEdgeKey = {
        sourceNodeId: binding.fromNodeId,
        sourcePort: binding.fromPort,
        targetNodeId: targetNode.id,
        targetPort,
      };
      return {
        id: deploymentFlowEdgeId(key),
        type: 'deployment',
        source: key.sourceNodeId,
        sourceHandle: deploymentOutputHandleId(key.sourcePort),
        target: key.targetNodeId,
        targetHandle: deploymentInputHandleId(key.targetPort),
        data: { binding: key },
      };
    }));

  return { nodes, edges };
}
