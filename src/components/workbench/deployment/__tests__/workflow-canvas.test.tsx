import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Position, type Connection, type Edge, type Node, type ReactFlowProps } from '@xyflow/react';
import type { DeploymentEditorIssue } from '@/lib/deployment/editor';
import {
  deploymentInputHandleId,
  deploymentOutputHandleId,
} from '@/lib/deployment/flow-connection';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { useToastStore } from '@/stores/toastStore';
import { WorkflowCanvas } from '../workflow-canvas';

const flowMock = vi.hoisted(() => ({
  props: null as ReactFlowProps<Node, Edge> | null,
}));

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');
  const applyNodeChanges = (
    changes: Array<Record<string, unknown>>,
    nodes: Array<Record<string, unknown>>,
  ) => changes.reduce((current, change) => {
    if (change.type === 'remove') return current.filter((node) => node.id !== change.id);
    return current.map((node) => {
      if (node.id !== change.id) return node;
      if (change.type === 'position') {
        return { ...node, position: change.position ?? node.position, dragging: change.dragging };
      }
      if (change.type === 'select') return { ...node, selected: change.selected };
      return node;
    });
  }, nodes);

  const ReactFlow = (props: ReactFlowProps<Node, Edge>) => {
    flowMock.props = props;
    return (
      <div data-testid="react-flow" aria-label={props['aria-label']}>
        {(props.nodes ?? []).map((node) => {
          const Component = props.nodeTypes?.[node.type ?? 'default'];
          return Component ? (
            <div key={node.id} data-flow-node-wrapper={node.id} {...node.domAttributes}>
              <Component
                id={node.id}
                type={node.type ?? 'default'}
                data={node.data}
                selected={node.selected ?? false}
                dragging={node.dragging ?? false}
                draggable={node.draggable ?? true}
                selectable={node.selectable ?? true}
                deletable={node.deletable ?? true}
                isConnectable={node.connectable ?? true}
                zIndex={node.zIndex ?? 0}
                positionAbsoluteX={node.position.x}
                positionAbsoluteY={node.position.y}
              />
            </div>
          ) : null;
        })}
        {(props.edges ?? []).map((edge) => {
          const Component = props.edgeTypes?.[edge.type ?? 'default'];
          return Component ? (
            <Component
              key={edge.id}
              id={edge.id}
              type={edge.type}
              source={edge.source}
              target={edge.target}
              sourceX={0}
              sourceY={0}
              targetX={100}
              targetY={100}
              sourcePosition={Position.Right}
              targetPosition={Position.Left}
              sourceHandleId={edge.sourceHandle ?? null}
              targetHandleId={edge.targetHandle ?? null}
              data={edge.data}
              selected={edge.selected ?? false}
              animated={false}
              selectable
              deletable={edge.deletable ?? true}
              interactionWidth={20}
            />
          ) : null;
        })}
        {props.children}
      </div>
    );
  };

  const Controls = ({ children }: { children?: React.ReactNode }) => {
    const labels = flowMock.props?.ariaLabelConfig;
    return (
      <div data-testid="flow-controls">
        <button type="button" aria-label={String(labels?.['controls.zoomIn.ariaLabel'])} />
        <button type="button" aria-label={String(labels?.['controls.zoomOut.ariaLabel'])} />
        <button type="button" aria-label={String(labels?.['controls.fitView.ariaLabel'])} />
        {children}
      </div>
    );
  };

  return {
    Background: () => <div data-testid="flow-background" />,
    BaseEdge: ({ interactionWidth: _interactionWidth, ...props }: React.SVGProps<SVGPathElement> & { interactionWidth?: number }) => (
      <svg><path {...props} /></svg>
    ),
    ControlButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
    Controls,
    EdgeToolbar: ({ children, isVisible }: { children?: React.ReactNode; isVisible?: boolean }) => (
      isVisible ? <div data-testid="edge-toolbar">{children}</div> : null
    ),
    Handle: ({
      isConnectable: _isConnectable,
      isConnectableEnd: _isConnectableEnd,
      isConnectableStart: _isConnectableStart,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      id?: string;
      type?: string;
      isConnectable?: boolean;
      isConnectableEnd?: boolean;
      isConnectableStart?: boolean;
    }) => <div {...props} data-handle-id={props.id} data-handle-type={props.type} />,
    MiniMap: () => <div data-testid="flow-minimap" />,
    Position: { Left: 'left', Right: 'right' },
    ReactFlow,
    applyNodeChanges,
    getBezierPath: () => ['M 0 0 C 25 0, 75 100, 100 100', 50, 50],
  };
});

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const suffix = values ? `:${Object.values(values).join(':')}` : '';
      return `${key}${suffix}`;
    },
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [
    {
      typeName: 'source.snapshot', typeVersion: 1,
      displayNameKey: 'deployment.node.source_snapshot.name',
      descriptionKey: 'deployment.node.source_snapshot.description', category: 'source',
      inputs: [], outputs: [{ name: 'source', portType: 'source.snapshot', required: false }],
      executionDomain: 'local', effectClass: 'localRead', capabilities: ['sourceSnapshot'],
      configSchemaVersion: 1, configSchema: { schemaVersion: 1, fields: [] },
      defaultConfig: { sourceRef: 'workspace' }, riskLevel: 'low',
      fixedActions: ['freeze_source_snapshot'], retryable: true,
    },
    {
      typeName: 'build.package-script', typeVersion: 1,
      displayNameKey: 'deployment.node.build_package_script.name',
      descriptionKey: 'deployment.node.build_package_script.description', category: 'build',
      inputs: [{ name: 'source', portType: 'source.snapshot', required: true }],
      outputs: [{
        name: 'bundle', portType: 'artifact.bundle', required: false,
        artifactTypes: ['application/vnd.shellspan.file-tree'],
      }],
      executionDomain: 'local', effectClass: 'localBuild', capabilities: ['packageManager'],
      configSchemaVersion: 1, configSchema: { schemaVersion: 1, fields: [] },
      defaultConfig: { packageManager: 'pnpm' }, riskLevel: 'medium',
      fixedActions: ['run_fixed_package_manager_script'], retryable: true,
    },
  ],
};

const definition: DeploymentWorkflowDefinition = {
  schemaVersion: 3,
  targets: [],
  parameters: [],
  nodes: [
    {
      id: 'source', type: 'source.snapshot', typeVersion: 1, displayName: 'Freeze source',
      inputs: {}, config: { sourceRef: 'workspace' }, timeoutSeconds: 60,
      retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
    },
    {
      id: 'build', type: 'build.package-script', typeVersion: 1, displayName: 'Build site',
      inputs: { source: { fromNodeId: 'source', fromPort: 'source' } },
      config: { packageManager: 'pnpm' }, timeoutSeconds: 120,
      retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
    },
  ],
  outputs: {},
  policy: { failFast: true, maxParallelLocalNodes: 2, releasesToKeep: 3, automaticRestore: true },
};

const draft: Pick<DeploymentWorkflowRecord, 'id' | 'name' | 'enabled' | 'revision' | 'layoutRevision'> & {
  definition: DeploymentWorkflowDefinition;
  layout: NonNullable<DeploymentWorkflowRecord['layout']>;
} = {
  id: 'workflow-1', name: 'Website', enabled: false, revision: 3, layoutRevision: 2,
  definition,
  layout: {
    schemaVersion: 1,
    nodes: { source: { x: 24, y: 24 }, build: { x: 340, y: 180 } },
    groups: [],
  },
};

const issue: DeploymentEditorIssue = {
  id: 'missing-input',
  code: 'LOCAL_MISSING_INPUT',
  messageKey: 'deployment.editor.validation.localMissingInput',
  nodeId: 'build',
  source: 'local',
};

function renderCanvas(options?: {
  issues?: DeploymentEditorIssue[];
  editable?: boolean;
  canvasDraft?: typeof draft;
}) {
  return render(
    <WorkflowCanvas
      draft={options?.canvasDraft ?? draft}
      catalog={catalog}
      selectedNodeId="build"
      issues={options?.issues ?? [issue]}
      editable={options?.editable ?? true}
    />,
  );
}

describe('WorkflowCanvas', () => {
  beforeEach(() => {
    flowMock.props = null;
    useDeploymentWorkflowStore.getState().reset();
    useToastStore.setState({ toasts: [] });
  });

  it('projects readable nodes, binding-only edges, stable handles, and localized accessibility labels', () => {
    renderCanvas();

    expect(screen.getByTestId('deployment-workflow-canvas')).toHaveAttribute(
      'aria-label',
      'deployment.editor.flow.canvasLabel:Website',
    );
    expect(screen.getAllByTestId('deployment-flow-node')).toHaveLength(2);
    expect(screen.getByText('Build site')).toBeInTheDocument();
    expect(screen.getByText('deployment.editor.flow.issueCount:1')).toBeInTheDocument();
    expect(screen.getByText('deployment.editor.effect.localBuild')).toBeInTheDocument();
    expect(screen.getByText('deployment.editor.risk.medium')).toBeInTheDocument();
    expect(screen.getAllByText('deployment.editor.domain.local')).toHaveLength(2);

    expect(document.querySelector(`[data-handle-id="${deploymentInputHandleId('source')}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-handle-id="${deploymentOutputHandleId('bundle')}"]`)).not.toBeNull();
    expect(document.querySelectorAll('[data-edge-id]')).toHaveLength(1);
    expect(document.querySelector('[data-edge-id]')).toMatchObject({
      dataset: {
        sourceNodeId: 'source',
        sourcePort: 'source',
        targetNodeId: 'build',
        targetPort: 'source',
      },
    });
    expect(flowMock.props?.deleteKeyCode).toBeNull();
    expect(flowMock.props?.ariaLabelConfig).toMatchObject({
      'controls.fitView.ariaLabel': 'deployment.editor.flow.fitView',
      'handle.ariaLabel': 'deployment.editor.flow.handle',
    });
    expect(screen.getByRole('button', { name: 'deployment.editor.flow.fitView' })).toBeInTheDocument();
  });

  it('writes a valid connection once and reports an invalid target without changing bindings', () => {
    const connectInput = vi.fn();
    useDeploymentWorkflowStore.setState({ connectInput });
    const unboundDraft: typeof draft = {
      ...structuredClone(draft),
      definition: {
        ...structuredClone(draft.definition),
        nodes: draft.definition.nodes.map((node) => node.id === 'build'
          ? { ...structuredClone(node), inputs: {} }
          : structuredClone(node)),
      },
    };
    renderCanvas({ canvasDraft: unboundDraft, issues: [] });
    const valid: Connection = {
      source: 'source',
      sourceHandle: deploymentOutputHandleId('source'),
      target: 'build',
      targetHandle: deploymentInputHandleId('source'),
    };

    act(() => flowMock.props?.onConnect?.(valid));
    expect(connectInput).toHaveBeenCalledOnce();
    expect(connectInput).toHaveBeenCalledWith('build', 'source', {
      fromNodeId: 'source',
      fromPort: 'source',
    });

    const invalid: Connection = {
      source: 'build',
      sourceHandle: deploymentOutputHandleId('bundle'),
      target: 'build',
      targetHandle: deploymentInputHandleId('source'),
    };
    expect(flowMock.props?.isValidConnection?.(invalid)).toBe(false);
    act(() => flowMock.props?.onConnectEnd?.({} as MouseEvent, {
      fromNode: null,
      fromHandle: null,
      fromPosition: null,
      from: null,
      toNode: null,
      toHandle: null,
      toPosition: null,
      to: null,
      isValid: false,
      inProgress: false,
    } as never));
    expect(connectInput).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      'deployment.editor.flow.connectionError.SELF_CONNECTION',
    );
  });

  it('routes explicit edge removal and reconnection through atomic Store operations', () => {
    const disconnectInput = vi.fn();
    const reconnectInput = vi.fn();
    useDeploymentWorkflowStore.setState({ disconnectInput, reconnectInput });
    renderCanvas();

    act(() => flowMock.props?.onEdgesChange?.([{
      id: flowMock.props?.edges?.[0]?.id ?? '',
      type: 'select',
      selected: true,
    }]));
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.flow.disconnect' }));
    expect(disconnectInput).toHaveBeenCalledWith('build', 'source');

    const edge = flowMock.props?.edges?.[0];
    expect(edge).toBeDefined();
    act(() => flowMock.props?.onReconnectStart?.({} as React.MouseEvent, edge!, 'source'));
    act(() => flowMock.props?.onReconnect?.(edge!, {
      source: 'source',
      sourceHandle: deploymentOutputHandleId('source'),
      target: 'build',
      targetHandle: deploymentInputHandleId('source'),
    }));
    expect(reconnectInput).toHaveBeenCalledOnce();
    expect(reconnectInput).toHaveBeenCalledWith(
      'build',
      'source',
      'build',
      'source',
      { fromNodeId: 'source', fromPort: 'source' },
    );
  });

  it('keeps drag positions local until drag stop and commits a multi-node move once', () => {
    const moveNodes = vi.fn();
    useDeploymentWorkflowStore.setState({ moveNodes });
    renderCanvas();

    act(() => flowMock.props?.onNodesChange?.([
      { id: 'source', type: 'position', position: { x: 80, y: 96 }, dragging: true },
      { id: 'build', type: 'position', position: { x: 400, y: 220 }, dragging: true },
    ]));
    expect(moveNodes).not.toHaveBeenCalled();

    const moved = (flowMock.props?.nodes ?? []).map((node) => ({
      ...node,
      position: node.id === 'source' ? { x: 80, y: 96 } : { x: 400, y: 220 },
    }));
    act(() => flowMock.props?.onNodeDragStop?.({} as MouseEvent, moved[0]!, moved));
    expect(moveNodes).toHaveBeenCalledOnce();
    expect(moveNodes).toHaveBeenCalledWith([
      { id: 'source', x: 80, y: 96 },
      { id: 'build', x: 400, y: 220 },
    ]);
  });

  it('synchronizes node selection, clears it from the pane, and preserves keyboard movement', () => {
    const selectNode = vi.fn();
    const moveNodes = vi.fn();
    useDeploymentWorkflowStore.setState({ selectNode, moveNodes });
    renderCanvas();
    const source = flowMock.props?.nodes?.find((node) => node.id === 'source');
    expect(source).toBeDefined();

    act(() => flowMock.props?.onNodeClick?.({} as React.MouseEvent, source!));
    expect(selectNode).toHaveBeenLastCalledWith('source');
    act(() => flowMock.props?.onPaneClick?.({} as React.MouseEvent));
    expect(selectNode).toHaveBeenLastCalledWith(null);

    const canvas = screen.getByTestId('deployment-workflow-canvas');
    const sourceWrapper = within(canvas).getAllByTestId('deployment-flow-node')[0]!.parentElement!;
    sourceWrapper.focus();
    fireEvent.keyDown(sourceWrapper, { key: 'ArrowRight' });
    expect(moveNodes).toHaveBeenCalledWith([{ id: 'source', x: 36, y: 24 }]);
    expect(screen.getByText('deployment.editor.flow.nodeMoved:deployment.editor.flow.direction.right:36:24')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('keeps invalid-connection feedback single under Strict Mode and makes read-only state explicit', () => {
    const { unmount } = render(
      <React.StrictMode>
        <WorkflowCanvas
          draft={draft}
          catalog={catalog}
          selectedNodeId="build"
          issues={[]}
          editable
        />
      </React.StrictMode>,
    );
    const invalid: Connection = {
      source: 'build',
      sourceHandle: deploymentOutputHandleId('bundle'),
      target: 'build',
      targetHandle: deploymentInputHandleId('source'),
    };
    expect(flowMock.props?.isValidConnection?.(invalid)).toBe(false);
    act(() => flowMock.props?.onConnectEnd?.({} as MouseEvent, {
      fromNode: null,
      fromHandle: null,
      fromPosition: null,
      from: null,
      toNode: null,
      toHandle: null,
      toPosition: null,
      to: null,
      isValid: false,
      inProgress: false,
    } as never));
    expect(useToastStore.getState().toasts).toHaveLength(1);

    unmount();
    renderCanvas({ editable: false, issues: [] });
    expect(screen.getAllByText('deployment.editor.flow.readOnly')).toHaveLength(2);
    expect(flowMock.props?.nodesDraggable).toBe(false);
    expect(flowMock.props?.nodesConnectable).toBe(false);
    expect(flowMock.props?.edgesReconnectable).toBe(false);
  });
});
