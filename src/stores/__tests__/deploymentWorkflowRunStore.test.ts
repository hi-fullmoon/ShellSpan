import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeploymentNodeAttemptRecord,
  DeploymentNodeProgressEvent,
  DeploymentReleaseRecord,
  DeploymentRunEvent,
  DeploymentRunDetail,
  DeploymentRunEventPage,
  DeploymentRunNodeRecord,
  DeploymentRunPage,
  DeploymentRunSummary,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  cancel: vi.fn(),
  detail: vi.fn(),
  inspectArtifact: vi.fn(),
  attempts: vi.fn(),
  releases: vi.fn(),
  events: vi.fn(),
  nodes: vi.fn(),
  runs: vi.fn(),
  prepare: vi.fn(),
  reconcile: vi.fn(),
  start: vi.fn(),
  listenProgress: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeApproveDeploymentRun: mocks.approve,
  invokeCancelDeploymentRun: mocks.cancel,
  invokeGetDeploymentRunDetail: mocks.detail,
  invokeInspectDeploymentArtifact: mocks.inspectArtifact,
  invokeListDeploymentNodeAttempts: mocks.attempts,
  invokeListDeploymentReleases: mocks.releases,
  invokeListDeploymentRunEvents: mocks.events,
  invokeListDeploymentRunNodes: mocks.nodes,
  invokeListDeploymentRuns: mocks.runs,
  invokePrepareDeploymentRun: mocks.prepare,
  invokeReconcileDeploymentRun: mocks.reconcile,
  invokeStartDeploymentRun: mocks.start,
  listenToDeploymentNodeProgress: mocks.listenProgress,
}));

import { useDeploymentWorkflowRunStore } from '../deploymentWorkflowRunStore';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const artifactReference = `deployment-artifact:${digest('a')}` as const;

function summary(runId: string, status: DeploymentRunSummary['status'] = 'succeeded'): DeploymentRunSummary {
  return {
    runId,
    workflowId: 'workflow-1',
    workflowRevision: 4,
    operationKind: runId.includes('rollback') ? 'rollback' : 'deploy',
    triggerKind: 'manual',
    status,
    planDigest: digest(runId.includes('rollback') ? 'b' : 'c'),
    targetRelease: {
      releaseId: runId.includes('rollback') ? 'release-old' : 'release-new',
      artifactContentDigest: digest('d'),
      layoutDigest: digest('e'),
    },
    artifactReferences: [artifactReference],
    expiresAt: Date.now() + 60_000,
    expired: false,
    planDrifted: false,
    createdAt: 100,
    updatedAt: 200,
    startedAt: 120,
    finishedAt: status === 'succeeded' ? 180 : null,
  };
}

function detail(run: DeploymentRunSummary): DeploymentRunDetail {
  return { summary: run, approvalSummary: null, outputs: [], receipts: [] };
}

const node: DeploymentRunNodeRecord = {
  runId: 'run-1', nodeId: 'transfer', nodeType: 'transfer.sftp', nodeTypeVersion: 2,
  status: 'succeeded', lastAttempt: 3, updatedAt: 200,
};

const release: DeploymentReleaseRecord = {
  workflowId: 'workflow-1', releaseId: 'release-old', position: 'previous',
  artifactReference, manifestDigest: digest('a'), contentDigest: digest('d'),
  artifactType: 'application/vnd.shellspan.file-tree',
  identity: { releaseId: 'release-old', artifactContentDigest: digest('d'), layoutDigest: digest('e') },
  sourceRunId: 'run-0', activatedAt: 90, rollbackable: true,
};

const workflow: DeploymentWorkflowRecord = {
  id: 'workflow-1', name: 'Website', enabled: true, archived: false,
  revision: 4, definitionDigest: digest('f'), layoutRevision: 1,
  definition: {
    schemaVersion: 3,
    targets: [{ id: 'production', connectionProfileId: 'profile-1', remoteRoot: '/srv/site' }],
    parameters: [],
    nodes: [
      { id: 'source', type: 'source.snapshot', typeVersion: 1, displayName: 'Freeze source', inputs: {}, config: { sourceRef: 'workspace' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
      { id: 'approval', type: 'control.approval', typeVersion: 1, displayName: 'Approve', inputs: {}, config: { targetId: 'production' }, timeoutSeconds: 60, retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded' },
    ],
    outputs: {},
    policy: { failFast: true, maxParallelLocalNodes: 2, releasesToKeep: 3, automaticRestore: true },
  },
  createdAt: 1,
  updatedAt: 2,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDeploymentWorkflowRunStore.getState().reset();
  mocks.releases.mockResolvedValue([release]);
  mocks.nodes.mockResolvedValue([node]);
  mocks.events.mockResolvedValue({ items: [], nextBeforeSequence: null } satisfies DeploymentRunEventPage);
  mocks.attempts.mockResolvedValue({ items: [], nextBeforeAttempt: null });
  mocks.listenProgress.mockResolvedValue(vi.fn());
});

describe('deployment workflow run store', () => {
  it('paginates runs and attempts without replacing the selected projection', async () => {
    const run1 = summary('run-1');
    const run2 = summary('run-2');
    const firstPage: DeploymentRunPage = { items: [run1], nextCursor: '100:run-1' };
    const secondPage: DeploymentRunPage = { items: [run2], nextCursor: null };
    mocks.runs.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    mocks.detail.mockResolvedValue(detail(run1));
    const attempt3: DeploymentNodeAttemptRecord = {
      schemaVersion: 1, runId: 'run-1', nodeId: 'transfer', attempt: 3,
      nodeType: 'transfer.sftp', nodeTypeVersion: 2, executorVersion: 'native/v1',
      idempotencyKey: 'attempt-3', status: 'failed', createdAt: 1, updatedAt: 2,
    };
    const attempt2 = { ...attempt3, attempt: 2, idempotencyKey: 'attempt-2', status: 'succeeded' as const };
    mocks.attempts
      .mockResolvedValueOnce({ items: [attempt3], nextBeforeAttempt: 3 })
      .mockResolvedValueOnce({ items: [attempt2], nextBeforeAttempt: null });

    await useDeploymentWorkflowRunStore.getState().loadWorkflow('workflow-1');
    await useDeploymentWorkflowRunStore.getState().loadMoreRuns();
    await useDeploymentWorkflowRunStore.getState().loadMoreAttempts();

    const state = useDeploymentWorkflowRunStore.getState();
    expect(state.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(state.selectedRunId).toBe('run-1');
    expect(state.attempts.map((attempt) => attempt.attempt)).toEqual([3, 2]);
    expect(mocks.runs).toHaveBeenNthCalledWith(2, 'workflow-1', '100:run-1', 20);
    expect(mocks.attempts).toHaveBeenNthCalledWith(2, 'run-1', 'transfer', 3, 20);
  });

  it('prepares rollback as a distinct run and emits one new notification identity', async () => {
    const original = summary('run-original');
    const rollback = summary('run-rollback', 'awaiting_approval');
    mocks.prepare.mockResolvedValue({ runId: rollback.runId, planDigest: rollback.planDigest, expiresAt: rollback.expiresAt });
    mocks.runs.mockResolvedValue({ items: [rollback, original], nextCursor: null });
    mocks.detail.mockResolvedValue(detail(rollback));

    await useDeploymentWorkflowRunStore.getState().prepare(workflow, 'release-old');

    expect(mocks.prepare).toHaveBeenCalledWith({
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      operationKind: 'rollback',
      triggerKind: 'manual',
      parameters: {},
      rollbackReleaseId: 'release-old',
    });
    const state = useDeploymentWorkflowRunStore.getState();
    expect(state.selectedRunId).toBe('run-rollback');
    expect(state.detail?.summary.operationKind).toBe('rollback');
    expect(state.runs.find((run) => run.runId === 'run-original')?.status).toBe('succeeded');
    expect(state.notice?.kind).toBe('rollbackPrepared');
    expect(state.notice?.id).toBeGreaterThan(0);
  });

  it('clears the previous run projection while a different run is loading', async () => {
    const run1 = summary('run-1', 'in_progress');
    const run2 = summary('run-2', 'succeeded');
    const pendingDetail = deferred<DeploymentRunDetail>();
    useDeploymentWorkflowRunStore.setState({
      workflowId: workflow.id,
      runs: [run1, run2],
      selectedRunId: run1.runId,
      detail: detail(run1),
      nodes: [node],
      events: [{
        runId: run1.runId,
        sequence: 1,
        nodeId: node.nodeId,
        attempt: 1,
        eventKind: 'node.succeeded',
        status: 'succeeded',
        summaryKey: 'deployment.run.nodeSucceeded',
        payload: {},
        recordedAt: 1,
      }],
    });
    mocks.detail.mockReturnValueOnce(pendingDetail.promise);

    const loading = useDeploymentWorkflowRunStore.getState().selectRun(run2.runId);
    expect(useDeploymentWorkflowRunStore.getState()).toMatchObject({
      selectedRunId: run2.runId,
      loading: true,
      detail: null,
      nodes: [],
      events: [],
    });

    pendingDetail.resolve(detail(run2));
    await loading;
    expect(useDeploymentWorkflowRunStore.getState()).toMatchObject({
      selectedRunId: run2.runId,
      loading: false,
    });
    expect(useDeploymentWorkflowRunStore.getState().detail?.summary.runId).toBe(run2.runId);
  });

  it('retries starting an already approved run without approving it again', async () => {
    const approved = summary('run-approved', 'approved');
    const started = summary('run-approved', 'in_progress');
    useDeploymentWorkflowRunStore.setState({
      workflowId: workflow.id,
      selectedRunId: approved.runId,
      detail: detail(approved),
    });
    mocks.start.mockResolvedValue({
      runId: approved.runId,
      status: 'in_progress',
      planDigest: approved.planDigest,
    });
    mocks.detail.mockResolvedValue(detail(started));

    await useDeploymentWorkflowRunStore.getState().approveAndStart();

    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith({
      runId: approved.runId,
      planDigest: approved.planDigest,
    });
    expect(useDeploymentWorkflowRunStore.getState().notice?.kind).toBe('started');
  });

  it('clears the preparing state when a concurrent refresh supersedes prepare', async () => {
    const preparedRun = summary('run-prepared', 'awaiting_approval');
    const preparePending = deferred<{
      runId: string;
      planDigest: DeploymentRunSummary['planDigest'];
      expiresAt: number;
    }>();
    mocks.prepare.mockReturnValue(preparePending.promise);
    mocks.runs.mockResolvedValue({ items: [preparedRun], nextCursor: null });
    mocks.detail.mockResolvedValue(detail(preparedRun));

    const preparing = useDeploymentWorkflowRunStore.getState().prepare(workflow);
    expect(useDeploymentWorkflowRunStore.getState().preparing).toBe(true);
    const refreshing = useDeploymentWorkflowRunStore.getState().refreshWorkflow(workflow.id);
    preparePending.resolve({
      runId: preparedRun.runId,
      planDigest: preparedRun.planDigest,
      expiresAt: preparedRun.expiresAt,
    });
    await preparing;
    await refreshing;

    const state = useDeploymentWorkflowRunStore.getState();
    expect(state.preparing).toBe(false);
    expect(state.preparationNodes).toEqual([]);
    expect(state.preparationCompleted).toBe(0);
    expect(state.loading).toBe(false);
  });

  it('ignores node progress events from other runs while preparing', async () => {
    const preparedRun = summary('run-prepared', 'awaiting_approval');
    let progressHandler: ((event: { payload: DeploymentNodeProgressEvent }) => void) | null = null;
    mocks.listenProgress.mockImplementation(
      async (callback: (event: { payload: DeploymentNodeProgressEvent }) => void) => {
        progressHandler = callback;
        return vi.fn();
      },
    );
    mocks.prepare.mockResolvedValue({
      runId: preparedRun.runId,
      planDigest: preparedRun.planDigest,
      expiresAt: preparedRun.expiresAt,
    });
    mocks.runs.mockResolvedValue({ items: [preparedRun], nextCursor: null });
    const pendingDetail = deferred<DeploymentRunDetail>();
    mocks.detail.mockReturnValueOnce(pendingDetail.promise);
    mocks.detail.mockResolvedValue(detail(preparedRun));

    const noApprovalWorkflow: DeploymentWorkflowRecord = {
      ...workflow,
      definition: { ...workflow.definition, nodes: [workflow.definition.nodes[0]] },
    };
    const preparing = useDeploymentWorkflowRunStore.getState().prepare(noApprovalWorkflow);
    const progress = (payload: DeploymentNodeProgressEvent): void => {
      progressHandler?.({ payload });
    };
    const event = (overrides: Partial<DeploymentNodeProgressEvent>): DeploymentNodeProgressEvent => ({
      operationId: 'op-1',
      runId: preparedRun.runId,
      nodeId: 'source',
      attempt: 1,
      sequence: 1,
      phase: 'running',
      completed: 0,
      total: 1,
      unit: 'steps',
      summaryKey: 'deployment.run.progress',
      ...overrides,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(progressHandler).not.toBeNull();

    progress(event({ runId: 'run-other', sequence: 9, completed: 5 }));
    expect(useDeploymentWorkflowRunStore.getState().preparationCompleted).toBe(0);

    progress(event({ sequence: 1, phase: 'succeeded', completed: 1 }));
    expect(useDeploymentWorkflowRunStore.getState().preparationCompleted).toBe(1);
    expect(useDeploymentWorkflowRunStore.getState().preparationNodes[0]?.status).toBe('succeeded');

    progress(event({ nodeId: 'unknown-node', sequence: 2, completed: 7 }));
    expect(useDeploymentWorkflowRunStore.getState().preparationCompleted).toBe(1);

    pendingDetail.resolve(detail(preparedRun));
    await preparing;
    expect(useDeploymentWorkflowRunStore.getState().notice?.kind).toBe('prepared');
  });

  it('polls the selected node and merges events without dropping loaded history', async () => {
    const run1 = summary('run-1', 'in_progress');
    const buildNode: DeploymentRunNodeRecord = {
      ...node, nodeId: 'build', nodeType: 'build.local', lastAttempt: 1,
    };
    mocks.nodes.mockResolvedValue([node, buildNode]);
    mocks.runs.mockResolvedValue({ items: [run1], nextCursor: null });
    mocks.detail.mockResolvedValue(detail(run1));
    const attemptFor = (nodeId: string): DeploymentNodeAttemptRecord => ({
      schemaVersion: 1, runId: run1.runId, nodeId, attempt: 1,
      nodeType: 'transfer.sftp', nodeTypeVersion: 2, executorVersion: 'native/v1',
      idempotencyKey: `attempt-${nodeId}`, status: 'succeeded', createdAt: 1, updatedAt: 2,
    });
    mocks.attempts.mockImplementation(async (_runId: string, nodeId: string) => ({
      items: [attemptFor(nodeId)], nextBeforeAttempt: null,
    }));
    const runEvent = (sequence: number): DeploymentRunEvent => ({
      runId: run1.runId, sequence, nodeId: 'transfer', attempt: 1,
      eventKind: 'node.running', status: null, summaryKey: 'deployment.run.progress',
      payload: null, recordedAt: sequence,
    });
    mocks.events
      .mockResolvedValueOnce({ items: [runEvent(8), runEvent(9)], nextBeforeSequence: 8 })
      .mockResolvedValueOnce({ items: [runEvent(8), runEvent(9), runEvent(10)], nextBeforeSequence: 8 })
      .mockResolvedValueOnce({ items: [runEvent(6), runEvent(7)], nextBeforeSequence: 6 });

    await useDeploymentWorkflowRunStore.getState().loadWorkflow('workflow-1');
    expect(useDeploymentWorkflowRunStore.getState().events.map((item) => item.sequence)).toEqual([8, 9]);
    expect(useDeploymentWorkflowRunStore.getState().nextEventSequence).toBe(8);

    await useDeploymentWorkflowRunStore.getState().selectNode('build');
    expect(useDeploymentWorkflowRunStore.getState().attempts.map((item) => item.nodeId)).toEqual(['build']);

    await useDeploymentWorkflowRunStore.getState().refreshSelectedRun();
    let state = useDeploymentWorkflowRunStore.getState();
    expect(mocks.attempts).toHaveBeenLastCalledWith('run-1', 'build', null, 20);
    expect(state.attempts.map((item) => item.nodeId)).toEqual(['build']);
    expect(state.events.map((item) => item.sequence)).toEqual([10, 8, 9]);
    expect(state.nextEventSequence).toBe(8);

    await useDeploymentWorkflowRunStore.getState().loadMoreEvents();
    state = useDeploymentWorkflowRunStore.getState();
    expect(state.events.map((item) => item.sequence)).toEqual([10, 8, 9, 6, 7]);
    expect(state.nextEventSequence).toBe(6);

    await useDeploymentWorkflowRunStore.getState().refreshSelectedRun();
    state = useDeploymentWorkflowRunStore.getState();
    expect(state.events.map((item) => item.sequence)).toEqual([10, 8, 9, 6, 7]);
    expect(state.nextEventSequence).toBe(6);
  });

  it('records polling errors without rethrowing them', async () => {
    const run1 = summary('run-1', 'in_progress');
    useDeploymentWorkflowRunStore.setState({
      workflowId: workflow.id,
      runs: [run1],
      selectedRunId: run1.runId,
      detail: detail(run1),
      nodes: [node],
    });
    mocks.detail.mockRejectedValue(new Error('run projection unavailable'));

    await expect(useDeploymentWorkflowRunStore.getState().refreshSelectedRun()).resolves.toBeUndefined();
    expect(useDeploymentWorkflowRunStore.getState().error).toBe('run projection unavailable');
    expect(useDeploymentWorkflowRunStore.getState().errorContext).toBe('operation');
  });
});
