import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeploymentWorkflowRuntimeOverlays,
  DeploymentWorkflowRuntimeView,
} from '../deployment-workflow-runtime';
import type {
  DeploymentApprovalSummary,
  DeploymentArtifactInspection,
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
      { id: 'approval', type: 'control.approval', typeVersion: 1, displayName: 'Human approval', inputs: {}, config: { targetId: 'production' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
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

beforeEach(() => {
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
    nodes: [node],
    selectedNodeId: node.nodeId,
    events: [{ runId: summary.runId, sequence: 2, nodeId: node.nodeId, attempt: 1, eventKind: 'node_succeeded', status: 'succeeded', summaryKey: 'deployment.node.succeeded', payload: null, recordedAt: 20 }],
    attempts: [{ schemaVersion: 1, runId: summary.runId, nodeId: node.nodeId, attempt: 1, nodeType: node.nodeType, nodeTypeVersion: 1, executorVersion: 'native/v1', idempotencyKey: 'attempt-1', status: 'succeeded', startedAt: 10, finishedAt: 20, createdAt: 10, updatedAt: 20 }],
  });
});

describe('DeploymentWorkflowRuntimeView', () => {
  it('groups approval by user meaning and keeps long content inside a fixed dialog chain', async () => {
    render(<DeploymentWorkflowRuntimeView kind="prepare" workflow={workflow} />);
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

  it('shows node attempts, bounded logs, and opens audit evidence with fixed scrolling', async () => {
    render(<DeploymentWorkflowRuntimeView kind="runs" workflow={workflow} />);
    expect(screen.getByLabelText('deployment.runtime.attempt.select')).toHaveTextContent('deployment.runtime.attemptNumber:1');
    expect(screen.getByText('#2 · deployment.node.succeeded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'deployment.runtime.evidence.action' }));
    expect(await screen.findByRole('heading', { name: 'deployment.runtime.evidence.title' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveClass('overflow-hidden');
    fireEvent.click(screen.getByRole('button', { name: 'deployment.history.exportAudit' }));
    await waitFor(() => expect(exportAudit).toHaveBeenCalledWith('run-1'));
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
    useDeploymentWorkflowRunStore.setState({ artifact });
    render(<DeploymentWorkflowRuntimeOverlays />);
    expect(screen.getByRole('heading', { name: 'deployment.runtime.artifact.title' })).toBeInTheDocument();
    expect(screen.getByText('deployment.runtime.artifact.reference.release_current')).toBeInTheDocument();
    expect(screen.getByTestId('deployment-artifact-drawer')).toHaveClass('min-h-0');
    expect(document.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
  });
});
