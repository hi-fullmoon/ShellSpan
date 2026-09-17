import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentWorkflowCenter } from '../deployment-workflow-center';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (values?.name) return `${key}:${values.name}`;
      if (values?.count != null) return `${key}:${values.count}`;
      if (values?.revision != null) return `${key}:${values.revision}`;
      return key;
    },
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

const profile: ConnectionProfile = {
  id: 'profile-1', name: 'Production', host: 'example.test', port: 22,
  username: 'deploy', authMethod: 'password', createdAt: 1, updatedAt: 1,
};

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [
    {
      typeName: 'source.snapshot', typeVersion: 1,
      displayNameKey: 'deployment.node.source_snapshot.name',
      descriptionKey: 'deployment.node.source_snapshot.description', category: 'source',
      inputs: [], outputs: [{ name: 'source', portType: 'source.snapshot', required: false }],
      executionDomain: 'local', effectClass: 'localRead', capabilities: ['sourceSnapshot'],
      configSchemaVersion: 1,
      configSchema: {
        schemaVersion: 1,
        fields: [{
          name: 'sourceRef', labelKey: 'deployment.editor.config.sourceRef.label',
          descriptionKey: 'deployment.editor.config.sourceRef.description', kind: 'string', required: true,
        }],
      },
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
      configSchemaVersion: 1,
      configSchema: {
        schemaVersion: 1,
        fields: [{
          name: 'packageManager', labelKey: 'deployment.editor.config.packageManager.label',
          descriptionKey: 'deployment.editor.config.packageManager.description', kind: 'select', required: true,
          options: [
            { value: 'pnpm', labelKey: 'deployment.editor.option.packageManager.pnpm' },
            { value: 'npm', labelKey: 'deployment.editor.option.packageManager.npm' },
          ],
        }],
      },
      defaultConfig: { packageManager: 'pnpm' }, riskLevel: 'medium',
      fixedActions: ['run_fixed_package_manager_script'], retryable: true,
    },
  ],
};

const definition: DeploymentWorkflowDefinition = {
  schemaVersion: 3,
  targets: [{ id: 'production', connectionProfileId: profile.id, remoteRoot: '/srv/site' }],
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

const workflow: DeploymentWorkflowRecord = {
  id: 'workflow-1', name: 'Website', enabled: false, archived: false,
  revision: 3, definitionDigest: `sha256:${'a'.repeat(64)}`, definition,
  layoutRevision: 2,
  layout: {
    schemaVersion: 1,
    nodes: { source: { x: 24, y: 24 }, build: { x: 340, y: 180 } },
    groups: [],
  },
  createdAt: 1,
  updatedAt: 2,
};

let workspaceResize: ((width: number) => void) | null = null;

class DeploymentResizeObserverMock implements ResizeObserver {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  disconnect(): void {}

  observe(target: Element): void {
    if (target.getAttribute('data-testid') === 'deployment-design-workspace') {
      workspaceResize = (width) => this.callback([
        {
          target,
          contentRect: {
            width,
            height: 640,
            x: 0,
            y: 0,
            top: 0,
            right: width,
            bottom: 640,
            left: 0,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry,
      ], this);
    }
    if (target.getAttribute('data-slot') === 'scroll-area-viewport') {
      Object.defineProperty(target, 'getAnimations', {
        configurable: true,
        value: () => [],
      });
    }
  }

  unobserve(): void {}
}

function resizeWorkspace(width: number): void {
  if (!workspaceResize) throw new Error('Deployment workspace ResizeObserver was not registered');
  act(() => workspaceResize?.(width));
}

describe('DeploymentWorkflowCenter', () => {
  beforeEach(() => {
    workspaceResize = null;
    vi.stubGlobal('ResizeObserver', DeploymentResizeObserverMock);
    useDeploymentWorkflowStore.getState().reset();
    useDeploymentWorkflowRunStore.getState().reset();
    useDeploymentWorkflowRunStore.setState({ workflowId: workflow.id });
    useDeploymentWorkflowStore.setState({
      capabilities: {
        schemaVersion: 1, admissionsEnabled: true, defaultEnabled: false,
        flagName: 'SHELLSPAN_DEPLOYMENT_WORKFLOW', source: 'environment',
        readOnlyAvailable: true, cancelRecoveryAuditAvailable: true, coordinatorAvailable: true,
      },
      catalog,
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      selectedNodeId: 'build',
      draft: {
        id: workflow.id, name: workflow.name, enabled: workflow.enabled,
        revision: workflow.revision, layoutRevision: workflow.layoutRevision,
        definition: structuredClone(workflow.definition),
        layout: structuredClone(workflow.layout!),
      },
      initialized: true,
    });
    useProfileStore.setState({ profiles: [profile] });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders mutually exclusive canvas and narrow topology surfaces from the same binding data', () => {
    render(<DeploymentWorkflowCenter />);
    const canvas = screen.getByTestId('deployment-workflow-canvas');
    expect(canvas.querySelectorAll('[data-node-id]')).toHaveLength(2);
    expect(canvas.querySelectorAll('[data-edge-id]')).toHaveLength(1);
    expect(canvas.querySelector('[data-edge-id]')).toMatchObject({
      dataset: {
        sourceNodeId: 'source',
        sourcePort: 'source',
        targetNodeId: 'build',
        targetPort: 'source',
      },
    });
    expect(screen.queryByTestId('deployment-topology-list')).not.toBeInTheDocument();

    resizeWorkspace(428);

    expect(screen.queryByTestId('deployment-workflow-canvas')).not.toBeInTheDocument();
    const topology = screen.getByTestId('deployment-topology-list');
    expect(topology.querySelectorAll('[data-topology-node-id]')).toHaveLength(2);

    const sourceBinding = within(topology).getByLabelText('deployment.editor.port.source');
    expect(sourceBinding).toHaveTextContent('Freeze source');
    expect(sourceBinding).not.toHaveTextContent('source|source');
  });

  it('builds a card-free three-pane workspace with accessible resize handles and a fixed status bar', () => {
    render(<DeploymentWorkflowCenter />);
    const workspace = screen.getByTestId('deployment-design-workspace');
    expect(workspace.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(workspace).toHaveAttribute('data-layout', 'wide');
    expect(screen.getByTestId('deployment-workspace-wide')).toBeInTheDocument();
    expect(workspace.querySelectorAll('[data-panel]')).toHaveLength(3);
    expect(within(workspace).getAllByRole('separator')).toHaveLength(2);
    expect(within(workspace).getByRole('separator', { name: 'deployment.editor.resize.workflows' })).toBeInTheDocument();
    expect(within(workspace).getByRole('separator', { name: 'deployment.editor.resize.inspector' })).toBeInTheDocument();
    expect(screen.getByTestId('deployment-validation-status')).toHaveClass('shrink-0', 'border-t');

    const toolbar = screen.getByTestId('deployment-workflow-toolbar');
    expect(toolbar).toHaveClass('flex-nowrap');
    expect(within(toolbar).getByRole('tab', { name: 'deployment.editor.tab.design' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps every deployment center tab free of Card DOM', () => {
    for (const initialTab of ['design', 'prepare', 'runs', 'versions'] as const) {
      const view = render(<DeploymentWorkflowCenter initialTab={initialTab} />);
      expect(view.container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('exposes searchable grouped drawers with a fixed title, scrolling body, and focus return', async () => {
    render(<DeploymentWorkflowCenter />);
    resizeWorkspace(858);

    const trigger = screen.getByRole('button', { name: 'deployment.editor.nodeLibrary' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('heading', { name: 'deployment.editor.nodeLibrary' })).toBeInTheDocument();
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    expect(drawer).toHaveClass('min-h-0', 'overflow-hidden');
    expect(drawer?.querySelector('[data-slot="drawer-header"]')).toHaveClass('shrink-0');
    expect(drawer?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(screen.getByRole('heading', { name: 'deployment.editor.category.source' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.editor.category.build' })).toBeInTheDocument();

    const search = screen.getByRole('textbox', { name: 'deployment.editor.searchNodes' });
    fireEvent.change(search, { target: { value: 'not-present' } });
    expect(screen.getByText('deployment.editor.noNodeSearchResults')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('deduplicates save toasts under repeated notice delivery', async () => {
    render(
      <React.StrictMode>
        <DeploymentWorkflowCenter />
      </React.StrictMode>,
    );
    act(() => {
      useDeploymentWorkflowStore.setState({ notice: { id: 41, kind: 'saved' } });
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    act(() => {
      useDeploymentWorkflowStore.setState({ notice: { id: 41, kind: 'saved' } });
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  });

  it('deduplicates runtime operation toasts under repeated notice delivery', async () => {
    render(
      <React.StrictMode>
        <DeploymentWorkflowCenter />
      </React.StrictMode>,
    );
    act(() => {
      useDeploymentWorkflowRunStore.setState({ notice: { id: 91, kind: 'prepared' } });
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    act(() => {
      useDeploymentWorkflowRunStore.setState({ notice: { id: 91, kind: 'prepared' } });
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
  });

  it('provides keyboard alternatives for canvas selection, layout movement, and configuration', () => {
    const { container } = render(<DeploymentWorkflowCenter />);
    const source = container.querySelector<HTMLElement>('[data-node-id="source"]');
    expect(source).not.toBeNull();
    source!.focus();
    fireEvent.keyDown(source!, { key: 'ArrowRight', altKey: true });
    expect(useDeploymentWorkflowStore.getState().draft?.layout.nodes.source.x).toBe(36);
    fireEvent.keyDown(source!, { key: 'Enter' });
    expect(useDeploymentWorkflowStore.getState().selectedNodeId).toBe('source');

    resizeWorkspace(428);
    const configure = screen.getAllByRole('button', { name: 'deployment.editor.configure' })[0]!;
    fireEvent.click(configure);
    expect(screen.getByRole('heading', { name: 'deployment.editor.configuration' })).toBeInTheDocument();
    expect(screen.getByTestId('deployment-node-config').querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    return waitFor(() => expect(configure).toHaveFocus());
  });
});
