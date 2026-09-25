import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentWorkflowRuntimeOverlays,
  DeploymentWorkflowRuntimeView,
} from '../deployment-workflow-runtime';
import type {
  DeploymentApprovalSummary,
  DeploymentArtifactInspection,
  DeploymentReleaseRecord,
  DeploymentRunDetail,
  DeploymentRunNodeRecord,
  DeploymentRunSummary,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { useProfileStore } from '@/stores/profileStore';

const exportAudit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeExportDeploymentRunAudit: exportAudit,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (values?.node) return `${key}:${values.node}`;
      if (values?.count != null) return `${key}:${values.count}`;
      if (values?.attempt != null) return `${key}:${values.attempt}`;
      if (values?.release) return `${key}:${values.release}`;
      return key;
    },
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const artifactReference = `deployment-artifact:${digest('a')}` as const;

const workflow: DeploymentWorkflowRecord = {
  id: 'workflow-1', name: 'Website', enabled: true, archived: false,
  revision: 4, definitionDigest: digest('f'), layoutRevision: 1,
  definition: {
    schemaVersion: 3,
    targets: [{ id: 'production', connectionProfileId: 'profile-1', remoteRoot: '/srv/site' }],
    parameters: [],
    nodes: [
      { id: 'source', type: 'source.snapshot', typeVersion: 1, displayName: 'Freeze source', inputs: {}, config: { sourceRef: 'workspace' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
      { id: 'approval', type: 'control.approval', typeVersion: 1, displayName: 'Human approval', inputs: { source: { fromNodeId: 'source', fromPort: 'source' } }, config: { targetId: 'production' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
      { id: 'verify', type: 'verify.http', typeVersion: 2, displayName: 'HTTP verification', inputs: {}, config: { targetId: 'production' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
    ],
    outputs: {},
    policy: { failFast: true, maxParallelLocalNodes: 2, releasesToKeep: 3, automaticRestore: true },
  },
  createdAt: 1,
  updatedAt: 2,
};

function runSummary(changes: Partial<DeploymentRunSummary> = {}): DeploymentRunSummary {
  return {
    runId: 'run-1', workflowId: workflow.id, workflowRevision: workflow.revision,
    operationKind: 'deploy', triggerKind: 'manual', status: 'awaiting_approval',
    planDigest: digest('b'),
    targetRelease: { releaseId: 'release-next', artifactContentDigest: digest('c'), layoutDigest: digest('d') },
    artifactReferences: [artifactReference], expiresAt: Date.now() + 60_000,
    expired: false, planDrifted: false, createdAt: 10, updatedAt: 11,
    startedAt: null, finishedAt: null, ...changes,
  };
}

function approvalSummary(): DeploymentApprovalSummary {
  return {
    schemaVersion: 1, workflowId: workflow.id, workflowRevision: workflow.revision,
    definitionDigest: workflow.definitionDigest, runId: 'run-1', operationKind: 'deploy',
    triggerKind: 'manual', parameters: {}, planDigest: digest('b'), preparedAt: 10,
    expiresAt: Date.now() + 60_000,
    source: { sourceRef: 'workspace', revision: 'abc123', dirty: false, snapshotDigest: digest('1'), metadataDigest: digest('2') },
    target: { targetId: 'production', connectionProfileId: 'profile-1', profileRevision: 1, hostIdentityDigest: digest('3'), remoteRoot: '/srv/site', capabilitiesDigest: digest('4') },
    preflight: {},
    artifacts: [{
      handle: { artifactReference, manifestDigest: digest('a'), contentDigest: digest('c') },
      artifactType: 'application/vnd.shellspan.file-tree',
      components: [{ name: 'site.tar.zst', role: 'application', mediaType: 'application/vnd.shellspan.file-tree.tar+zstd', digest: digest('5'), size: 100, annotations: {} }],
      componentCount: 1,
      totalSize: 100,
    }],
    currentRelease: { releaseId: 'release-old', artifactContentDigest: digest('6'), layoutDigest: digest('7') },
    previousRelease: { releaseId: 'release-old', artifactContentDigest: digest('6'), layoutDigest: digest('7') },
    targetRelease: { releaseId: 'release-next', artifactContentDigest: digest('c'), layoutDigest: digest('d') },
    effects: [{ nodeId: 'switch', displayName: 'Switch current release', effectClass: 'trafficSwitch', fixedActions: ['atomic_switch'] }],
    risks: { highestLevel: 'high', entries: [] },
    compensations: [{ nodeId: 'switch', compensationKind: 'restore_previous', fixedActions: ['restore_current'] }],
    verificationNodes: ['verify'],
    retention: 3,
  };
}

function runDetail(summary: DeploymentRunSummary): DeploymentRunDetail {
  return { summary, approvalSummary: approvalSummary(), outputs: [], receipts: [] };
}

const node: DeploymentRunNodeRecord = {
  runId: 'run-1', nodeId: 'source', nodeType: 'source.snapshot', nodeTypeVersion: 1,
  status: 'succeeded', lastAttempt: 1, outputSummary: { files: 4 }, startedAt: 10, finishedAt: 20, updatedAt: 20,
};

const approvalNode: DeploymentRunNodeRecord = {
  runId: 'run-1', nodeId: 'approval', nodeType: 'control.approval', nodeTypeVersion: 1,
  status: 'awaiting_approval', lastAttempt: 0, updatedAt: 20,
};

let runtimeWorkspaceResize: ((width: number) => void) | null = null;

class RuntimeResizeObserverMock implements ResizeObserver {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  disconnect(): void {}
  observe(target: Element): void {
    if (target.getAttribute('data-testid') === 'deployment-runtime-workspace') {
      runtimeWorkspaceResize = (width) => this.callback([{
        target,
        contentRect: {
          width, height: 640, x: 0, y: 0, top: 0,
          right: width, bottom: 640, left: 0, toJSON: () => ({}),
        },
      } as ResizeObserverEntry], this);
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

function resizeRuntimeWorkspace(width: number): void {
  if (!runtimeWorkspaceResize) throw new Error('Runtime workspace observer was not registered');
  act(() => runtimeWorkspaceResize?.(width));
}

beforeEach(() => {
  runtimeWorkspaceResize = null;
  vi.stubGlobal('ResizeObserver', RuntimeResizeObserverMock);
  exportAudit.mockReset();
  exportAudit.mockResolvedValue({
    schemaVersion: 3,
    runId: 'run-1',
    saved: true,
    bytes: 1_024,
    documentSha256: 'a'.repeat(64),
  });
  useDeploymentWorkflowRunStore.getState().reset();
  useProfileStore.setState({
    profiles: [{ id: 'profile-1', name: 'Production', host: 'example.test', port: 22, username: 'deploy', authMethod: 'password', createdAt: 1, updatedAt: 1 }],
  });
  const summary = runSummary();
  useDeploymentWorkflowRunStore.setState({
    workflowId: workflow.id,
    runs: [summary],
    selectedRunId: summary.runId,
    detail: runDetail(summary),
    nodes: [node, approvalNode],
    selectedNodeId: node.nodeId,
    events: [{ runId: summary.runId, sequence: 2, nodeId: node.nodeId, attempt: 1, eventKind: 'node_succeeded', status: 'succeeded', summaryKey: 'deployment.node.succeeded', payload: null, recordedAt: 20 }],
    attempts: [{ schemaVersion: 1, runId: summary.runId, nodeId: node.nodeId, attempt: 1, nodeType: node.nodeType, nodeTypeVersion: 1, executorVersion: 'native/v1', idempotencyKey: 'attempt-1', status: 'succeeded', startedAt: 10, finishedAt: 20, createdAt: 10, updatedAt: 20 }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeploymentWorkflowRuntimeView', () => {
  it('aligns the runs panes under one shared pane header height', () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    const headers = document.querySelectorAll('[data-slot="deployment-pane-header"]');
    expect(headers).toHaveLength(3);
    for (const header of headers) {
      expect(header).toHaveClass('min-h-12', 'items-center', 'border-b', 'shrink-0');
    }
  });

  it('blocks approval admissions in read-only mode while keeping cancellation available', () => {
    const approved = runSummary({ status: 'approved' });
    useDeploymentWorkflowRunStore.setState({
      runs: [approved],
      detail: runDetail(approved),
    });
    render(
      <DeploymentWorkflowRuntimeView
        kind="runs"
        workflow={workflow}
        admissionsEnabled={false}
      />,
    );
    const approvalTriggers = screen.getAllByTestId('deployment-open-approval');
    expect(approvalTriggers[approvalTriggers.length - 1]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeEnabled();
  });

  it('groups approval by user meaning and keeps long content inside a fixed dialog chain', async () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    const trigger = screen.getAllByTestId('deployment-open-approval')[0]!;
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByRole('heading', { name: 'deployment.runtime.approval.what' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.runtime.approval.where' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.runtime.approval.effects' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.runtime.approval.verify' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'deployment.runtime.approval.failure' })).toBeInTheDocument();
    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toHaveClass('overflow-hidden');
    expect(content?.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(content?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(content?.querySelector('[data-slot="dialog-footer"]')).toHaveClass('shrink-0');
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.cancel' })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'deployment.runtime.approveAndRun' })).not.toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('disables approval after expiry and requires a new preparation', () => {
    const expired = runSummary({ expired: true, expiresAt: 1 });
    useDeploymentWorkflowRunStore.setState({ detail: runDetail(expired) });
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    fireEvent.click(screen.getAllByTestId('deployment-open-approval')[0]!);
    expect(screen.getAllByText('deployment.runtime.approval.invalidTitle')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'deployment.runtime.approveAndRun' })).toBeDisabled();
  });

  it('opens the approval dialog automatically once a deploy preparation lands on an awaiting run', async () => {
    const onApprovalHandled = vi.fn();
    const { rerender } = render(
      <DeploymentWorkflowRuntimeView
        kind="runs"
        workflow={workflow}
        approvalRequest={0}
        onApprovalHandled={onApprovalHandled}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'deployment.runtime.approval.what' })).not.toBeInTheDocument();

    rerender(
      <DeploymentWorkflowRuntimeView
        kind="runs"
        workflow={workflow}
        approvalRequest={1}
        onApprovalHandled={onApprovalHandled}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'deployment.runtime.approval.what' })).toBeInTheDocument();
    expect(onApprovalHandled).toHaveBeenCalledTimes(1);
  });

  it('shows preparation progress and preparation failures inline above the run steps', () => {
    useDeploymentWorkflowRunStore.setState({
      preparing: true,
      preparationNodes: [
        { nodeId: 'source', displayName: 'Freeze source', status: 'succeeded' },
        { nodeId: 'approval', displayName: 'Human approval', status: 'running' },
      ],
      preparationCompleted: 1,
      preparationTotal: 2,
    });
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    expect(screen.getByTestId('deployment-preparing-progress')).toBeInTheDocument();
    expect(screen.getByText('deployment.runtime.preparing.title')).toBeInTheDocument();
    expect(within(screen.getByTestId('deployment-preparing-progress')).getAllByText('Human approval').length).toBeGreaterThan(0);

    act(() => {
      useDeploymentWorkflowRunStore.setState({
        preparing: false,
        preparationNodes: [],
        preparationCompleted: 0,
        preparationTotal: 0,
        error: 'CAPABILITY_MISSING',
        errorContext: 'prepare',
      });
    });
    expect(screen.getByTestId('deployment-prepare-error')).toBeInTheDocument();
    expect(screen.getByText('deployment.runtime.capability.title')).toBeInTheDocument();
  });

  it('offers the deploy action from the empty deployment list state', () => {
    const onDeploy = vi.fn();
    useDeploymentWorkflowRunStore.setState({
      runs: [],
      nextRunCursor: null,
      selectedRunId: null,
      detail: null,
      nodes: [],
      events: [],
      attempts: [],
    });
    render(
      <DeploymentWorkflowRuntimeView
        kind="runs"
        workflow={workflow}
        onDeploy={onDeploy}
        canDeploy={false}
      />,
    );
    const cta = screen.getByTestId('deployment-run-empty-cta');
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent('deployment.runtime.deploy.action');
    expect(cta.closest('[data-slot="panel-empty-state"]')).toHaveClass(
      'flex-1',
      'items-center',
      'justify-center',
    );
  });

  it('centers the empty step list inside the steps panel', () => {
    const finished = runSummary({ status: 'succeeded', startedAt: 10, finishedAt: 20 });
    useDeploymentWorkflowRunStore.setState({
      runs: [finished],
      selectedRunId: finished.runId,
      detail: runDetail(finished),
      nodes: [],
    });
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    const steps = screen.getByTestId('deployment-runtime-step-list');
    expect(steps).toHaveClass('flex', 'size-full', 'items-center', 'justify-center');
    expect(within(steps).getByText('deployment.runtime.steps.empty')).toBeInTheDocument();
    expect(steps.querySelector('[data-run-node-id]')).not.toBeInTheDocument();
  });

  it('centers the empty release list inside the outlined versions workspace', () => {
    render(<DeploymentWorkflowRuntimeView kind="versions" workflow={workflow} />);

    const view = screen.getByTestId('deployment-versions-view');
    expect(view).toHaveClass('flex-1', 'border-b');
    expect(view).not.toHaveClass('border-r');
    expect(view).not.toHaveClass('border-t');
    const empty = within(view)
      .getByText('deployment.runtime.version.empty')
      .closest('[data-slot="empty-state"]');
    expect(empty).toHaveClass('flex-1', 'items-center', 'justify-center');
  });

  it('frames the runs workspace with the same outline as the versions workspace', () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    const workspace = screen.getByTestId('deployment-runtime-workspace');
    expect(workspace).toHaveClass('flex-1', 'border-b');
    expect(workspace).not.toHaveClass('border-r');
    expect(workspace).not.toHaveClass('border-t');
  });

  it('shows node attempts, bounded logs, and opens audit evidence with fixed scrolling', async () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    const runsView = screen.getByTestId('deployment-runs-view');
    expect(runsView.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(screen.getByLabelText('deployment.runtime.attempt.select')).toHaveTextContent('deployment.runtime.attemptNumber:1');
    expect(screen.getByTestId('deployment-selected-attempt')).toHaveTextContent('native/v1');
    expect(screen.getByText('#2 · deployment.node.succeeded')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'deployment.runtime.evidence.action' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('heading', { name: 'deployment.runtime.evidence.title' })).toBeInTheDocument();
    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).toHaveClass('overflow-hidden');
    expect(content?.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deployment.history.exportAudit' }));
    await waitFor(() => expect(exportAudit).toHaveBeenCalledWith('run-1'));
    fireEvent.click(screen.getAllByRole('button', { name: 'common.close' })[0]!);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('projects the run into an ordered, selectable step list', () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    const steps = screen.getByTestId('deployment-runtime-step-list');
    const rows = steps.querySelectorAll('[data-run-node-id]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-run-node-id', 'source');
    expect(rows[1]).toHaveAttribute('data-run-node-id', 'approval');
    expect(rows[0]).toHaveTextContent('deployment.runtime.status.succeeded');
    expect(rows[1]).toHaveTextContent('deployment.runtime.status.awaiting_approval');
  });

  it('moves run history and the inspector into fixed-title drawers with focus return', async () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    resizeRuntimeWorkspace(858);

    const runsTrigger = screen.getByRole('button', { name: 'deployment.runtime.runs.title' });
    runsTrigger.focus();
    fireEvent.click(runsTrigger);
    expect((await screen.findAllByRole('heading', { name: 'deployment.runtime.runs.title' })).length).toBeGreaterThan(0);
    const runsDrawer = document.querySelector('[data-slot="drawer-content"]');
    expect(runsDrawer).toHaveClass('min-h-0', 'overflow-hidden');
    expect(runsDrawer?.querySelectorAll('[data-slot="drawer-title"]')).toHaveLength(1);
    expect(runsDrawer?.querySelector('[data-slot="drawer-header"]')).toHaveClass('px-3', 'pr-12', 'shrink-0');
    expect(runsDrawer?.querySelector('[data-slot="drawer-close"]')).toHaveClass('top-2', 'right-3', 'size-8');
    expect(runsDrawer?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(runsTrigger).toHaveFocus());

    const inspectorTrigger = screen.getByRole('button', { name: 'deployment.runtime.node.details' });
    inspectorTrigger.focus();
    fireEvent.click(inspectorTrigger);
    expect(await screen.findByTestId('deployment-runtime-inspector')).toBeInTheDocument();
    const inspectorDrawer = document.querySelector('[data-slot="drawer-content"]');
    expect(inspectorDrawer?.querySelectorAll('[data-slot="drawer-title"]')).toHaveLength(1);
    expect(inspectorDrawer?.querySelector('[data-slot="drawer-header"]')).toHaveClass('px-3', 'pr-12', 'shrink-0');
    expect(inspectorDrawer?.querySelector('[data-slot="drawer-close"]')).toHaveClass('top-2', 'right-3', 'size-8');
    expect(inspectorDrawer?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(inspectorTrigger).toHaveFocus());
  });

  it('keeps state_unknown recovery read-only and does not expose cancellation', () => {
    const unknown = runSummary({ status: 'state_unknown' });
    useDeploymentWorkflowRunStore.setState({
      detail: { summary: unknown, approvalSummary: null, outputs: [], receipts: [] },
      nodes: [{ ...node, status: 'state_unknown' }],
    });

    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    expect(screen.getByRole('button', { name: 'deployment.runtime.reconcile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.cancel' })).not.toBeInTheDocument();
    expect(screen.getByTestId('deployment-runtime-step-list')).toBeInTheDocument();
  });

  it('keeps active-run cancellation behind its confirmation dialog', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const active = runSummary({ status: 'in_progress' });
    useDeploymentWorkflowRunStore.setState({
      detail: { summary: active, approvalSummary: null, outputs: [], receipts: [] },
      cancel,
    });

    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(await screen.findByRole('heading', { name: 'deployment.runtime.cancel.title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.cancel.action' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('disables the cancel confirmation while the cancellation request is pending', async () => {
    const cancel = vi.fn(() => {
      useDeploymentWorkflowRunStore.setState({ action: 'cancel' });
      return new Promise<void>(() => {});
    });
    const active = runSummary({ status: 'in_progress' });
    useDeploymentWorkflowRunStore.setState({
      detail: { summary: active, approvalSummary: null, outputs: [], receipts: [] },
      cancel,
    });

    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    const confirm = await screen.findByRole('button', { name: 'deployment.runtime.cancel.action' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      screen.getByRole('button', { name: /deployment\.runtime\.cancel\.action/ }),
    ).toBeDisabled());
  });

  it('shows a destructive result alert with failed nodes and an evidence entry', () => {
    const failed = runSummary({ status: 'failed', startedAt: 10, finishedAt: 20 });
    useDeploymentWorkflowRunStore.setState({
      detail: { summary: failed, approvalSummary: null, outputs: [], receipts: [] },
      nodes: [{ ...node, status: 'failed' }],
      events: [{
        runId: failed.runId, sequence: 3, nodeId: 'source', attempt: 1,
        eventKind: 'node_failed', status: 'failed', summaryKey: 'deployment.node.failed',
        payload: null, recordedAt: 21,
      }],
    });

    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    const alert = screen.getByTestId('deployment-run-failed-alert');
    expect(within(alert).getByText('deployment.runtime.failed.title')).toBeInTheDocument();
    expect(within(alert).getByText('deployment.runtime.failed.nodes')).toBeInTheDocument();
    expect(within(alert).getByText('deployment.node.failed')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'deployment.runtime.evidence.action' })).toBeInTheDocument();
  });

  it('shows a result alert for canceled runs with access to the run evidence', () => {
    const canceled = runSummary({ status: 'canceled', startedAt: 10, finishedAt: 20 });
    useDeploymentWorkflowRunStore.setState({
      detail: { summary: canceled, approvalSummary: null, outputs: [], receipts: [] },
      nodes: [{ ...approvalNode, status: 'canceled' }],
    });

    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    const alert = screen.getByTestId('deployment-run-canceled-alert');
    expect(within(alert).getByText('deployment.runtime.canceled.title')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'deployment.runtime.evidence.action' })).toBeInTheDocument();
  });

  it('polls the selected run while it awaits approval', () => {
    vi.useFakeTimers();
    try {
      const refreshSelectedRun = vi.fn().mockResolvedValue(undefined);
      useDeploymentWorkflowRunStore.setState({ refreshSelectedRun });
      render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
      expect(refreshSelectedRun).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1_500); });
      expect(refreshSelectedRun).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(1_500); });
      expect(refreshSelectedRun).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the empty-state deploy action with preparation progress', () => {
    useDeploymentWorkflowRunStore.setState({
      runs: [],
      nextRunCursor: null,
      selectedRunId: null,
      detail: null,
      nodes: [],
      events: [],
      attempts: [],
      preparing: true,
    });
    render(
      <DeploymentWorkflowRuntimeView
        kind="runs"
        workflow={workflow}
        canDeploy
      />,
    );
    expect(screen.queryByTestId('deployment-run-empty-cta')).toBeNull();
    expect(screen.getByTestId('deployment-preparing-progress')).toBeVisible();
  });

  it('surfaces approval failures inside the dialog with the specific error', async () => {
    const approveAndStart = vi.fn().mockRejectedValue(new Error('PLAN_EXPIRED'));
    useDeploymentWorkflowRunStore.setState({ approveAndStart });
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    fireEvent.click(screen.getAllByTestId('deployment-open-approval')[0]!);
    const approve = await screen.findByRole('button', { name: 'deployment.runtime.approveAndRun' });
    fireEvent.click(approve);
    expect(await screen.findByTestId('deployment-approval-error')).toHaveTextContent('PLAN_EXPIRED');
    expect(screen.getByRole('button', { name: 'deployment.runtime.approveAndRun' })).toBeInTheDocument();
  });

  it('renders artifact identity, references, lease, and retention in a scrollable drawer', () => {
    const artifact: DeploymentArtifactInspection = {
      handle: { artifactReference, manifestDigest: digest('a'), contentDigest: digest('c') },
      manifest: {
        schemaVersion: 2, artifactType: 'application/vnd.shellspan.file-tree',
        source: { revision: 'abc123', dirty: false, snapshotDigest: digest('1') },
        components: [{ name: 'site.tar.zst', role: 'application', mediaType: 'application/vnd.shellspan.file-tree.tar+zstd', digest: digest('5'), size: 100, annotations: {} }],
        producer: { nodeType: 'build.package-script', nodeTypeVersion: 1, configDigest: digest('9') }, annotations: {},
      },
      componentCount: 1, totalSize: 100,
      retention: { referenceCount: 2, leaseCount: 1, currentRelease: true, previousRelease: false, protected: true },
      references: [{ workflowId: workflow.id, runId: 'run-1', nodeId: null, referenceKind: 'release_current', ownerId: 'release-next', leaseActive: true, retainUntil: null, createdAt: 10 }],
    };
    render(
      <>
        <button type="button" data-testid="artifact-trigger">artifact</button>
        <DeploymentWorkflowRuntimeOverlays />
      </>,
    );
    const trigger = screen.getByTestId('artifact-trigger');
    trigger.focus();
    act(() => useDeploymentWorkflowRunStore.setState({ artifact }));
    expect(screen.getByRole('heading', { name: 'deployment.runtime.artifact.title' })).toBeInTheDocument();
    expect(screen.getByText('deployment.runtime.artifact.reference.release_current')).toBeInTheDocument();
    expect(screen.getByTestId('deployment-artifact-drawer')).toHaveClass('min-h-0');
    expect(screen.getByTestId('deployment-artifact-drawer').querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.close' })[0]!);
    return waitFor(() => expect(trigger).toHaveFocus());
  });

  it('prepares rollback as a new run for a readable retained release', async () => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    const releases: DeploymentReleaseRecord[] = [
      {
        workflowId: workflow.id,
        releaseId: 'release-current',
        position: 'current',
        artifactReference,
        manifestDigest: digest('a'),
        contentDigest: digest('c'),
        artifactType: 'application/vnd.shellspan.file-tree',
        identity: { releaseId: 'release-current', artifactContentDigest: digest('c'), layoutDigest: digest('d') },
        sourceRunId: 'run-1',
        activatedAt: 20,
        rollbackable: false,
      },
      {
        workflowId: workflow.id,
        releaseId: 'release-previous',
        position: 'previous',
        artifactReference,
        manifestDigest: digest('a'),
        contentDigest: digest('6'),
        artifactType: 'application/vnd.shellspan.file-tree',
        identity: { releaseId: 'release-previous', artifactContentDigest: digest('6'), layoutDigest: digest('7') },
        sourceRunId: 'run-previous',
        activatedAt: 10,
        rollbackable: true,
      },
    ];
    useDeploymentWorkflowRunStore.setState({ releases, prepare });
    render(<DeploymentWorkflowRuntimeView kind="versions" workflow={workflow} />);

    expect(screen.getByTestId('deployment-versions-view').querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(screen.getByTestId('deployment-versions-view').querySelector('[data-slot="alert"]')).not.toBeInTheDocument();
    expect(screen.queryByText('deployment.runtime.rollback.confirmTitle')).not.toBeInTheDocument();

    const trigger = screen.getByTestId('deployment-open-rollback');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByTestId('deployment-rollback-dialog');
    expect(dialog).toHaveClass('overflow-hidden');
    expect(dialog.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(screen.getByLabelText('deployment.runtime.rollback.release')).toHaveTextContent('release-previous');
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass('shrink-0');
    expect(within(dialog).getByText('deployment.runtime.rollback.confirmTitle')).toBeInTheDocument();
    expect(within(dialog).getByText('deployment.runtime.rollback.confirmDescription')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    await screen.findByTestId('deployment-rollback-dialog');

    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.rollback.prepare' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(workflow, 'release-previous'));
  });
});
