import React from 'react';
import { LocateFixedIcon, UnlinkIcon } from 'lucide-react';
import {
  Background,
  BaseEdge,
  ControlButton,
  Controls,
  EdgeToolbar,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  getBezierPath,
  type AriaLabelConfig,
  type Connection,
  type EdgeChange,
  type EdgeProps,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
  type ReactFlowProps,
  type Viewport,
} from '@xyflow/react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentEditorIssue } from '@/lib/deployment/editor';
import {
  type DeploymentBindingEndpoint,
  type DeploymentConnectionFailureCode,
  validateDeploymentFlowConnection,
} from '@/lib/deployment/flow-connection';
import {
  parseDeploymentFlowEdgeId,
  projectDeploymentFlow,
  type DeploymentFlowEdge,
} from '@/lib/deployment/flow-projection';
import type { DeploymentNodeTypeCatalog } from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import {
  useDeploymentWorkflowStore,
  type DeploymentWorkflowDraft,
} from '@/stores/deploymentWorkflowStore';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import {
  WorkflowNode,
  type WorkflowCanvasNode,
  type WorkflowCanvasNodeData,
} from './workflow-node';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
export const DEPLOYMENT_MINIMAP_NODE_THRESHOLD = 10;

function dynamicKey(value: string): LocaleKey {
  return value as LocaleKey;
}

interface DeploymentEdgeActions {
  editable: boolean;
  disconnectLabel: string;
  onDisconnect: (edge: DeploymentFlowEdge) => void;
}

const DeploymentEdgeActionsContext = React.createContext<DeploymentEdgeActions | null>(null);

const WorkflowEdge = React.memo<EdgeProps<DeploymentFlowEdge>>((props) => {
  const actions = React.useContext(DeploymentEdgeActionsContext);
  const [edgePath, labelX, labelY] = getBezierPath(props);
  const binding = props.data?.binding;

  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        interactionWidth={props.interactionWidth}
        className={cn('stroke-border', props.selected && 'stroke-primary')}
        data-flow-edge-id={props.id}
        data-source-node-id={binding?.sourceNodeId}
        data-source-port={binding?.sourcePort}
        data-target-node-id={binding?.targetNodeId}
        data-target-port={binding?.targetPort}
      />
      {actions?.editable && binding && (
        <EdgeToolbar
          edgeId={props.id}
          x={labelX}
          y={labelY}
          isVisible={props.selected}
          className="nodrag nopan"
        >
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            aria-label={actions.disconnectLabel}
            onClick={(event) => {
              event.stopPropagation();
              actions.onDisconnect({
                id: props.id,
                type: 'deployment',
                source: props.source,
                target: props.target,
                sourceHandle: props.sourceHandleId,
                targetHandle: props.targetHandleId,
                data: { binding },
              });
            }}
          >
            <UnlinkIcon data-icon="inline-start" />
          </Button>
        </EdgeToolbar>
      )}
    </>
  );
});

WorkflowEdge.displayName = 'WorkflowEdge';

const NODE_TYPES = { deployment: WorkflowNode } satisfies NodeTypes;
const EDGE_TYPES = { deployment: WorkflowEdge } satisfies EdgeTypes;

export interface WorkflowCanvasProps {
  draft: DeploymentWorkflowDraft;
  catalog: DeploymentNodeTypeCatalog;
  selectedNodeId: string | null;
  issues: readonly DeploymentEditorIssue[];
  editable: boolean;
}

type CanvasReactFlowProps = ReactFlowProps<WorkflowCanvasNode, DeploymentFlowEdge>;

export const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({
  draft,
  catalog,
  selectedNodeId,
  issues,
  editable,
}) => {
  const { locale, t } = useI18n();
  const selectNode = useDeploymentWorkflowStore((state) => state.selectNode);
  const moveNodes = useDeploymentWorkflowStore((state) => state.moveNodes);
  const connectInput = useDeploymentWorkflowStore((state) => state.connectInput);
  const disconnectInput = useDeploymentWorkflowStore((state) => state.disconnectInput);
  const reconnectInput = useDeploymentWorkflowStore((state) => state.reconnectInput);
  const addToast = useToastStore((state) => state.addToast);
  const viewportByWorkflowRef = React.useRef(new Map<string, Viewport>());
  const flowInstanceRef = React.useRef<ReactFlowInstance<WorkflowCanvasNode, DeploymentFlowEdge> | null>(null);
  const draggingNodeIdsRef = React.useRef(new Set<string>());
  const reconnectingRef = React.useRef<DeploymentBindingEndpoint | null>(null);
  const lastConnectionFailureRef = React.useRef<DeploymentConnectionFailureCode | null>(null);
  const canvasSelectionRef = React.useRef<{ pending: boolean; value: string | null }>({
    pending: false,
    value: null,
  });
  const previousSelectedNodeIdRef = React.useRef(selectedNodeId);
  const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null);
  const [keyboardAnnouncement, setKeyboardAnnouncement] = React.useState('');

  const projection = React.useMemo(() => projectDeploymentFlow(
    draft.definition,
    draft.layout,
    catalog,
    selectedNodeId,
  ), [catalog, draft.definition, draft.layout, selectedNodeId]);

  const projectedNodes = React.useMemo<WorkflowCanvasNode[]>(() => projection.nodes.map((node) => {
    const issueCount = issues.filter((issue) => issue.nodeId === node.id).length;
    const data: WorkflowCanvasNodeData = {
      ...node.data,
      issueCount,
      readOnly: !editable,
    };
    return {
      ...node,
      data,
      initialWidth: 240,
      initialHeight: 160,
      draggable: editable,
      connectable: editable,
      deletable: false,
      focusable: true,
      ariaLabel: t('deployment.editor.flow.nodeLabel', {
        name: node.data.workflowNode.displayName,
        version: node.data.workflowNode.typeVersion,
        issues: issueCount,
      }),
      domAttributes: {
        'data-node-id': node.id,
        'data-node-type': node.data.workflowNode.type,
        'data-node-type-version': String(node.data.workflowNode.typeVersion),
      } as unknown as WorkflowCanvasNode['domAttributes'],
    };
  }), [editable, issues, locale, projection.nodes]);

  const [nodes, setNodes] = React.useState<WorkflowCanvasNode[]>(projectedNodes);
  const nodesRef = React.useRef(nodes);
  nodesRef.current = nodes;

  React.useEffect(() => {
    setNodes((current) => {
      const existingById = new Map(current.map((node) => [node.id, node]));
      return projectedNodes.map((node) => {
        const existing = existingById.get(node.id);
        return {
          ...node,
          position: existing && draggingNodeIdsRef.current.has(node.id)
            ? existing.position
            : node.position,
          selected: existing?.selected ?? node.selected,
        };
      });
    });
  }, [projectedNodes]);

  React.useEffect(() => {
    const canvasSelection = canvasSelectionRef.current;
    if (canvasSelection.pending && canvasSelection.value === selectedNodeId) {
      canvasSelectionRef.current = { pending: false, value: null };
      previousSelectedNodeIdRef.current = selectedNodeId;
      return;
    }
    if (previousSelectedNodeIdRef.current === selectedNodeId) return;
    previousSelectedNodeIdRef.current = selectedNodeId;
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: node.id === selectedNodeId,
    })));
  }, [selectedNodeId]);

  const edges = React.useMemo<DeploymentFlowEdge[]>(() => projection.edges.map((edge) => ({
    ...edge,
    selected: edge.id === selectedEdgeId,
    deletable: false,
    focusable: true,
    reconnectable: editable,
    ariaLabel: t('deployment.editor.flow.edgeLabel', {
      source: draft.definition.nodes.find((node) => node.id === edge.source)?.displayName ?? edge.source,
      sourcePort: edge.data?.binding.sourcePort
        ? t(dynamicKey(`deployment.editor.port.${edge.data.binding.sourcePort}`))
        : '',
      target: draft.definition.nodes.find((node) => node.id === edge.target)?.displayName ?? edge.target,
      targetPort: edge.data?.binding.targetPort
        ? t(dynamicKey(`deployment.editor.port.${edge.data.binding.targetPort}`))
        : '',
    }),
  })), [draft.definition.nodes, editable, locale, projection.edges, selectedEdgeId]);

  React.useEffect(() => {
    if (selectedEdgeId && !edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [edges, selectedEdgeId]);

  const showConnectionFailure = React.useCallback((code: DeploymentConnectionFailureCode) => {
    addToast(t(dynamicKey(`deployment.editor.flow.connectionError.${code}`)), 'error', 5_000);
  }, [addToast, t]);

  const validateConnection = React.useCallback((connection: Connection | DeploymentFlowEdge) => {
    const candidate: Connection = {
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? null,
      target: connection.target,
      targetHandle: connection.targetHandle ?? null,
    };
    const result = validateDeploymentFlowConnection(
      draft.definition,
      catalog,
      candidate,
      reconnectingRef.current ? { replacing: reconnectingRef.current } : {},
    );
    lastConnectionFailureRef.current = result.valid ? null : result.reason.code;
    return result;
  }, [catalog, draft.definition]);

  const isValidConnection = React.useCallback<NonNullable<CanvasReactFlowProps['isValidConnection']>>(
    (connection) => editable && validateConnection(connection).valid,
    [editable, validateConnection],
  );

  const onConnect = React.useCallback<NonNullable<CanvasReactFlowProps['onConnect']>>((connection) => {
    if (!editable) return;
    const result = validateConnection(connection);
    if (!result.valid) {
      showConnectionFailure(result.reason.code);
      return;
    }
    lastConnectionFailureRef.current = null;
    connectInput(result.targetNodeId, result.targetPort, result.binding);
  }, [connectInput, editable, showConnectionFailure, validateConnection]);

  const onConnectEnd = React.useCallback<NonNullable<CanvasReactFlowProps['onConnectEnd']>>(
    (_event, connectionState) => {
      if (!connectionState.isValid && lastConnectionFailureRef.current) {
        showConnectionFailure(lastConnectionFailureRef.current);
      }
      lastConnectionFailureRef.current = null;
    },
    [showConnectionFailure],
  );

  const onReconnectStart = React.useCallback<NonNullable<CanvasReactFlowProps['onReconnectStart']>>(
    (_event, edge) => {
      const binding = edge.data?.binding ?? parseDeploymentFlowEdgeId(edge.id);
      reconnectingRef.current = binding
        ? { targetNodeId: binding.targetNodeId, targetPort: binding.targetPort }
        : null;
    },
    [],
  );

  const onReconnect = React.useCallback<NonNullable<CanvasReactFlowProps['onReconnect']>>((edge, connection) => {
    if (!editable) return;
    const previous = edge.data?.binding ?? parseDeploymentFlowEdgeId(edge.id);
    if (!previous) return;
    reconnectingRef.current = {
      targetNodeId: previous.targetNodeId,
      targetPort: previous.targetPort,
    };
    const result = validateConnection(connection);
    if (!result.valid) {
      showConnectionFailure(result.reason.code);
      return;
    }
    lastConnectionFailureRef.current = null;
    reconnectInput(
      previous.targetNodeId,
      previous.targetPort,
      result.targetNodeId,
      result.targetPort,
      result.binding,
    );
  }, [editable, reconnectInput, showConnectionFailure, validateConnection]);

  const onReconnectEnd = React.useCallback<NonNullable<CanvasReactFlowProps['onReconnectEnd']>>(
    (_event, _edge, _handleType, connectionState) => {
      if (!connectionState.isValid && lastConnectionFailureRef.current) {
        showConnectionFailure(lastConnectionFailureRef.current);
      }
      lastConnectionFailureRef.current = null;
      reconnectingRef.current = null;
    },
    [showConnectionFailure],
  );

  const disconnectEdge = React.useCallback((edge: DeploymentFlowEdge) => {
    const binding = edge.data?.binding ?? parseDeploymentFlowEdgeId(edge.id);
    if (!editable || !binding) return;
    disconnectInput(binding.targetNodeId, binding.targetPort);
    setSelectedEdgeId(null);
  }, [disconnectInput, editable]);

  const onNodesChange = React.useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    const safeChanges = changes.filter((change) => change.type !== 'remove');
    for (const change of safeChanges) {
      if (change.type === 'position' && change.dragging) {
        draggingNodeIdsRef.current.add(change.id);
      }
    }
    setNodes((current) => applyNodeChanges(safeChanges, current));
  }, []);

  const onEdgesChange = React.useCallback((changes: EdgeChange<DeploymentFlowEdge>[]) => {
    for (const change of changes) {
      if (change.type === 'remove') {
        const edge = edges.find((item) => item.id === change.id);
        if (edge) disconnectEdge(edge);
      }
      if (change.type === 'select') {
        setSelectedEdgeId((current) => change.selected ? change.id : current === change.id ? null : current);
      }
    }
  }, [disconnectEdge, edges]);

  const onNodeDragStart = React.useCallback<NonNullable<CanvasReactFlowProps['onNodeDragStart']>>(
    (_event, node, draggedNodes) => {
      draggingNodeIdsRef.current = new Set((draggedNodes.length > 0 ? draggedNodes : [node]).map((item) => item.id));
    },
    [],
  );

  const onNodeDragStop = React.useCallback<NonNullable<CanvasReactFlowProps['onNodeDragStop']>>(
    (_event, node, draggedNodes) => {
      if (!editable) return;
      const moved = new Map((draggedNodes.length > 0 ? draggedNodes : [node]).map((item) => [item.id, item]));
      draggingNodeIdsRef.current.clear();
      moveNodes([...moved.values()].map((item) => ({
        id: item.id,
        x: item.position.x,
        y: item.position.y,
      })));
    },
    [editable, moveNodes],
  );

  const selectFromCanvas = React.useCallback((id: string | null) => {
    canvasSelectionRef.current = { pending: true, value: id };
    selectNode(id);
  }, [selectNode]);

  const onSelectionChange = React.useCallback<NonNullable<CanvasReactFlowProps['onSelectionChange']>>(
    ({ nodes: selectedNodes }) => {
      if (selectedNodeId && selectedNodes.some((node) => node.id === selectedNodeId)) return;
      selectFromCanvas(selectedNodes[selectedNodes.length - 1]?.id ?? null);
    },
    [selectFromCanvas, selectedNodeId],
  );

  const onKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editable || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const element = event.target as HTMLElement;
    const focusedNodeId = element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
    if (!focusedNodeId) return;
    event.preventDefault();
    event.stopPropagation();
    const selectedNodes = nodesRef.current.filter((node) => node.selected);
    const movingNodes = selectedNodes.some((node) => node.id === focusedNodeId)
      ? selectedNodes
      : nodesRef.current.filter((node) => node.id === focusedNodeId);
    const delta = event.shiftKey ? 40 : 12;
    const changes = movingNodes.map((node) => ({
      id: node.id,
      x: Math.max(0, node.position.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0)),
      y: Math.max(0, node.position.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0)),
    }));
    moveNodes(changes);
    const focusedChange = changes.find((change) => change.id === focusedNodeId);
    if (focusedChange) {
      setKeyboardAnnouncement(t('deployment.editor.flow.nodeMoved', {
        direction: t(dynamicKey(`deployment.editor.flow.direction.${event.key.replace('Arrow', '').toLowerCase()}`)),
        x: focusedChange.x,
        y: focusedChange.y,
      }));
    }
  }, [editable, moveNodes, t]);

  const ariaLabelConfig = React.useMemo<Partial<AriaLabelConfig>>(() => ({
    'node.a11yDescription.default': t('deployment.editor.flow.nodeDescription'),
    'node.a11yDescription.keyboardDisabled': t('deployment.editor.flow.nodeDescription'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t(
      'deployment.editor.flow.nodeMoved',
      {
        direction: t(dynamicKey(`deployment.editor.flow.direction.${direction}`)),
        x,
        y,
      },
    ),
    'edge.a11yDescription.default': t('deployment.editor.flow.edgeDescription'),
    'controls.ariaLabel': t('deployment.editor.flow.controls'),
    'controls.zoomIn.ariaLabel': t('deployment.editor.flow.zoomIn'),
    'controls.zoomOut.ariaLabel': t('deployment.editor.flow.zoomOut'),
    'controls.fitView.ariaLabel': t('deployment.editor.flow.fitView'),
    'controls.interactive.ariaLabel': t('deployment.editor.flow.interactive'),
    'minimap.ariaLabel': t('deployment.editor.flow.minimap'),
    'handle.ariaLabel': t('deployment.editor.flow.handle'),
  }), [locale]);

  const workflowViewportKey = draft.id ?? 'new-workflow';
  const initialViewport = viewportByWorkflowRef.current.get(workflowViewportKey) ?? DEFAULT_VIEWPORT;
  const edgeActions = React.useMemo<DeploymentEdgeActions>(() => ({
    editable,
    disconnectLabel: t('deployment.editor.flow.disconnect'),
    onDisconnect: disconnectEdge,
  }), [disconnectEdge, editable, locale]);

  return (
    <div
      className="deployment-workflow-flow relative size-full min-h-0 min-w-0 overflow-hidden bg-background"
      data-testid="deployment-workflow-canvas"
      aria-label={t('deployment.editor.flow.canvasLabel', { name: draft.name })}
      onKeyDownCapture={onKeyDownCapture}
    >
      <span className="sr-only" aria-live="polite">{keyboardAnnouncement}</span>
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
      <DeploymentEdgeActionsContext.Provider value={edgeActions}>
        <ReactFlow<WorkflowCanvasNode, DeploymentFlowEdge>
          key={workflowViewportKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_event, node) => selectFromCanvas(node.id)}
          onPaneClick={() => {
            setSelectedEdgeId(null);
            selectFromCanvas(null);
          }}
          onSelectionChange={onSelectionChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          isValidConnection={isValidConnection}
          nodesDraggable={editable}
          nodesConnectable={editable}
          edgesReconnectable={editable}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          selectionOnDrag
          panOnDrag={[1, 2]}
          deleteKeyCode={null}
          minZoom={0.25}
          maxZoom={2}
          defaultViewport={initialViewport}
          onInit={(instance) => { flowInstanceRef.current = instance; }}
          onMoveEnd={(_event, viewport) => {
            viewportByWorkflowRef.current.set(workflowViewportKey, viewport);
          }}
          ariaLabelConfig={ariaLabelConfig}
          aria-label={t('deployment.editor.flow.canvasLabel', { name: draft.name })}
        >
          <Background color="var(--border)" gap={20} size={1} />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            aria-label={t('deployment.editor.flow.controls')}
            className="overflow-hidden rounded-md border border-border bg-background text-foreground"
          >
            <ControlButton
              type="button"
              title={t('deployment.editor.flow.resetViewport')}
              aria-label={t('deployment.editor.flow.resetViewport')}
              onClick={() => {
                viewportByWorkflowRef.current.set(workflowViewportKey, DEFAULT_VIEWPORT);
                void flowInstanceRef.current?.setViewport(DEFAULT_VIEWPORT, { duration: 200 });
              }}
            >
              <LocateFixedIcon aria-hidden />
            </ControlButton>
          </Controls>
          {nodes.length >= DEPLOYMENT_MINIMAP_NODE_THRESHOLD && (
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
      </DeploymentEdgeActionsContext.Provider>
    </div>
  );
};
