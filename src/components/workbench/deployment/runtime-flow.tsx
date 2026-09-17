import React from 'react';
import { LockKeyholeIcon } from 'lucide-react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type AriaLabelConfig,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { useI18n } from '@/hooks/useI18n';
import {
  projectDeploymentFlow,
  type DeploymentFlowEdgeData,
  type DeploymentFlowNodeData,
} from '@/lib/deployment/flow-projection';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentRunNodeRecord,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { DeploymentFlowNodeFrame } from './workflow-node';
import {
  deploymentNodeProgress,
  deploymentStatusBadgeVariant,
  deploymentStatusLabel,
  formatDeploymentDuration,
} from './runtime-utils';

type RuntimeFlowNodeData = DeploymentFlowNodeData & {
  runNode: DeploymentRunNodeRecord;
};

type RuntimeFlowNode = Node<RuntimeFlowNodeData, 'deploymentRuntime'>;
type RuntimeFlowEdge = Edge<DeploymentFlowEdgeData>;

const RuntimeNode = React.memo<NodeProps<RuntimeFlowNode>>(({ data, selected }) => {
  const { t } = useI18n();
  const progress = deploymentNodeProgress(data.runNode);
  const evidenceGap = data.runNode.status === 'state_unknown';

  return (
    <DeploymentFlowNodeFrame
      workflowNode={data.workflowNode}
      catalogNode={data.catalogNode}
      selected={selected}
      readOnly
      invalid={evidenceGap || data.runNode.status === 'failed'}
      badges={(
        <>
          <Badge variant={deploymentStatusBadgeVariant(data.runNode.status)} size="sm">
            {deploymentStatusLabel(data.runNode.status, t)}
          </Badge>
          <Badge variant="outline" size="sm">
            {t('deployment.runtime.attemptCount', { count: data.runNode.lastAttempt })}
          </Badge>
          <Badge variant="secondary" size="sm">
            <LockKeyholeIcon data-icon="inline-start" />
            {t('deployment.runtime.flow.readOnly')}
          </Badge>
          {evidenceGap && (
            <Badge variant="destructive" size="sm">
              {t('deployment.runtime.flow.evidenceGap')}
            </Badge>
          )}
        </>
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none opacity-0"
        data-runtime-anchor="target"
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none opacity-0"
        data-runtime-anchor="source"
      />
      <div className="mt-3 flex flex-col gap-2 border-t pt-2 text-xs">
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>{t('deployment.runtime.run.duration')}</span>
          <span>{formatDeploymentDuration(data.runNode.startedAt, data.runNode.finishedAt)}</span>
        </div>
        <Progress
          value={progress.percent}
          aria-label={t('deployment.runtime.node.progress', { node: data.workflowNode.displayName })}
        >
          <ProgressLabel>{deploymentStatusLabel(data.runNode.status, t)}</ProgressLabel>
          <ProgressValue>{() => progress.valueLabel}</ProgressValue>
        </Progress>
      </div>
    </DeploymentFlowNodeFrame>
  );
});

RuntimeNode.displayName = 'RuntimeNode';

const RUNTIME_NODE_TYPES = { deploymentRuntime: RuntimeNode } satisfies NodeTypes;

export interface RuntimeFlowProps {
  workflow: DeploymentWorkflowRecord;
  catalog: DeploymentNodeTypeCatalog | null;
  runNodes: readonly DeploymentRunNodeRecord[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

export const RuntimeFlow: React.FC<RuntimeFlowProps> = ({
  workflow,
  catalog,
  runNodes,
  selectedNodeId,
  onSelectNode,
}) => {
  const { locale, t } = useI18n();
  const projection = React.useMemo(() => projectDeploymentFlow(
    workflow.definition,
    workflow.layout ?? null,
    catalog,
    selectedNodeId,
  ), [catalog, selectedNodeId, workflow.definition, workflow.layout]);
  const runNodesById = React.useMemo(
    () => new Map(runNodes.map((node) => [node.nodeId, node])),
    [runNodes],
  );
  const nodes = React.useMemo<RuntimeFlowNode[]>(() => projection.nodes.flatMap((node) => {
    const runNode = runNodesById.get(node.id);
    if (!runNode) return [];
    return [{
      ...node,
      type: 'deploymentRuntime',
      data: { ...node.data, runNode },
      selected: node.id === selectedNodeId,
      draggable: false,
      connectable: false,
      deletable: false,
      focusable: true,
      initialWidth: 256,
      initialHeight: 176,
      ariaLabel: t('deployment.runtime.flow.nodeLabel', {
        name: node.data.workflowNode.displayName,
        status: deploymentStatusLabel(runNode.status, t),
      }),
      domAttributes: {
        'data-node-id': node.id,
        'data-node-status': runNode.status,
        'data-node-attempt': String(runNode.lastAttempt),
      } as unknown as RuntimeFlowNode['domAttributes'],
    }];
  }), [locale, projection.nodes, runNodesById, selectedNodeId]);
  const nodeIds = React.useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const edges = React.useMemo<RuntimeFlowEdge[]>(() => projection.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: edge.data,
      selectable: false,
      deletable: false,
      focusable: false,
      reconnectable: false,
      ariaLabel: t('deployment.runtime.flow.edgeLabel', {
        source: workflow.definition.nodes.find((node) => node.id === edge.source)?.displayName ?? edge.source,
        target: workflow.definition.nodes.find((node) => node.id === edge.target)?.displayName ?? edge.target,
      }),
    })), [locale, nodeIds, projection.edges, workflow.definition.nodes]);
  const ariaLabelConfig = React.useMemo<Partial<AriaLabelConfig>>(() => ({
    'node.a11yDescription.default': t('deployment.runtime.flow.nodeDescription'),
    'node.a11yDescription.keyboardDisabled': t('deployment.runtime.flow.nodeDescription'),
    'edge.a11yDescription.default': t('deployment.runtime.flow.edgeDescription'),
    'controls.ariaLabel': t('deployment.editor.flow.controls'),
    'controls.zoomIn.ariaLabel': t('deployment.editor.flow.zoomIn'),
    'controls.zoomOut.ariaLabel': t('deployment.editor.flow.zoomOut'),
    'controls.fitView.ariaLabel': t('deployment.editor.flow.fitView'),
    'controls.interactive.ariaLabel': t('deployment.editor.flow.interactive'),
    'minimap.ariaLabel': t('deployment.editor.flow.minimap'),
  }), [locale]);

  return (
    <div
      className="deployment-workflow-flow relative size-full min-h-0 min-w-0 overflow-hidden bg-background"
      data-testid="deployment-runtime-flow"
      data-read-only="true"
      aria-label={t('deployment.runtime.flow.canvasLabel')}
    >
      <div className="hidden" aria-hidden>
        {edges.map((edge) => (
          <span
            key={edge.id}
            data-edge-id={edge.id}
            data-source-node-id={edge.data?.binding.sourceNodeId}
            data-source-port={edge.data?.binding.sourcePort}
            data-target-node-id={edge.data?.binding.targetNodeId}
            data-target-port={edge.data?.binding.targetPort}
          />
        ))}
      </div>
      <ReactFlow<RuntimeFlowNode, RuntimeFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={RUNTIME_NODE_TYPES}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        deleteKeyCode={null}
        panOnDrag
        minZoom={0.25}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        ariaLabelConfig={ariaLabelConfig}
        aria-label={t('deployment.runtime.flow.canvasLabel')}
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Controls
          showInteractive={false}
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          aria-label={t('deployment.editor.flow.controls')}
          className="overflow-hidden rounded-md border border-border bg-background text-foreground"
        />
        {nodes.length >= 10 && (
          <MiniMap
            ariaLabel={t('deployment.editor.flow.minimap')}
            pannable
            zoomable
            nodeColor="var(--muted)"
            nodeStrokeColor="var(--border)"
            maskColor="color-mix(in srgb, var(--background) 72%, transparent)"
            className="rounded-md border border-border bg-background"
          />
        )}
      </ReactFlow>
    </div>
  );
};
