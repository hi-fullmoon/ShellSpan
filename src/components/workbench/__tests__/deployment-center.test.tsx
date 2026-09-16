import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentCenter from '../deployment-center';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import type {
  DeploymentArtifactBuildResult,
  DeploymentPreflightResult,
  DeploymentStoredPlanRecord,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { ConnectionProfile } from '@/types';

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

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values?.name ? `${key}:${values.name}` : key
    ),
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  createdAt: 1,
  updatedAt: 1,
};

const workflow: DeploymentWorkflowRecord = {
  id: 'workflow-1',
  name: 'API',
  connectionProfileId: profile.id,
  revision: 1,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
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
    target: { connectionProfileId: profile.id, remoteRoot: '/srv/api' },
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

function preflight(operationId: string): DeploymentPreflightResult {
  const planInput = {
    workflowId: workflow.id,
    expectedRevision: workflow.revision,
    sourceRunId: null,
    operationKind: 'deploy' as const,
    triggerKind: 'manual' as const,
    artifactReference: artifact().artifactReference!,
    sourceRevision: { revision: 'a'.repeat(40), dirty: false },
    target: {
      profileId: profile.id,
      profileUpdatedAt: 1,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authMethod: 'password' as const,
      jumpHost: null,
    },
    currentRelease: null,
    targetRelease: { releaseId: 'release-next', artifactDigestSha256: 'b'.repeat(64) },
    rollbackRelease: null,
    preflight: {
      checkedAt: 1,
      checks: [{ code: 'docker', outcome: 'passed' as const, summary: 'Docker is available' }],
    },
    ttlSeconds: 600,
  };
  return {
    operationId,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    artifactReference: artifact().artifactReference!,
    status: 'passed',
    checkedAt: 1,
    source: { kind: 'gitAndSshReadOnly', commandSetVersion: 'v1' },
    sourceRevision: planInput.sourceRevision,
    target: null,
    server: { os: 'Linux', architecture: 'x86_64' },
    remoteRoot: { path: '/srv/api', reachable: true, availableBytes: 1024 },
    tools: { docker: true, compose: true, flock: true, curl: true, nginx: true, nginxReload: true, sha256: 'sha256sum', compression: 'tar+gzip' },
    currentRelease: null,
    rollbackReleases: [],
    checks: planInput.preflight.checks,
    planInput,
    failure: null,
  };
}

function artifact(operationId = 'deployment-artifact-build:test'): DeploymentArtifactBuildResult {
  const manifest = {
    schemaVersion: 1 as const,
    contentIdentitySha256: 'c'.repeat(64),
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    sourceRevision: { revision: 'a'.repeat(40), dirty: false },
    releaseId: 'release-next',
    platform: 'linux/amd64',
    image: {
      repository: workflow.definition.build.imageRepository,
      tag: 'release-next',
      imageId: `sha256:${'d'.repeat(64)}`,
    },
    archive: {
      fileName: 'image.tar.zst',
      compression: 'zstd' as const,
      bytes: 1024,
      sha256: 'b'.repeat(64),
    },
    composeFiles: [{
      path: 'compose.yaml',
      fileName: 'compose/compose.yaml',
      bytes: 32,
      sha256: 'e'.repeat(64),
    }],
    createdAt: Date.now(),
    manifestDigestSha256: 'f'.repeat(64),
  };
  return {
    operationId,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
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

function plan(status: DeploymentStoredPlanRecord['status'] = 'planned'): DeploymentStoredPlanRecord {
  const result = preflight('deployment-preflight:test');
  return {
    planId: `plan-${'c'.repeat(64)}`,
    planDigest: 'c'.repeat(64),
    runId: 'run-1',
    runRevision: status === 'planned' ? 1 : status === 'awaiting_approval' ? 2 : 3,
    status,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    approvalSummary: {
      schemaVersion: 2,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      operationKind: 'deploy',
      artifactReference: artifact().artifactReference!,
      frozen: {
        sourceRevision: result.planInput!.sourceRevision,
        target: {
          profileId: profile.id,
          profileUpdatedAt: 1,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          authMethod: 'password',
          jumpHost: null,
        },
        currentRelease: null,
        targetRelease: result.planInput!.targetRelease,
        rollbackRelease: null,
        preflight: result.planInput!.preflight,
      },
      remoteRoot: '/srv/api',
      composeProject: 'api',
      composeFiles: ['compose.yaml'],
      services: ['web'],
      actions: ['stage_release', 'prepare_release', 'load_image', 'compose_config', 'compose_pull', 'compose_up', 'verify_health', 'activate_release'],
      generatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };
}

function expectCardHeaderAction(cardTitle: string, actionName: string): void {
  const card = screen.getByText(cardTitle).closest<HTMLElement>('[data-slot="card"]');
  expect(card).not.toBeNull();
  expect(card).toHaveAttribute('data-variant', 'outline');
  expect(card).toHaveAttribute('data-radius', 'compact');
  const action = card!.querySelector<HTMLElement>('[data-slot="card-action"]');
  expect(action).not.toBeNull();
  expect(within(action!).getByRole('button', { name: actionName })).toBeInTheDocument();
  expect(card!.querySelector('[data-slot="card-footer"]')).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  mocks.capabilities.mockResolvedValue({
    schemaVersion: 1,
    admissionsEnabled: true,
    defaultEnabled: true,
    flagName: 'SHELLSPAN_DEPLOYMENT_CENTER_V1',
    source: 'default',
    readOnlyRecoveryAvailable: true,
    automaticReleaseCleanup: false,
  });
  mocks.snapshot.mockResolvedValue({ revision: 'a'.repeat(40), dirty: false });
  mocks.buildArtifact.mockImplementation(async ({ operationId }) => artifact(operationId));
  mocks.cancelArtifact.mockResolvedValue(true);
  mocks.listenArtifact.mockResolvedValue(vi.fn());
  mocks.cancelTransfer.mockResolvedValue(true);
  mocks.listenTransfer.mockResolvedValue(vi.fn());
  mocks.cancelRemote.mockResolvedValue(true);
  mocks.listenRemote.mockResolvedValue(vi.fn());
  mocks.startupRecovery.mockResolvedValue({ schemaVersion: 1, candidates: [] });
  mocks.cancelReconciliation.mockResolvedValue(true);
  useProfileStore.setState({ profiles: [profile], initialized: true });
  useDeploymentStore.setState({
    runtimeCapabilities: {
      schemaVersion: 1,
      admissionsEnabled: true,
      defaultEnabled: true,
      flagName: 'SHELLSPAN_DEPLOYMENT_CENTER_V1',
      source: 'default',
      readOnlyRecoveryAvailable: true,
      automaticReleaseCleanup: false,
    },
    workflows: [],
    selectedWorkflowId: null,
    profileFilterId: null,
    initialized: true,
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

describe('DeploymentCenter', () => {
  it('surfaces transient deployment errors as a toast instead of a page alert', async () => {
    useDeploymentStore.setState({ error: 'DEPLOYMENT_GENERIC_FAILURE' });
    render(<DeploymentCenter />);

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        variant: 'error',
        message: 'deployment.error.title\ndeployment.error.description',
      }),
    ]));
    expect(useDeploymentStore.getState().error).toBeNull();
    const main = document.querySelector<HTMLElement>('[data-slot="workbench-page-content"]');
    expect(within(main!).queryByText('deployment.error.title')).not.toBeInTheDocument();
  });

  it('keeps recovery and history readable while rollout disables new admissions', () => {
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
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
    });

    render(<DeploymentCenter />);

    expect(screen.getByText('deployment.rollout.disabledTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deployment.new' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.artifact.build' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.history.title' })).toBeEnabled();
  });

  it('opens run history in a dedicated dialog instead of occupying the main layout', async () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
    });
    render(<DeploymentCenter />);

    const main = document.querySelector<HTMLElement>('[data-slot="workbench-page-content"]');
    expect(main).not.toBeNull();
    expect(within(main!).queryByText('deployment.history.description')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'deployment.history.title' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('h-[min(36rem,calc(100vh-4rem))]', 'overflow-hidden');
    expect(within(dialog).getAllByText('deployment.history.description')).not.toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders the empty state and opens an accessible workflow form', async () => {
    mocks.create.mockResolvedValue(workflow);
    render(<DeploymentCenter />);
    expect(screen.getByText('deployment.empty')).toBeInTheDocument();
    expect(screen.getByLabelText('deployment.filter.profile')).toHaveTextContent(
      'deployment.filter.allProfiles',
    );
    expect(screen.getByLabelText('deployment.filter.profile')).not.toHaveTextContent(/^all$/);

    await userEvent.click(screen.getAllByRole('button', { name: 'deployment.new' })[0]!);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass(
      'flex',
      'h-[min(48rem,calc(100vh-2rem))]',
      'w-[calc(100%-2rem)]',
      'flex-col',
      'gap-0',
      'overflow-hidden',
      'p-0',
    );
    expect(dialog.querySelector('form')).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden');
    const scrollArea = dialog.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea).toHaveClass('min-h-0', 'flex-1');
    expect(scrollArea).not.toHaveClass('-mr-4');
    expect(scrollArea?.querySelector('[data-slot="field-group"]')).toHaveClass('px-4');
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).toHaveClass('shrink-0', 'p-4');
    expect(screen.getByRole('heading', { name: 'deployment.form.createTitle' })).toBeInTheDocument();
    expect(screen.getByLabelText('deployment.form.name')).toHaveFocus();
    expect(screen.getByLabelText('deployment.form.profile')).toHaveTextContent(
      'Production · deploy@example.test',
    );
    expect(screen.getByLabelText('deployment.form.profile')).not.toHaveTextContent(profile.id);
    expect(screen.getByLabelText('deployment.form.sourceDirectory')).toBeInTheDocument();
    expect(screen.getByLabelText('deployment.form.remoteRoot')).toHaveValue('/srv/shellspan/app');

    await userEvent.type(screen.getByLabelText('deployment.form.name'), 'API');
    await userEvent.type(screen.getByLabelText('deployment.form.sourceDirectory'), '/workspace/api');
    await userEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'API',
      definition: expect.objectContaining({
        sourceDirectory: '/workspace/api',
        build: expect.objectContaining({ context: '.', dockerfile: 'Dockerfile' }),
        target: expect.objectContaining({ connectionProfileId: profile.id }),
      }),
    })));
  });

  it('builds an artifact, runs preflight, and creates a plan that requires native approval', async () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
    });
    mocks.preflight.mockImplementation(async ({ operationId }) => preflight(operationId));
    mocks.createPlan.mockResolvedValue(plan());
    render(<DeploymentCenter />);

    expectCardHeaderAction('deployment.artifact.title', 'deployment.artifact.build');
    expectCardHeaderAction('deployment.preflight.title', 'deployment.preflight.run');
    await userEvent.click(screen.getByRole('button', { name: 'deployment.artifact.build' }));
    await waitFor(() => expect(screen.getByText('deployment.artifact.verified')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'deployment.preflight.run' }));

    await waitFor(() => expect(screen.getByText('deployment.preflight.check.docker')).toBeInTheDocument());
    expect(mocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: workflow.id,
      artifactReference: artifact().artifactReference,
    }));

    act(() => useDeploymentStore.setState({ artifactBuildResult: null }));
    await waitFor(() => expect(screen.getByText('deployment.plan.inputsChanged')).toBeInTheDocument());
    expectCardHeaderAction('deployment.plan.title', 'deployment.plan.create');
    expect(screen.getByRole('button', { name: 'deployment.plan.create' })).toBeDisabled();
    act(() => useDeploymentStore.setState({ artifactWorkflowId: workflow.id, artifactBuildResult: artifact() }));
    await userEvent.click(screen.getByRole('button', { name: 'deployment.plan.create' }));
    await waitFor(() => expect(screen.getByText(plan().planId)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'deployment.plan.requestApproval' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'deployment.execute.run' })).not.toBeInTheDocument();
  });

  it('shows artifact progress and exposes cancellation', async () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactBuildPhase: 'running',
      artifactBuildOperationId: 'deployment-artifact-build:fixture',
      artifactWorkflowId: workflow.id,
      artifactBuildProgress: {
        operationId: 'deployment-artifact-build:fixture',
        sequence: 4,
        step: 'savingImage',
        completedBytes: 1024,
        totalBytes: null,
        summary: 'bounded',
      },
    });
    render(<DeploymentCenter />);

    expect(screen.getByText('deployment.artifact.step.savingImage', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(mocks.cancelArtifact).toHaveBeenCalledWith('deployment-artifact-build:fixture');
  });

  it('shows the complete native approval summary and binds the user decision', async () => {
    const planned = plan('planned');
    const awaiting = { ...planned, status: 'awaiting_approval' as const, runRevision: 2 };
    const approved = { ...awaiting, status: 'approved' as const, runRevision: 3 };
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactWorkflowId: workflow.id,
      artifactBuildResult: artifact(),
      preflightWorkflowId: workflow.id,
      preflightResult: preflight('deployment-preflight:test'),
      plan: planned,
    });
    mocks.requestApproval.mockResolvedValue(awaiting);
    mocks.approvePlan.mockResolvedValue(approved);
    render(<DeploymentCenter />);

    await userEvent.click(screen.getByRole('button', { name: 'deployment.plan.requestApproval' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('deployment.approval.nativeOnly')).toBeInTheDocument();
    expect(within(dialog).getByText(planned.planDigest)).toBeInTheDocument();
    expect(within(dialog).getByText('deployment.plan.action.load_image')).toBeInTheDocument();
    expect(within(dialog).getByText(planned.approvalSummary.artifactReference!)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'deployment.approval.approve' }));
    await waitFor(() => expect(mocks.approvePlan).toHaveBeenCalledWith(expect.objectContaining({
      runId: planned.runId,
      runRevision: 2,
      expiresAt: planned.expiresAt,
    })));
  });

  it('shows preflight progress with a cancellable operation', async () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      preflightPhase: 'running',
      preflightOperationId: 'deployment-preflight:fixture',
      preflightWorkflowId: workflow.id,
    });
    mocks.cancel.mockResolvedValue(true);
    render(<DeploymentCenter />);

    expect(screen.getByText('deployment.preflight.running')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(mocks.cancel).toHaveBeenCalledWith('deployment-preflight:fixture');
  });

  it('blocks planned uploads, then shows resumable progress and a verified approved transfer', async () => {
    const approvedPlan = plan('approved');
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactWorkflowId: workflow.id,
      artifactBuildResult: artifact(),
      preflightWorkflowId: workflow.id,
      preflightResult: preflight('deployment-preflight:test'),
      plan: plan(),
    });
    const { rerender } = render(<DeploymentCenter />);
    expect(screen.getByText('deployment.transfer.approvalRequired')).toBeInTheDocument();
    expectCardHeaderAction('deployment.transfer.title', 'deployment.transfer.upload');
    expect(screen.getByRole('button', { name: 'deployment.transfer.upload' })).toBeDisabled();

    act(() => useDeploymentStore.setState({ plan: approvedPlan }));
    mocks.listenTransfer.mockImplementation(async (callback) => {
      const operationId = useDeploymentStore.getState().artifactTransferOperationId!;
      callback({
        event: 'deployment-artifact-transfer-progress',
        id: 1,
        payload: {
          operationId,
          sequence: 3,
          step: 'stageArchive',
          fileId: 'image.tar.zst',
          completedBytes: 512,
          totalBytes: 1024,
          summary: 'bounded',
        },
      });
      return vi.fn();
    });
    mocks.transferArtifact.mockImplementation(async (input) => ({
      operationId: input.operationId,
      planId: input.planId,
      releaseId: input.releaseId,
      remoteStagingIdentity: `deployment-staging-v1:${'c'.repeat(64)}:${'f'.repeat(64)}`,
      transferredBytes: 512,
      remoteDigestSha256: 'b'.repeat(64),
      status: 'succeeded',
      failure: null,
      reused: false,
      resumed: true,
    }));
    rerender(<DeploymentCenter />);
    await userEvent.click(screen.getByRole('button', { name: 'deployment.transfer.upload' }));
    await waitFor(() => expect(screen.getByText('deployment.transfer.verified')).toBeInTheDocument());
    expect(screen.getByText('deployment.transfer.resumed')).toBeInTheDocument();
    expect(useDeploymentStore.getState().artifactTransferProgress?.step).toBe('stageArchive');
    expect(mocks.transferArtifact).toHaveBeenCalledWith(expect.objectContaining({
      planId: approvedPlan.planId,
      artifactReference: artifact().artifactReference,
      remoteRoot: workflow.definition.target.remoteRoot,
    }));
    expect(screen.getByRole('button', { name: 'deployment.execute.run' })).toBeEnabled();
    expectCardHeaderAction('deployment.execute.title', 'deployment.execute.run');
  });

  it('immediately invalidates transfer eligibility when the target profile identity drifts', () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactWorkflowId: workflow.id,
      artifactBuildResult: artifact(),
      preflightWorkflowId: workflow.id,
      preflightResult: preflight('deployment-preflight:test'),
      plan: plan('approved'),
    });
    render(<DeploymentCenter />);
    expect(screen.getByRole('button', { name: 'deployment.transfer.upload' })).toBeEnabled();

    act(() => useProfileStore.setState({
      profiles: [{ ...profile, updatedAt: 2, host: 'changed.example.test' }],
    }));

    expect(screen.getByText('deployment.transfer.refreshRequired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deployment.transfer.upload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.history.createNewPlan' })).toBeEnabled();
  });

  it('announces long-running phases and keeps the workflow layout responsive by structure', () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactBuildPhase: 'running',
      artifactWorkflowId: workflow.id,
    });
    render(<DeploymentCenter />);

    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('deployment.announce.building');
    const responsiveGrid = [...document.querySelectorAll<HTMLElement>('div')]
      .find((element) => element.className.includes('@min-[64rem]:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]'));
    expect(responsiveGrid).toBeDefined();
    expect(responsiveGrid).toHaveClass('flex-1', 'items-stretch');
    expect(responsiveGrid).not.toHaveClass('lg:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]');
    expect(document.querySelector('[data-slot="workbench-page-content"]')).toHaveClass(
      'flex-1',
      'overflow-y-auto',
      '@min-[64rem]:overflow-hidden',
    );
    const workflowListCard = screen.getByText('deployment.workflows')
      .closest<HTMLElement>('[data-slot="card"]');
    expect(workflowListCard).toHaveClass('min-h-0', '@min-[64rem]:h-full');
    const workflowDetail = document.getElementById('deployment-release-workflow');
    expect(workflowDetail).toHaveClass('pr-4');
    expect(workflowDetail?.closest('[data-slot="scroll-area"]')).toHaveClass(
      '-mr-4',
      'min-h-0',
      'min-w-0',
      '@min-[64rem]:h-full',
    );
  });

  it('requires confirmation before deleting a workflow', async () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
    });
    mocks.remove.mockResolvedValue(undefined);
    render(<DeploymentCenter />);

    await userEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('deployment.delete.title');
    expect(screen.getByText(`deployment.delete.description:${workflow.name}`)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(workflow.id, workflow.revision));
  });

  it('shows startup recovery evidence requirements and disables deployment entry points', () => {
    useDeploymentStore.setState({
      workflows: [workflow],
      selectedWorkflowId: workflow.id,
      initialized: true,
      artifactWorkflowId: workflow.id,
      artifactBuildResult: artifact(),
      recoveryCandidates: [{
        runId: 'run-recovery',
        planId: `plan-${'c'.repeat(64)}`,
        planDigest: 'c'.repeat(64),
        status: 'state_unknown',
        lastEventSequence: 9,
        reconciliationRequired: true,
      }],
    });

    render(<DeploymentCenter />);

    expect(screen.getByText('deployment.recovery.title')).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('deployment.recovery.evidenceRequired')))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deployment.recovery.reconcile' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'deployment.artifact.rebuild' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'deployment.new' })).toBeDisabled();
  });
});
