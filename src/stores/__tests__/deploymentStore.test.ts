import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeploymentArtifactBuildProgress,
  DeploymentArtifactBuildResult,
  DeploymentArtifactTransferProgress,
  DeploymentArtifactTransferResult,
  DeploymentPreflightResult,
  DeploymentRemoteRunnerProgress,
  DeploymentRemoteRunnerResult,
  DeploymentStoredPlanRecord,
  DeploymentWorkflowCreate,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentStore } from '../deploymentStore';

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  preflight: vi.fn(),
  cancel: vi.fn(),
  snapshot: vi.fn(),
  buildArtifact: vi.fn(),
  cancelArtifact: vi.fn(),
  listenArtifact: vi.fn(),
  createPlan: vi.fn(),
  requestApproval: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  transferArtifact: vi.fn(),
  cancelTransfer: vi.fn(),
  listenTransfer: vi.fn(),
  runRemote: vi.fn(),
  cancelRemote: vi.fn(),
  listenRemote: vi.fn(),
  getPlan: vi.fn(),
  startupRecovery: vi.fn(),
  reconciliationBinding: vi.fn(),
  reconcile: vi.fn(),
  cancelReconciliation: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeDeploymentRuntimeCapabilities: mocks.capabilities,
  invokeListDeploymentWorkflows: mocks.list,
  invokeCreateDeploymentWorkflow: mocks.create,
  invokeUpdateDeploymentWorkflow: mocks.update,
  invokeDeleteDeploymentWorkflow: mocks.remove,
  invokeDeploymentPreflight: mocks.preflight,
  invokeCancelDeploymentPreflight: mocks.cancel,
  invokeDeploymentArtifactSourceSnapshot: mocks.snapshot,
  invokeBuildDeploymentArtifact: mocks.buildArtifact,
  invokeCancelDeploymentArtifactBuild: mocks.cancelArtifact,
  listenToDeploymentArtifactBuildProgress: mocks.listenArtifact,
  invokeCreateDeploymentPlan: mocks.createPlan,
  invokeRequestDeploymentApproval: mocks.requestApproval,
  invokeApproveDeploymentPlan: mocks.approvePlan,
  invokeRejectDeploymentPlan: mocks.rejectPlan,
  invokeTransferDeploymentArtifact: mocks.transferArtifact,
  invokeCancelDeploymentArtifactTransfer: mocks.cancelTransfer,
  listenToDeploymentArtifactTransferProgress: mocks.listenTransfer,
  invokeRunDeploymentRemote: mocks.runRemote,
  invokeCancelDeploymentRemoteRunner: mocks.cancelRemote,
  listenToDeploymentRemoteRunnerProgress: mocks.listenRemote,
  invokeGetDeploymentPlan: mocks.getPlan,
  invokeDeploymentStartupRecovery: mocks.startupRecovery,
  invokeDeploymentReconciliationBinding: mocks.reconciliationBinding,
  invokeDeploymentReconcile: mocks.reconcile,
  invokeCancelDeploymentReconciliationObservation: mocks.cancelReconciliation,
}));

const workflowInput: DeploymentWorkflowCreate = {
  name: 'API',
  enabled: true,
  definition: {
    schemaVersion: 2,
    sourceDirectory: '/workspace/api',
    build: {
      context: '.',
      dockerfile: 'Dockerfile',
      platform: 'linux/amd64',
      imageRepository: 'example.test/shellspan/api',
      compression: 'zstd',
    },
    target: { connectionProfileId: 'profile-1', remoteRoot: '/srv/api' },
    compose: {
      projectName: 'api',
      files: ['compose.yaml'],
      services: ['web'],
      pullBeforeUp: true,
    },
    healthCheck: null,
    reloadNginxAfterHealthy: false,
    releasesToKeep: 3,
  },
};

function workflow(revision = 1): DeploymentWorkflowRecord {
  return {
    id: 'workflow-1',
    connectionProfileId: 'profile-1',
    revision,
    createdAt: 1,
    updatedAt: revision,
    ...workflowInput,
  };
}

function preflightResult(operationId: string): DeploymentPreflightResult {
  const planInput = {
    workflowId: 'workflow-1',
    expectedRevision: 1,
    sourceRunId: null,
    operationKind: 'deploy' as const,
    triggerKind: 'manual' as const,
    artifactReference: artifactResult().artifactReference!,
    sourceRevision: { revision: 'a'.repeat(40), dirty: false },
    target: {
      profileId: 'profile-1',
      profileUpdatedAt: 1,
      host: 'example.test',
      port: 22,
      username: 'deploy',
      authMethod: 'password' as const,
      jumpHost: null,
    },
    currentRelease: null,
    targetRelease: { releaseId: 'release-2', artifactDigestSha256: 'b'.repeat(64) },
    rollbackRelease: null,
    preflight: {
      checkedAt: 1,
      checks: [{ code: 'docker', outcome: 'passed' as const, summary: 'available' }],
    },
    ttlSeconds: 600,
  };
  return {
    operationId,
    workflowId: 'workflow-1',
    workflowRevision: 1,
    artifactReference: artifactResult().artifactReference!,
    status: 'passed',
    checkedAt: 1,
    source: { kind: 'gitAndSshReadOnly', commandSetVersion: 'v1' },
    sourceRevision: planInput.sourceRevision,
    target: null,
    server: { os: 'Linux', architecture: 'x86_64' },
    remoteRoot: { path: '/srv/api', reachable: true, availableBytes: 100 },
    tools: { docker: true, compose: true, flock: true, curl: true, nginx: true, nginxReload: true, sha256: 'sha256sum', compression: 'tar+gzip' },
    currentRelease: null,
    rollbackReleases: [],
    checks: planInput.preflight.checks,
    planInput,
    failure: null,
  };
}

function artifactResult(operationId = 'deployment-artifact-build:test'): DeploymentArtifactBuildResult {
  const manifest = {
    schemaVersion: 1 as const,
    contentIdentitySha256: 'c'.repeat(64),
    workflowId: 'workflow-1',
    workflowRevision: 1,
    sourceRevision: { revision: 'a'.repeat(40), dirty: false },
    releaseId: 'release-2',
    platform: 'linux/amd64',
    image: {
      repository: 'example.test/shellspan/api',
      tag: 'release-2',
      imageId: `sha256:${'d'.repeat(64)}`,
    },
    archive: {
      fileName: 'image.tar.zst',
      compression: 'zstd' as const,
      bytes: 128,
      sha256: 'b'.repeat(64),
    },
    composeFiles: [{
      path: 'compose.yaml',
      fileName: 'compose/compose.yaml',
      bytes: 32,
      sha256: 'e'.repeat(64),
    }],
    createdAt: 1,
    manifestDigestSha256: 'f'.repeat(64),
  };
  return {
    operationId,
    workflowId: 'workflow-1',
    workflowRevision: 1,
    builderKind: 'dockerBuildx',
    status: 'succeeded',
    sourceRevision: manifest.sourceRevision,
    releaseId: manifest.releaseId,
    artifactDigestSha256: manifest.archive.sha256,
    artifactBytes: manifest.archive.bytes,
    artifactReference: `deployment-artifact-v1:${'c'.repeat(64)}:${'f'.repeat(64)}`,
    manifest,
    reused: false,
    failure: null,
  };
}

function storedPlan(status: DeploymentStoredPlanRecord['status'] = 'planned'): DeploymentStoredPlanRecord {
  const result = preflightResult('deployment-preflight:test');
  const planInput = result.planInput!;
  const generatedAt = Date.now();
  const expiresAt = generatedAt + 600_000;
  return {
    planId: `plan-${'c'.repeat(64)}`,
    planDigest: 'c'.repeat(64),
    runId: 'run-1',
    runRevision: status === 'planned' ? 1 : status === 'awaiting_approval' ? 2 : 3,
    status,
    createdAt: generatedAt,
    expiresAt,
    approvalSummary: {
      schemaVersion: 2,
      workflowId: 'workflow-1',
      workflowRevision: 1,
      operationKind: 'deploy',
      artifactReference: artifactResult().artifactReference!,
      frozen: {
        sourceRevision: planInput.sourceRevision,
        target: {
          profileId: 'profile-1',
          profileUpdatedAt: 1,
          host: 'example.test',
          port: 22,
          username: 'deploy',
          authMethod: 'password',
          jumpHost: null,
        },
        currentRelease: null,
        targetRelease: planInput.targetRelease,
        rollbackRelease: null,
        preflight: planInput.preflight,
      },
      remoteRoot: '/srv/api',
      composeProject: 'api',
      composeFiles: ['compose.yaml'],
      services: ['web'],
      actions: ['stage_release', 'prepare_release', 'load_image', 'compose_config', 'compose_pull', 'compose_up', 'verify_health', 'activate_release'],
      generatedAt,
      expiresAt,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilities.mockResolvedValue({
    schemaVersion: 1,
    admissionsEnabled: true,
    defaultEnabled: true,
    flagName: 'SHELLSPAN_DEPLOYMENT_CENTER_V1',
    source: 'default',
    readOnlyRecoveryAvailable: true,
    automaticReleaseCleanup: false,
  });
  mocks.list.mockResolvedValue([workflow()]);
  mocks.startupRecovery.mockResolvedValue({ schemaVersion: 1, candidates: [] });
  mocks.cancelReconciliation.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(true);
  mocks.cancelArtifact.mockResolvedValue(true);
  mocks.cancelTransfer.mockResolvedValue(true);
  mocks.cancelRemote.mockResolvedValue(true);
  mocks.snapshot.mockResolvedValue({ revision: 'a'.repeat(40), dirty: false });
  mocks.listenArtifact.mockResolvedValue(vi.fn());
  mocks.listenTransfer.mockResolvedValue(vi.fn());
  mocks.listenRemote.mockResolvedValue(vi.fn());
  useDeploymentStore.setState({
    runtimeCapabilities: null,
    workflows: [],
    selectedWorkflowId: null,
    profileFilterId: null,
    initialized: false,
    loading: false,
    saving: false,
    error: null,
    recoveryCandidates: [],
    recoveryDiscoveryFailed: false,
    reconciliationPhase: 'idle',
    reconciliationOperationId: null,
    reconciliationRunId: null,
    reconciliationResults: {},
    recoveredApprovedBinding: null,
    artifactBuildPhase: 'idle',
    artifactBuildOperationId: null,
    artifactWorkflowId: null,
    artifactBuildProgress: null,
    artifactBuildResult: null,
    preflightPhase: 'idle',
    preflightOperationId: null,
    preflightWorkflowId: null,
    preflightResult: null,
    plan: null,
    approvalPhase: 'idle',
    artifactTransferPhase: 'idle',
    artifactTransferOperationId: null,
    artifactTransferWorkflowId: null,
    artifactTransferProgress: null,
    artifactTransferResult: null,
    remoteRunnerPhase: 'idle',
    remoteRunnerOperationId: null,
    remoteRunnerWorkflowId: null,
    remoteRunnerProgress: null,
    remoteRunnerLog: [],
    remoteRunnerResult: null,
  });
});

describe('useDeploymentStore', () => {
  it('rejects new deployment admissions locally when the native rollout is disabled', async () => {
    useDeploymentStore.setState({
      runtimeCapabilities: {
        schemaVersion: 1,
        admissionsEnabled: false,
        defaultEnabled: true,
        flagName: 'SHELLSPAN_DEPLOYMENT_CENTER_V1',
        source: 'environment',
        readOnlyRecoveryAvailable: true,
        automaticReleaseCleanup: false,
      },
      workflows: [workflow()],
    });

    await expect(useDeploymentStore.getState().createWorkflow(workflowInput))
      .rejects.toThrow('DEPLOYMENT_ADMISSIONS_DISABLED');
    await expect(useDeploymentStore.getState().buildArtifact('workflow-1', 1))
      .rejects.toThrow('DEPLOYMENT_ADMISSIONS_DISABLED');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.buildArtifact).not.toHaveBeenCalled();
  });

  it('projects backend CRUD results without manufacturing local revisions', async () => {
    await useDeploymentStore.getState().loadWorkflows();
    expect(useDeploymentStore.getState().workflows).toEqual([workflow()]);

    const created = { ...workflow(), id: 'workflow-2', revision: 7, name: 'Worker' };
    mocks.create.mockResolvedValue(created);
    await useDeploymentStore.getState().createWorkflow({ ...workflowInput, name: 'Worker' });
    expect(useDeploymentStore.getState().selectedWorkflowId).toBe('workflow-2');
    expect(useDeploymentStore.getState().workflows.find((item) => item.id === 'workflow-2')?.revision).toBe(7);

    const updated = { ...created, revision: 11, name: 'Worker API' };
    mocks.update.mockResolvedValue(updated);
    await useDeploymentStore.getState().updateWorkflow(created.id, {
      ...workflowInput,
      name: 'Worker API',
      expectedRevision: 7,
    });
    expect(useDeploymentStore.getState().workflows.find((item) => item.id === created.id)?.revision).toBe(11);

    mocks.remove.mockResolvedValue(undefined);
    await useDeploymentStore.getState().deleteWorkflow(created.id, 11);
    expect(useDeploymentStore.getState().workflows.some((item) => item.id === created.id)).toBe(false);
  });

  it('refreshes the authoritative projection after a compare-and-swap conflict', async () => {
    useDeploymentStore.setState({ workflows: [workflow()], initialized: true });
    mocks.update.mockRejectedValue(new Error('REVISION_CONFLICT'));
    mocks.list.mockResolvedValue([workflow(4)]);

    await expect(useDeploymentStore.getState().updateWorkflow('workflow-1', {
      ...workflowInput,
      expectedRevision: 1,
    })).rejects.toThrow('REVISION_CONFLICT');

    expect(mocks.list).toHaveBeenCalledOnce();
    expect(useDeploymentStore.getState().workflows[0]?.revision).toBe(4);
  });

  it('recovers from list errors on the next successful refresh', async () => {
    mocks.list.mockRejectedValueOnce(new Error('offline'));
    await expect(useDeploymentStore.getState().loadWorkflows()).rejects.toThrow('offline');
    expect(useDeploymentStore.getState()).toMatchObject({
      initialized: true,
      recoveryDiscoveryFailed: true,
      error: 'offline',
    });

    mocks.list.mockResolvedValueOnce([workflow()]);
    await useDeploymentStore.getState().loadWorkflows();
    expect(useDeploymentStore.getState()).toMatchObject({
      error: null,
      recoveryDiscoveryFailed: false,
      workflows: [workflow()],
    });
  });

  it('tracks preflight cancellation and creates plans only from the backend result', async () => {
    useDeploymentStore.setState({
      workflows: [workflow()],
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifactResult(),
    });
    let resolvePreflight!: (result: DeploymentPreflightResult) => void;
    mocks.preflight.mockImplementation(({ operationId }) => new Promise((resolve) => {
      resolvePreflight = () => resolve(preflightResult(operationId));
    }));
    const pending = useDeploymentStore.getState().runPreflight({
      workflowId: 'workflow-1',
      expectedRevision: 1,
      ttlSeconds: 600,
      timeoutMs: 30_000,
    });
    await vi.waitFor(() => expect(useDeploymentStore.getState().preflightOperationId).toBeTruthy());
    const operationId = useDeploymentStore.getState().preflightOperationId;
    expect(operationId).toMatch(/^deployment-preflight:/);
    await useDeploymentStore.getState().cancelPreflight();
    expect(mocks.cancel).toHaveBeenCalledWith(operationId);
    resolvePreflight(preflightResult(operationId!));
    await pending;

    const plan = storedPlan();
    mocks.createPlan.mockResolvedValue(plan);
    await useDeploymentStore.getState().createPlan();
    expect(mocks.createPlan).toHaveBeenCalledWith(preflightResult(operationId!).planInput);
    expect(useDeploymentStore.getState().plan).toEqual(plan);
  });

  it('tracks artifact progress and invalidates artifact, preflight, and plan on workflow changes', async () => {
    useDeploymentStore.setState({ workflows: [workflow()], initialized: true });
    let progressListener: ((event: { payload: DeploymentArtifactBuildProgress }) => void) | undefined;
    mocks.listenArtifact.mockImplementation(async (listener) => {
      progressListener = listener;
      return vi.fn();
    });
    mocks.buildArtifact.mockImplementation(async ({ operationId }) => {
      progressListener?.({
        payload: {
          operationId,
          sequence: 3,
          step: 'buildingImage',
          completedBytes: null,
          totalBytes: null,
          summary: 'fixed summary',
        },
      });
      return artifactResult(operationId);
    });

    const result = await useDeploymentStore.getState().buildArtifact('workflow-1', 1);
    expect(result.status).toBe('succeeded');
    expect(useDeploymentStore.getState().artifactBuildProgress?.step).toBe('buildingImage');
    expect(mocks.buildArtifact).toHaveBeenCalledWith(expect.objectContaining({
      builderKind: 'dockerBuildx',
      sourceRevision: { revision: 'a'.repeat(40), dirty: false },
    }));

    useDeploymentStore.setState({
      preflightWorkflowId: 'workflow-1',
      preflightResult: preflightResult('deployment-preflight:old'),
      plan: storedPlan(),
    });
    const updated = workflow(2);
    mocks.update.mockResolvedValue(updated);
    await useDeploymentStore.getState().updateWorkflow('workflow-1', {
      ...workflowInput,
      expectedRevision: 1,
    });
    expect(useDeploymentStore.getState()).toMatchObject({
      artifactBuildResult: null,
      preflightResult: null,
      plan: null,
    });
  });

  it('fails closed when the Git source changed after artifact creation', async () => {
    useDeploymentStore.setState({
      workflows: [workflow()],
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifactResult(),
    });
    mocks.snapshot.mockResolvedValue({ revision: '9'.repeat(40), dirty: false });

    await expect(useDeploymentStore.getState().runPreflight({
      workflowId: 'workflow-1',
      expectedRevision: 1,
      ttlSeconds: 600,
      timeoutMs: 30_000,
    })).rejects.toThrow('DEPLOYMENT_ARTIFACT_STALE_SOURCE');
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(useDeploymentStore.getState().artifactBuildResult).toBeNull();
  });

  it('uploads only an approved matching plan and accepts monotonic transfer progress', async () => {
    const plan = storedPlan('approved');
    useDeploymentStore.setState({
      workflows: [workflow()],
      selectedWorkflowId: 'workflow-1',
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifactResult(),
      preflightWorkflowId: 'workflow-1',
      preflightResult: preflightResult('deployment-preflight:test'),
      plan,
    });
    let listener: ((event: { payload: DeploymentArtifactTransferProgress }) => void) | undefined;
    mocks.listenTransfer.mockImplementation(async (callback) => {
      listener = callback;
      return vi.fn();
    });
    mocks.transferArtifact.mockImplementation(async (input) => {
      listener?.({
        payload: {
          operationId: input.operationId,
          sequence: 2,
          step: 'stageArchive',
          fileId: 'image.tar.zst',
          completedBytes: 64,
          totalBytes: 128,
          summary: 'bounded',
        },
      });
      listener?.({
        payload: {
          operationId: input.operationId,
          sequence: 1,
          step: 'lock',
          fileId: null,
          completedBytes: null,
          totalBytes: null,
          summary: 'stale',
        },
      });
      return {
        operationId: input.operationId,
        planId: input.planId,
        releaseId: input.releaseId,
        remoteStagingIdentity: `deployment-staging-v1:${'c'.repeat(64)}:${'f'.repeat(64)}`,
        transferredBytes: 128,
        remoteDigestSha256: 'b'.repeat(64),
        status: 'succeeded',
        failure: null,
        reused: false,
        resumed: true,
      } satisfies DeploymentArtifactTransferResult;
    });

    const result = await useDeploymentStore.getState().transferArtifact();

    expect(result.status).toBe('succeeded');
    expect(useDeploymentStore.getState().artifactTransferProgress?.sequence).toBe(2);
    expect(useDeploymentStore.getState().artifactTransferResult?.resumed).toBe(true);
    expect(mocks.transferArtifact).toHaveBeenCalledWith(expect.objectContaining({
      planId: plan.planId,
      planDigest: plan.planDigest,
      workflowRevision: 1,
      artifactReference: artifactResult().artifactReference,
      releaseDigestSha256: 'b'.repeat(64),
      remoteRoot: '/srv/api',
    }));
  });

  it('cancels the active transfer and invalidates a verified result on workflow drift', async () => {
    const plan = storedPlan('approved');
    const transfer: DeploymentArtifactTransferResult = {
      operationId: 'deployment-artifact-transfer:done',
      planId: plan.planId,
      releaseId: 'release-2',
      remoteStagingIdentity: `deployment-staging-v1:${'c'.repeat(64)}:${'f'.repeat(64)}`,
      transferredBytes: 128,
      remoteDigestSha256: 'b'.repeat(64),
      status: 'succeeded',
      failure: null,
      reused: false,
      resumed: false,
    };
    useDeploymentStore.setState({
      workflows: [workflow()],
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifactResult(),
      preflightWorkflowId: 'workflow-1',
      plan,
      artifactTransferPhase: 'running',
      artifactTransferOperationId: 'deployment-artifact-transfer:active',
      artifactTransferWorkflowId: 'workflow-1',
      artifactTransferResult: transfer,
    });

    await useDeploymentStore.getState().cancelArtifactTransfer();
    expect(mocks.cancelTransfer).toHaveBeenCalledWith('deployment-artifact-transfer:active');

    mocks.update.mockResolvedValue(workflow(2));
    await useDeploymentStore.getState().updateWorkflow('workflow-1', {
      ...workflowInput,
      expectedRevision: 1,
    });
    expect(useDeploymentStore.getState().artifactTransferResult).toBeNull();
    expect(useDeploymentStore.getState().artifactTransferWorkflowId).toBeNull();
  });

  it('fails closed for planned, expired, or artifact-drifted transfer inputs', async () => {
    useDeploymentStore.setState({
      workflows: [workflow()],
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifactResult(),
      preflightWorkflowId: 'workflow-1',
      plan: storedPlan('planned'),
    });
    await expect(useDeploymentStore.getState().transferArtifact())
      .rejects.toThrow('DEPLOYMENT_APPROVED_PLAN_REQUIRED');
    expect(mocks.transferArtifact).not.toHaveBeenCalled();

    const driftedPlan = storedPlan('approved');
    driftedPlan.approvalSummary.frozen.targetRelease.artifactDigestSha256 = '9'.repeat(64);
    useDeploymentStore.setState({ plan: driftedPlan });
    await expect(useDeploymentStore.getState().transferArtifact())
      .rejects.toThrow('DEPLOYMENT_APPROVED_PLAN_REQUIRED');
    expect(mocks.transferArtifact).not.toHaveBeenCalled();
  });

  it('binds approval decisions to the exact plan revision and expiry', async () => {
    const planned = storedPlan('planned');
    const awaiting = { ...planned, status: 'awaiting_approval' as const, runRevision: 2 };
    const approved = { ...awaiting, status: 'approved' as const, runRevision: 3 };
    useDeploymentStore.setState({ plan: planned });
    mocks.requestApproval.mockResolvedValue(awaiting);
    mocks.approvePlan.mockResolvedValue(approved);

    await useDeploymentStore.getState().requestApproval();
    expect(mocks.requestApproval).toHaveBeenCalledWith({
      planId: planned.planId,
      planDigest: planned.planDigest,
      runId: planned.runId,
      runRevision: 1,
      expiresAt: planned.expiresAt,
    });
    await useDeploymentStore.getState().approvePlan();
    expect(mocks.approvePlan).toHaveBeenCalledWith(expect.objectContaining({
      runRevision: 2,
      expiresAt: planned.expiresAt,
    }));
    expect(useDeploymentStore.getState().plan).toEqual(approved);
  });

  it('runs only a matching successful transfer, bounds progress, and cancels with plan identity', async () => {
    const plan = storedPlan('approved');
    const artifact = artifactResult();
    const transfer: DeploymentArtifactTransferResult = {
      operationId: 'deployment-artifact-transfer:done',
      planId: plan.planId,
      releaseId: artifact.releaseId!,
      remoteStagingIdentity: `deployment-staging-v1:${'c'.repeat(64)}:${'f'.repeat(64)}`,
      transferredBytes: 128,
      remoteDigestSha256: artifact.artifactDigestSha256,
      status: 'succeeded',
      failure: null,
      reused: false,
      resumed: false,
    };
    useDeploymentStore.setState({
      workflows: [workflow()],
      artifactWorkflowId: 'workflow-1',
      artifactBuildResult: artifact,
      preflightWorkflowId: 'workflow-1',
      plan,
      artifactTransferWorkflowId: 'workflow-1',
      artifactTransferResult: transfer,
    });
    let listener: ((event: { payload: DeploymentRemoteRunnerProgress }) => void) | undefined;
    mocks.listenRemote.mockImplementation(async (callback) => {
      listener = callback;
      return vi.fn();
    });
    let resolveRunner!: (result: DeploymentRemoteRunnerResult) => void;
    mocks.runRemote.mockImplementation((input) => new Promise((resolve) => {
      listener?.({
        payload: {
          operationId: input.operationId,
          sequence: 1,
          step: 'composeUp',
          status: 'running',
          summary: 'Approved_Compose_release_applied',
        },
      });
      resolveRunner = resolve;
    }));
    mocks.getPlan.mockResolvedValue({ ...plan, status: 'succeeded', runRevision: 12 });

    const pending = useDeploymentStore.getState().runRemote();
    await vi.waitFor(() => expect(useDeploymentStore.getState().remoteRunnerOperationId).toBeTruthy());
    const operationId = useDeploymentStore.getState().remoteRunnerOperationId!;
    await useDeploymentStore.getState().cancelRemoteRunner();
    expect(mocks.cancelRemote).toHaveBeenCalledWith({
      operationId,
      planId: plan.planId,
      planDigest: plan.planDigest,
      runId: plan.runId,
    });
    resolveRunner({
      operationId,
      planId: plan.planId,
      runId: plan.runId,
      releaseId: artifact.releaseId!,
      status: 'rolledBack',
      activeRelease: null,
      rollbackRelease: null,
      reconciliationRequired: false,
      failureCategory: 'cancelled',
    });
    await pending;
    expect(useDeploymentStore.getState().remoteRunnerLog).toHaveLength(1);
    expect(mocks.runRemote).toHaveBeenCalledWith(expect.objectContaining({
      runRevision: plan.runRevision,
      artifactTransferOperationId: transfer.operationId,
      remoteStagingIdentity: transfer.remoteStagingIdentity,
    }));
  });

  it('discovers startup recovery candidates and gates new deployment effects', async () => {
    const candidate = {
      runId: 'run-recovery',
      planId: `plan-${'c'.repeat(64)}`,
      planDigest: 'c'.repeat(64),
      status: 'state_unknown' as const,
      lastEventSequence: 9,
      reconciliationRequired: true,
    };
    mocks.startupRecovery.mockResolvedValue({ schemaVersion: 1, candidates: [candidate] });

    await useDeploymentStore.getState().loadWorkflows();

    expect(useDeploymentStore.getState().recoveryCandidates).toEqual([candidate]);
    await expect(
      useDeploymentStore.getState().buildArtifact('workflow-1', 1),
    ).rejects.toThrow('DEPLOYMENT_RECONCILIATION_REQUIRED');
    expect(mocks.buildArtifact).not.toHaveBeenCalled();
  });

  it('reconciles an exact startup binding and keeps observation cancellation separate', async () => {
    const candidate = {
      runId: 'run-recovery',
      planId: `plan-${'c'.repeat(64)}`,
      planDigest: 'c'.repeat(64),
      status: 'in_progress' as const,
      lastEventSequence: 9,
      reconciliationRequired: true,
    };
    useDeploymentStore.setState({ recoveryCandidates: [candidate] });
    mocks.reconciliationBinding.mockResolvedValue({
      candidate,
      artifactTransferOperationId: 'deployment-artifact-transfer:receipt',
      remoteStagingIdentity: `deployment-staging-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      reconciliationOperationId: null,
    });
    let resolve!: (value: unknown) => void;
    mocks.reconcile.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = useDeploymentStore.getState().reconcileRun(candidate.runId);
    await vi.waitFor(() => expect(useDeploymentStore.getState().reconciliationPhase).toBe('running'));
    const operationId = useDeploymentStore.getState().reconciliationOperationId!;
    await useDeploymentStore.getState().stopReconciliationObservation();
    expect(mocks.cancelReconciliation).toHaveBeenCalledWith(operationId);
    mocks.startupRecovery.mockResolvedValue({ schemaVersion: 1, candidates: [candidate] });
    resolve({
      operationId,
      planId: candidate.planId,
      runId: candidate.runId,
      status: 'in_progress',
      outcome: 'observationStopped',
      reconciliationRequired: false,
      evidence: {
        remoteSequence: 4,
        runnerIdentityVerified: true,
        requestIdentityVerified: true,
        ledgerVerified: true,
        currentReleaseId: null,
        previousReleaseId: null,
        targetReleaseVerified: false,
        rollbackReleaseVerified: false,
        composeServicesVerified: false,
        healthVerified: false,
        sideEffectsStarted: false,
        approvalReusable: false,
      },
    });
    await pending;
    expect(useDeploymentStore.getState().reconciliationResults[candidate.runId]?.outcome)
      .toBe('observationStopped');
  });
});
