import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    detail: { summary, approvalSummary: approvalSummary(), outputs: [], receipts: [] },
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
  it('blocks prepare and approval admissions in read-only mode while keeping cancellation available', () => {
    render(
      <DeploymentWorkflowRuntimeView
        kind="prepare"
        workflow={workflow}
        admissionsEnabled={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'deployment.runtime.prepare.action' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.runtime.reviewApproval' })).toBeDisabled();

    const approved = runSummary({ status: 'approved' });
    useDeploymentWorkflowRunStore.setState({
      runs: [approved],
      detail: {
        summary: approved,
        approvalSummary: approvalSummary(),
        outputs: [],
        receipts: [],
      },
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
    render(<DeploymentWorkflowRuntimeView kind="prepare" workflow={workflow} />);
    expect(screen.getByTestId('deployment-prepare-view').querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'deployment.runtime.reviewApproval' });
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'deployment.runtime.approveAndRun' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('disables approval after expiry and requires a new preparation', () => {
    const expired = runSummary({ expired: true, expiresAt: 1 });
    useDeploymentWorkflowRunStore.setState({ detail: { summary: expired, approvalSummary: approvalSummary(), outputs: [], receipts: [] } });
    render(<DeploymentWorkflowRuntimeView kind="prepare" workflow={workflow} />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.reviewApproval' }));
    expect(screen.getAllByText('deployment.runtime.approval.invalidTitle')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'deployment.runtime.approveAndRun' })).toBeDisabled();
  });

  it('keeps semantic drift as a preparation gate and approval wired to the run coordinator', async () => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    const approveAndStart = vi.fn().mockResolvedValue(undefined);
    useDeploymentWorkflowRunStore.setState({ prepare, approveAndStart });
    const view = render(
      <DeploymentWorkflowRuntimeView kind="prepare" workflow={workflow} semanticDirty />,
    );

    expect(screen.getByRole('button', { name: 'deployment.runtime.prepare.action' })).toBeDisabled();
    expect(screen.getByText('deployment.runtime.drift.unsavedTitle')).toBeInTheDocument();
    view.unmount();

    render(<DeploymentWorkflowRuntimeView kind="prepare" workflow={workflow} />);
    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.reviewApproval' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deployment.runtime.approveAndRun' }));
    await waitFor(() => expect(approveAndStart).toHaveBeenCalledTimes(1));
    expect(prepare).not.toHaveBeenCalled();
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

  it('projects workflow bindings and native node state into a strictly read-only runtime DAG', () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);

    const flow = screen.getByTestId('deployment-runtime-flow');
    expect(flow).toHaveAttribute('data-read-only', 'true');
    expect(flow.querySelectorAll('[data-node-id]')).toHaveLength(2);
    expect(flow.querySelector('[data-node-id="source"]')).toMatchObject({
      dataset: { nodeStatus: 'succeeded', nodeAttempt: '1' },
    });
    expect(flow.querySelector('[data-node-id="approval"]')).toMatchObject({
      dataset: { nodeStatus: 'awaiting_approval', nodeAttempt: '0' },
    });
    expect(flow.querySelectorAll('[data-edge-id]')).toHaveLength(1);
    expect(flow.querySelector('[data-edge-id]')).toMatchObject({
      dataset: {
        sourceNodeId: 'source',
        sourcePort: 'source',
        targetNodeId: 'approval',
        targetPort: 'source',
      },
    });
    const anchors = [...flow.querySelectorAll<HTMLElement>('[data-runtime-anchor]')];
    expect(anchors).toHaveLength(4);
    expect(anchors.every((anchor) => (
      anchor.getAttribute('aria-hidden') === 'true'
      && anchor.tabIndex === -1
      && anchor.classList.contains('pointer-events-none')
      && anchor.classList.contains('opacity-0')
    ))).toBe(true);
    expect(flow).toHaveTextContent('deployment.runtime.status.succeeded');
    expect(flow).toHaveTextContent('deployment.runtime.status.awaiting_approval');
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
    expect(runsDrawer?.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(runsTrigger).toHaveFocus());

    const inspectorTrigger = screen.getByRole('button', { name: 'deployment.runtime.node.details' });
    inspectorTrigger.focus();
    fireEvent.click(inspectorTrigger);
    expect(await screen.findByTestId('deployment-runtime-inspector')).toBeInTheDocument();
    const inspectorDrawer = document.querySelector('[data-slot="drawer-content"]');
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
    expect(screen.getByTestId('deployment-runtime-flow')).toHaveAttribute('data-read-only', 'true');
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

    const trigger = screen.getByTestId('deployment-open-rollback');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByTestId('deployment-rollback-dialog');
    expect(dialog).toHaveClass('overflow-hidden');
    expect(dialog.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(screen.getByLabelText('deployment.runtime.rollback.release')).toHaveTextContent('release-previous');
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass('shrink-0');

    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    await screen.findByTestId('deployment-rollback-dialog');

    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.rollback.prepare' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(workflow, 'release-previous'));
  });
});
