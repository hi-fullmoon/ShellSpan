import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentWorkflowCenter } from '../deployment-workflow-center';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { DeploymentEditorIssue } from '@/lib/deployment/editor';
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

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeValidateDeploymentWorkflow: vi.fn().mockResolvedValue({ valid: true, errors: [], compiled: {} }),
}));

const profile: ConnectionProfile = {
  id: 'profile-1', name: 'Production', host: 'example.test', port: 22,
  username: 'deploy', authMethod: 'password', createdAt: 1, updatedAt: 1,
};

const filteredProfile: ConnectionProfile = {
  id: 'profile-2', name: 'Staging', host: 'staging.example.test', port: 22,
  username: 'release', authMethod: 'password', createdAt: 1, updatedAt: 1,
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
    useDeploymentWorkflowRunStore.setState({
      workflowId: workflow.id,
      refreshWorkflow: vi.fn().mockResolvedValue(undefined),
    });
    useDeploymentWorkflowStore.setState({
      capabilities: {
        schemaVersion: 1, admissionsEnabled: true, defaultEnabled: true,
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

  it.each(['pipeline', 'runs', 'versions'] as const)('remembers the %s tab after leaving and reopening the center', (tab) => {
    const view = render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('tab', { name: `deployment.editor.tab.${tab}` }));
    view.unmount();
    render(<DeploymentWorkflowCenter />);
    expect(screen.getByRole('tab', { name: `deployment.editor.tab.${tab}` })).toHaveAttribute('aria-selected', 'true');
  });

  it('honors an explicit requested tab over the remembered selection and remembers the destination', () => {
    useDeploymentWorkflowStore.getState().setActiveTab('versions');
    useDeploymentWorkflowStore.getState().requestTab('pipeline');
    const view = render(<DeploymentWorkflowCenter />);
    expect(screen.getByRole('tab', { name: 'deployment.editor.tab.pipeline' })).toHaveAttribute('aria-selected', 'true');
    expect(useDeploymentWorkflowStore.getState().requestedTab).toBeNull();
    view.unmount();
    render(<DeploymentWorkflowCenter />);
    expect(screen.getByRole('tab', { name: 'deployment.editor.tab.pipeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the pipeline tab by default', () => {
    render(<DeploymentWorkflowCenter />);
    expect(screen.getByRole('tab', { name: 'deployment.editor.tab.pipeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the deployments tab with a disabled deploy CTA when explicitly requested', () => {
    render(<DeploymentWorkflowCenter initialTab="runs" />);
    expect(screen.getByRole('tab', { name: 'deployment.editor.tab.runs' })).toHaveAttribute('aria-selected', 'true');
    const cta = screen.getByTestId('deployment-run-empty-cta');
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent('deployment.runtime.deploy.action');
  });

  it('renders the pipeline as an ordered step list with binding-derived relations and selection', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const steps = screen.getByTestId('deployment-step-list');
    const rows = steps.querySelectorAll('[data-step-node-id]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-step-node-id', 'source');
    expect(rows[1]).toHaveAttribute('data-step-node-id', 'build');
    expect(steps).toHaveTextContent('deployment.editor.stepList.relations');
    for (const button of within(steps).getAllByRole('button', { name: 'deployment.editor.configure' })) {
      expect(button).toHaveClass('@min-[1152px]:hidden');
    }

    fireEvent.click(within(steps).getByRole('button', { name: 'deployment.editor.stepList.stepAria:Freeze source' }));
    expect(useDeploymentWorkflowStore.getState().selectedNodeId).toBe('source');
    expect(screen.getByTestId('deployment-node-config')).toHaveTextContent('Freeze source');
  });

  it('aligns the pipeline columns under one shared pane header height with full-width step separators', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const workspace = screen.getByTestId('deployment-workspace-wide');
    const headers = workspace.querySelectorAll('[data-slot="deployment-pane-header"]');
    expect(headers).toHaveLength(3);
    for (const header of headers) {
      expect(header).toHaveClass('min-h-12', 'items-center', 'border-b', 'shrink-0');
    }
    for (const description of workspace.querySelectorAll('[data-slot="deployment-pane-header"] p')) {
      expect(description).toHaveClass('truncate');
    }

    const separators = screen.getByTestId('deployment-step-list').querySelectorAll('[data-slot="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]).not.toHaveClass('mx-3', 'w-auto');
  });

  it('keeps step rows compact with uniform item padding under the pane header', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const steps = screen.getByTestId('deployment-step-list');
    expect(steps.querySelector('[data-slot="scroll-area-viewport"] > div')).toHaveClass('pb-1');
    const rows = steps.querySelectorAll('[data-step-node-id]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveClass('py-1');
    }
    for (const row of rows) {
      expect(row.querySelector('button')).toHaveClass('h-auto', 'justify-start', 'py-1.5');
    }
  });

  it('renders workflow list rows tall enough for a comfortable click target', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const workflowList = screen.getByTestId('deployment-workflow-list');
    expect(within(workflowList).getByRole('button', { name: /Website/ }))
      .toHaveClass('h-auto', 'justify-start', 'py-2.5');

    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate(
        'blank',
        'Second workflow',
        profile.id,
        '/srv/second',
      );
    });
    await waitFor(() => expect(
      within(workflowList).getByRole('button', { name: /Second workflow/ }),
    ).toHaveClass('h-auto', 'justify-start', 'py-2.5'));
  });

  it('keeps the same step list available in the compact layout with configure drawers', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    resizeWorkspace(428);

    const steps = screen.getByTestId('deployment-step-list');
    expect(steps.querySelectorAll('[data-step-node-id]')).toHaveLength(2);
    expect(screen.queryByTestId('deployment-workspace-wide')).not.toBeInTheDocument();

    const configure = screen.getAllByRole('button', { name: 'deployment.editor.configure' })[0]!;
    fireEvent.click(configure);
    expect(screen.getByRole('heading', { name: 'deployment.editor.configuration' })).toBeInTheDocument();
    expect(screen.getByTestId('deployment-node-config').querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    // The drawer header keeps the shared 48px pane-header height and the close
    // button aligns with that row instead of hanging below the divider when
    // the title has no description line.
    const configDrawer = document.querySelector('[data-slot="drawer-content"]');
    expect(configDrawer?.querySelector('[data-slot="drawer-header"]'))
      .toHaveClass('min-h-12', 'justify-center', 'px-3', 'py-3', 'pr-12');
    expect(configDrawer?.querySelectorAll('[data-slot="drawer-title"]')).toHaveLength(1);
    expect(configDrawer?.querySelector('[data-slot="field-group"]')).toHaveClass('p-3');
    expect(configDrawer?.querySelector('[data-slot="drawer-close"]'))
      .toHaveClass('top-2', 'right-3', 'size-8');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    return waitFor(() => expect(configure).toHaveFocus());
  });

  it('keeps the workflows drawer close button on the title row in the compact layout', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    resizeWorkspace(428);

    const trigger = screen.getByRole('button', { name: 'deployment.editor.workflows' });
    fireEvent.click(trigger);
    expect(screen.getByRole('heading', { name: 'deployment.editor.workflows' })).toBeInTheDocument();

    // The drawer header keeps the shared 48px pane-header height with room
    // reserved for the close button, which stays on the title row instead of
    // hanging below the divider into the search row.
    const workflowsDrawer = document.querySelector('[data-slot="drawer-content"]');
    expect(workflowsDrawer?.querySelector('[data-slot="drawer-header"]'))
      .toHaveClass('min-h-12', 'justify-center', 'px-3', 'py-3', 'pr-12');
    expect(workflowsDrawer?.querySelector('[data-slot="drawer-close"]'))
      .toHaveClass('top-2', 'right-3', 'size-8');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    return waitFor(() => expect(trigger).toHaveFocus());
  });

  it('builds a card-free three-pane pipeline workspace with accessible resize handles and header status chips', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const workspace = screen.getByTestId('deployment-design-workspace');
    expect(workspace.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(workspace).toHaveAttribute('data-layout', 'wide');
    expect(screen.getByTestId('deployment-workspace-wide')).toBeInTheDocument();
    const panelGroup = workspace.querySelector('[data-slot="resizable-panel-group"]')!;
    expect(panelGroup.querySelectorAll('[data-panel]')).toHaveLength(3);
    expect(panelGroup.querySelectorAll('[data-slot="resizable-handle"]')).toHaveLength(2);
    expect(within(panelGroup as HTMLElement).getByRole('separator', { name: 'deployment.editor.resize.workflows' })).toBeInTheDocument();
    expect(within(panelGroup as HTMLElement).getByRole('separator', { name: 'deployment.editor.resize.inspector' })).toBeInTheDocument();
    const editorToolbar = screen.getByTestId('deployment-editor-toolbar');
    const statusChip = within(editorToolbar).getByTestId('deployment-validation-status');
    expect(statusChip).toHaveRole('button');
    expect(statusChip).toHaveTextContent('deployment.editor.status.validated');
    expect(screen.queryByLabelText('deployment.editor.status.label')).not.toBeInTheDocument();

    const toolbar = screen.getByTestId('deployment-workflow-toolbar');
    expect(toolbar).toHaveClass('flex-nowrap', 'min-h-10', 'gap-3');
    // The tab strip starts flush with the toolbar's left edge; only the action
    // rail keeps the right padding.
    expect(toolbar).toHaveClass('pr-3');
    expect(toolbar).not.toHaveClass('px-3');
    const tabsList = toolbar.querySelector('[data-slot="tabs-list"]')!;
    expect(tabsList).toHaveClass('h-full!', 'p-0');
    const activeTab = within(toolbar).getByRole('tab', { name: 'deployment.editor.tab.pipeline' });
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
    // The active underline rides flush on the toolbar divider.
    expect(activeTab).toHaveClass('h-full!', 'px-2.5', 'after:-bottom-px!');
    const workflowsButton = toolbar.querySelector('[data-testid="deployment-workflow-actions"] button')!;
    expect(workflowsButton).toHaveClass('size-8');
  });

  it('reflects validation issues and unsaved changes in the editor header chips and opens the issues dialog', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const editorToolbar = screen.getByTestId('deployment-editor-toolbar');
    const chip = within(editorToolbar).getByTestId('deployment-validation-status');
    expect(chip).toHaveTextContent('deployment.editor.status.validated');
    expect(within(editorToolbar).queryByText('deployment.editor.status.unsaved')).not.toBeInTheDocument();

    const issue: DeploymentEditorIssue = {
      id: 'issue-1',
      code: 'LOCAL_MISSING_INPUT',
      messageKey: 'deployment.editor.validation.localMissingInput',
      nodeId: 'build',
      source: 'local',
    };
    act(() => {
      useDeploymentWorkflowStore.setState({ issues: [issue], semanticDirty: true });
    });
    expect(chip).toHaveTextContent('deployment.editor.issues:1');
    expect(within(editorToolbar).getByText('deployment.editor.status.unsaved')).toBeInTheDocument();

    fireEvent.click(chip);
    expect(screen.getByRole('heading', { name: 'deployment.editor.validation.title' })).toBeInTheDocument();
    expect(screen.getByTestId('deployment-validation-list')).toHaveTextContent(
      'deployment.editor.validation.localMissingInput',
    );
  });

  it('keeps every deployment center tab free of Card DOM', () => {
    for (const initialTab of ['pipeline', 'runs', 'versions'] as const) {
      const view = render(<DeploymentWorkflowCenter initialTab={initialTab} />);
      expect(view.container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('outlines the pipeline workspace like the runtime tabs without doubling adjacent dividers', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const workspace = screen.getByTestId('deployment-design-workspace');
    expect(workspace).toHaveClass('flex-1', 'border-b');
    expect(workspace).not.toHaveClass('border-r');
    expect(workspace).not.toHaveClass('border-t');
    expect(workspace).not.toHaveClass('border-l');
    expect(screen.getByTestId('deployment-workflow-toolbar')).toHaveClass('border-b');
  });

  it('centers the page-level empty state when no workflow exists yet', () => {
    useDeploymentWorkflowStore.setState({
      workflows: [],
      selectedWorkflowId: null,
      selectedNodeId: null,
      draft: null,
    });
    render(<DeploymentWorkflowCenter />);
    const panel = document.querySelector('[data-slot="panel-empty-state"]');
    expect(panel).toHaveClass('flex-1', 'items-center', 'justify-center');
    expect(within(panel as HTMLElement).getByText('deployment.editor.empty')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByRole('button', { name: 'deployment.editor.newWorkflow' }))
      .toBeInTheDocument();
  });

  it('centers the unsaved-draft notice inside its outlined panel', async () => {
    render(<DeploymentWorkflowCenter initialTab="runs" />);
    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate(
        'blank',
        'Second workflow',
        profile.id,
        '/srv/second',
      );
    });
    await waitFor(() => expect(
      screen.getByRole('tab', { name: 'deployment.editor.tab.pipeline' }),
    ).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('tab', { name: 'deployment.editor.tab.runs' }));

    const notice = screen.getByTestId('deployment-unsaved-notice');
    expect(notice).toHaveClass('flex-1', 'items-center', 'justify-center', 'border-b');
    expect(notice).not.toHaveClass('border-r');
    expect(within(notice).getByText('deployment.editor.placeholder.unsavedTitle')).toBeInTheDocument();
  });

  it('switches to the deployments tab, prepares, and auto-opens approval when deploying', async () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
    const enabledWorkflow: DeploymentWorkflowRecord = { ...workflow, enabled: true };
    const awaitingSummary = {
      runId: 'run-1', workflowId: enabledWorkflow.id, workflowRevision: enabledWorkflow.revision,
      operationKind: 'deploy' as const, triggerKind: 'manual' as const, status: 'awaiting_approval' as const,
      planDigest: digest('b'),
      targetRelease: { releaseId: 'release-next', artifactContentDigest: digest('c'), layoutDigest: digest('d') },
      artifactReferences: [], expiresAt: Date.now() + 60_000, expired: false, planDrifted: false,
      createdAt: 1, updatedAt: 1, startedAt: null, finishedAt: null,
    };
    const prepare = vi.fn().mockImplementation(async () => {
      useDeploymentWorkflowRunStore.setState({
        workflowId: enabledWorkflow.id,
        runs: [awaitingSummary],
        selectedRunId: 'run-1',
        detail: {
          summary: awaitingSummary,
          approvalSummary: {
            schemaVersion: 1, workflowId: enabledWorkflow.id, workflowRevision: enabledWorkflow.revision,
            definitionDigest: enabledWorkflow.definitionDigest, runId: 'run-1',
            operationKind: 'deploy', triggerKind: 'manual', parameters: {}, planDigest: digest('b'),
            preparedAt: 1, expiresAt: awaitingSummary.expiresAt,
            source: { sourceRef: 'workspace', revision: 'abc123', dirty: false, snapshotDigest: digest('1'), metadataDigest: digest('2') },
            target: { targetId: 'production', connectionProfileId: profile.id, profileRevision: 1, hostIdentityDigest: digest('3'), remoteRoot: '/srv/site', capabilitiesDigest: digest('4') },
            preflight: {},
            artifacts: [],
            targetRelease: awaitingSummary.targetRelease,
            effects: [],
            risks: { highestLevel: 'low', entries: [] },
            compensations: [],
            verificationNodes: [],
            retention: 3,
          },
          outputs: [],
          receipts: [],
        },
        nodes: [],
      });
    });
    useDeploymentWorkflowStore.setState({
      workflows: [enabledWorkflow],
      draft: {
        id: enabledWorkflow.id, name: enabledWorkflow.name, enabled: true,
        revision: enabledWorkflow.revision, layoutRevision: enabledWorkflow.layoutRevision,
        definition: structuredClone(enabledWorkflow.definition),
        layout: structuredClone(enabledWorkflow.layout!),
      },
    });
    useDeploymentWorkflowRunStore.setState({ prepare });

    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByTestId('deployment-deploy-action'));

    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tab', { name: 'deployment.editor.tab.runs' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'deployment.runtime.approval.what' })).toBeInTheDocument();
  });

  it('disables deploy with an explanatory hint for unsaved changes and disabled workflows', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const deploy = screen.getByTestId('deployment-deploy-action');
    expect(deploy).toBeDisabled();
    expect(deploy).not.toHaveAttribute('title');
    expect(deploy).toHaveAttribute('aria-description', 'deployment.runtime.deploy.workflowDisabled');

    act(() => {
      useDeploymentWorkflowStore.getState().updateWorkflowMeta({ enabled: true });
    });
    expect(deploy).toBeDisabled();
    expect(deploy).not.toHaveAttribute('title');
    expect(deploy).toHaveAttribute('aria-description', 'deployment.runtime.deploy.unsaved');
  });

  it('exposes searchable grouped drawers with a fixed title, scrolling body, and focus return', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    resizeWorkspace(858);

    const trigger = screen.getByRole('button', { name: 'deployment.editor.nodeLibrary' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('heading', { name: 'deployment.editor.nodeLibrary' })).toBeInTheDocument();
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    expect(drawer).toHaveClass('min-h-0', 'overflow-hidden');
    expect(drawer?.querySelector('[data-slot="drawer-header"]')).toHaveClass('shrink-0');
    expect(drawer?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    // The search row must keep breathing room below the header divider instead
    // of sitting flush against the drawer's top edge.
    const searchRow = drawer?.querySelector('[data-testid="deployment-node-library"] > div');
    expect(searchRow).toHaveClass('shrink-0', 'px-3', 'pt-2', 'pb-2');
    expect(screen.getByRole('heading', { name: 'deployment.editor.category.source' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.editor.category.build' })).toBeInTheDocument();

    const search = screen.getByRole('textbox', { name: 'deployment.editor.searchNodes' });
    fireEvent.change(search, { target: { value: 'not-present' } });
    expect(screen.getByText('deployment.editor.noNodeSearchResults')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('adds a pipeline step from the step list footer', () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.stepList.addStep' }));
    expect(screen.getByRole('heading', { name: 'deployment.editor.nodeLibrary' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.addNodeNamed:deployment.node.source_snapshot.name' }));
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes).toHaveLength(3);
    expect(useDeploymentWorkflowStore.getState().semanticDirty).toBe(true);
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

  it('surfaces non-preparation runtime errors once and clears the store error', async () => {
    render(
      <React.StrictMode>
        <DeploymentWorkflowCenter />
      </React.StrictMode>,
    );
    act(() => {
      useDeploymentWorkflowRunStore.setState({
        error: 'cancel failed',
        errorContext: 'operation',
      });
    });

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: 'deployment.runtime.error.generic',
      variant: 'error',
    });
    expect(useDeploymentWorkflowRunStore.getState()).toMatchObject({
      error: null,
      errorContext: null,
    });
  });

  it('keeps a new unsaved workflow selected when saved workflows already exist', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    const search = screen.getByRole('textbox', { name: 'deployment.editor.search' });
    fireEvent.change(search, { target: { value: 'stale-filter' } });
    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate(
        'blank',
        'Second workflow',
        profile.id,
        '/srv/second',
      );
    });

    await waitFor(() => expect(useDeploymentWorkflowStore.getState().draft).toMatchObject({
      id: null,
      name: 'Second workflow',
    }));
    expect(useDeploymentWorkflowStore.getState().selectedWorkflowId).toBeNull();
    await waitFor(() => expect(search).toHaveValue(''));
    const workflowList = screen.getByTestId('deployment-workflow-list');
    expect(within(workflowList).getByText('Second workflow')).toBeInTheDocument();
    expect(within(workflowList).getByText('deployment.editor.unsaved')).toBeInTheDocument();
    expect(within(workflowList).getByText('deployment.editor.workflowCount:2')).toBeInTheDocument();
  });

  it('points an unsaved draft at the pipeline tab and shows a save hint on runtime tabs', async () => {
    render(<DeploymentWorkflowCenter initialTab="versions" />);
    act(() => {
      useDeploymentWorkflowStore.getState().startTemplate(
        'blank',
        'Second workflow',
        profile.id,
        '/srv/second',
      );
    });
    await waitFor(() => expect(
      screen.getByRole('tab', { name: 'deployment.editor.tab.pipeline' }),
    ).toHaveAttribute('aria-selected', 'true'));
  });

  it('keeps the template dialog compact with icon-free footer actions', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.newWorkflow' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass('max-h-[calc(100vh-2rem)]');
    expect(dialog.className).not.toMatch(/(^|\s)h-\[/);
    const scrollArea = dialog.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea).toHaveClass('min-h-0');
    // A max-height-capped dialog leaves percentage heights indefinite in WebKit,
    // so the body must sit in a definite grid row instead of a plain flex child.
    expect(scrollArea?.parentElement).toHaveClass('grid', 'min-h-0', 'flex-1', 'grid-rows-[minmax(0,1fr)_auto]');
    expect(within(dialog).getByText('deployment.editor.template.title').closest('[data-slot="dialog-header"]')).toHaveClass('shrink-0');
    const cancel = within(dialog).getByRole('button', { name: 'common.cancel' });
    const submit = within(dialog).getByRole('button', { name: 'deployment.editor.template.use' });
    expect(cancel.querySelector('svg')).toBeNull();
    expect(submit.querySelector('svg')).toBeNull();
    expect(within(dialog).getByLabelText('deployment.editor.workflowName')).toHaveClass('h-8');
    expect(within(dialog).getByLabelText('deployment.editor.template.kind')).toHaveAttribute('data-size', 'sm');
  });

  it('defaults a template to the active profile filter and keeps that filter after creation', async () => {
    useProfileStore.setState({ profiles: [profile, filteredProfile] });
    useDeploymentWorkflowStore.setState({ profileFilterId: filteredProfile.id });
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.newWorkflow' }));

    const dialog = await screen.findByRole('dialog');
    const target = within(dialog).getByLabelText('deployment.editor.targetProfile');
    expect(target).toHaveTextContent('release@staging.example.test');
    expect(target).not.toHaveTextContent('Staging ·');
    fireEvent.change(within(dialog).getByLabelText('deployment.editor.workflowName'), {
      target: { value: 'Staging workflow' },
    });
    fireEvent.click(within(dialog).getByRole('button', {
      name: 'deployment.editor.template.use',
    }));

    await waitFor(() => expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      profileFilterId: filteredProfile.id,
      draft: {
        name: 'Staging workflow',
        definition: {
          targets: [{ connectionProfileId: filteredProfile.id }],
        },
      },
    }));
  });

  it('allows an editable workflow to be enabled from workflow settings', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.settings' }));
    const enabled = await screen.findByRole('switch', { name: 'deployment.editor.enabled' });
    expect(enabled).not.toBeChecked();
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.settingsApply' }));

    await waitFor(() => expect(useDeploymentWorkflowStore.getState().draft?.enabled).toBe(true));
    expect(useDeploymentWorkflowStore.getState().semanticDirty).toBe(true);
  });

  it('disables every mutation entry point when admissions are read-only', () => {
    useDeploymentWorkflowStore.setState({
      capabilities: {
        schemaVersion: 1, admissionsEnabled: false, defaultEnabled: true,
        flagName: 'SHELLSPAN_DEPLOYMENT_WORKFLOW', source: 'environment',
        readOnlyAvailable: true, cancelRecoveryAuditAvailable: true, coordinatorAvailable: true,
      },
    });
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);

    expect(screen.getByRole('button', { name: 'deployment.editor.nodeLibrary' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.editor.settings' })).toBeDisabled();
    expect(screen.getByLabelText('deployment.editor.nodeName')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.editor.removeNode' })).toBeDisabled();
    expect(screen.getByTestId('deployment-deploy-action')).toBeDisabled();
  });

  it('opens the issues dialog when a save is rejected by validation', async () => {
    render(<DeploymentWorkflowCenter initialTab="runs" />);
    act(() => {
      useDeploymentWorkflowStore.setState({
        error: 'DEPLOYMENT_WORKFLOW_VALIDATION_FAILED',
        issues: [{
          id: 'issue-1',
          code: 'MISSING_APPROVAL',
          messageKey: 'deployment.editor.validation.missingApproval',
          source: 'native',
        }],
      });
    });
    await waitFor(() => expect(
      screen.getByRole('heading', { name: 'deployment.editor.validation.title' }),
    ).toBeInTheDocument());
    expect(screen.getByTestId('deployment-validation-list'))
      .toHaveTextContent('deployment.editor.validation.missingApproval');
  });

  it('opens the issues dialog with the ready state when validation passes', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    // With no recorded issues the dialog must still open and render its ready state.
    fireEvent.click(within(screen.getByTestId('deployment-editor-toolbar'))
      .getByTestId('deployment-validation-status'));
    await waitFor(() => expect(
      screen.getByRole('heading', { name: 'deployment.editor.validation.title' }),
    ).toBeInTheDocument());
    expect(screen.getByText('deployment.editor.validation.ready')).toBeInTheDocument();
  });

  it('always opens the issues dialog after running validation from the toolbar', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.validate' }));
    await waitFor(() => expect(
      screen.getByRole('heading', { name: 'deployment.editor.validation.title' }),
    ).toBeInTheDocument());
    expect(screen.getByTestId('deployment-validation-list')).toBeInTheDocument();
  });

  it('nudges to save first when a deploy request arrives with unsaved changes', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    act(() => {
      useDeploymentWorkflowStore.getState().updateWorkflowMeta({ name: 'Renamed' });
      useDeploymentWorkflowStore.getState().requestDeploy();
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: 'deployment.center.deploy.unsavedChanges',
      variant: 'info',
    });
    expect(useDeploymentWorkflowStore.getState().deployRequested).toBe(false);
  });

  it('flags an invalid remote root in the template dialog', async () => {
    render(<DeploymentWorkflowCenter initialTab="pipeline" />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.editor.newWorkflow' }));

    const dialog = await screen.findByRole('dialog');
    const rootInput = within(dialog).getByLabelText('deployment.editor.remoteRoot');
    const submit = within(dialog).getByRole('button', { name: 'deployment.editor.template.use' });
    fireEvent.change(rootInput, { target: { value: 'srv/apps' } });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText('deployment.editor.template.remoteRootInvalid')).toBeInTheDocument();
    expect(rootInput).toHaveAttribute('aria-invalid', 'true');
  });
});
