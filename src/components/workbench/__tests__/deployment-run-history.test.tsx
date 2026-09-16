import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentRunHistory } from '../deployment-run-history';
import type {
  DeploymentRunDetail,
  DeploymentRunRecord,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import { useDeploymentStore } from '@/stores/deploymentStore';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';

const ipc = vi.hoisted(() => ({
  exportAudit: vi.fn(),
  getDetail: vi.fn(),
  listPage: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeGetDeploymentRunDetail: ipc.getDetail,
  invokeExportDeploymentRunAudit: ipc.exportAudit,
  invokeListDeploymentRunPage: ipc.listPage,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
    ready: true,
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
  updatedAt: 7,
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
      imageRepository: 'example.test/api',
      compression: 'zstd',
    },
    target: { connectionProfileId: profile.id, remoteRoot: '/srv/api' },
    compose: { projectName: 'api', files: ['compose.yaml'], services: ['web'], pullBeforeUp: true },
    healthCheck: null,
    reloadNginxAfterHealthy: false,
    releasesToKeep: 3,
  },
};

function run(status: DeploymentRunRecord['status']): DeploymentRunRecord {
  return {
    id: `run-${status}`,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    sourceRunId: null,
    operationKind: 'deploy',
    triggerKind: 'manual',
    status,
    approvalDigest: 'd'.repeat(64),
    reconciliationRequired: status === 'state_unknown',
    lastEventSequence: 2,
    createdAt: 1,
    updatedAt: 3,
    startedAt: 2,
    finishedAt: status === 'failed' ? 3 : null,
    approvalSummary: {
      schemaVersion: 2,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      operationKind: 'deploy',
      artifactReference: `deployment-artifact-v1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      frozen: {
        sourceRevision: { revision: 'a'.repeat(40), dirty: false },
        target: {
          profileId: profile.id,
          profileUpdatedAt: profile.updatedAt,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          authMethod: 'password',
          jumpHost: null,
        },
        currentRelease: { releaseId: 'release-1', artifactDigestSha256: '1'.repeat(64) },
        targetRelease: { releaseId: 'release-2', artifactDigestSha256: '2'.repeat(64) },
        rollbackRelease: { releaseId: 'release-1', artifactDigestSha256: '1'.repeat(64) },
        preflight: { checkedAt: 1, checks: [] },
      },
      remoteRoot: '/srv/api',
      composeProject: 'api',
      composeFiles: ['compose.yaml'],
      services: ['web'],
      actions: ['stage_release', 'compose_up', 'activate_release'],
      generatedAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  };
}

function detail(record: DeploymentRunRecord): DeploymentRunDetail {
  return {
    run: record,
    nextBeforeSequence: null,
    events: [
      {
        runId: record.id,
        sequence: 1,
        eventKind: 'run_created',
        status: 'planned',
        summary: 'Created from frozen inputs',
        payload: null,
        recordedAt: 1,
      },
      {
        runId: record.id,
        sequence: 2,
        eventKind: record.status === 'failed' ? 'run_failed' : 'status_changed',
        status: record.status,
        summary: 'Bounded durable result',
        payload: { failureCategory: 'healthCheckFailed', reconciliationRequired: record.reconciliationRequired },
        recordedAt: 3,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useProfileStore.setState({ profiles: [profile], initialized: true });
  useDeploymentStore.setState({
    workflows: [workflow],
    selectedWorkflowId: workflow.id,
    runs: [],
    runsLoading: false,
    runsLoadingMore: false,
    runsError: null,
    runsNextCursor: null,
    selectedRunId: null,
    runDetail: null,
    runDetailLoading: false,
    navigationTarget: null,
    recoveryCandidates: [],
    recoveredApprovedBinding: null,
    plan: null,
  });
});

describe('DeploymentRunHistory', () => {
  it('surfaces history loading failures as a toast instead of an inline alert', async () => {
    useDeploymentStore.setState({ runsError: 'RUN_HISTORY_LOAD_FAILED' });
    render(<DeploymentRunHistory />);

    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        variant: 'error',
        message: 'deployment.history.loadFailed\nRUN_HISTORY_LOAD_FAILED',
      }),
    ]));
    expect(useDeploymentStore.getState().runsError).toBeNull();
    expect(screen.queryByText('deployment.history.loadFailed')).not.toBeInTheDocument();
  });

  it('renders repository-backed details, bounded evidence, and responsive list structure', () => {
    const failed = run('failed');
    useDeploymentStore.setState({
      runs: [failed],
      selectedRunId: failed.id,
      runDetail: detail(failed),
    });
    render(<DeploymentRunHistory />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText('release-1 → release-2')).toHaveLength(2);
    expect(screen.getByText('Bounded durable result')).toBeInTheDocument();
    expect(screen.getByText(/failureCategory: healthCheckFailed/)).toBeInTheDocument();
    expect(screen.getByLabelText('deployment.history.list')).toHaveClass(
      'sm:grid-cols-2',
      'xl:grid-cols-3',
    );
  });

  it('exports the exact selected run through the typed native boundary', async () => {
    const failed = run('failed');
    ipc.exportAudit.mockResolvedValue({
      schemaVersion: 1,
      runId: failed.id,
      saved: true,
      bytes: 1024,
      documentSha256: 'a'.repeat(64),
    });
    useDeploymentStore.setState({
      runs: [failed],
      selectedRunId: failed.id,
      runDetail: detail(failed),
    });
    render(<DeploymentRunHistory />);

    await userEvent.click(screen.getByRole('button', { name: 'deployment.history.exportAudit' }));

    await waitFor(() => expect(ipc.exportAudit).toHaveBeenCalledWith(failed.id));
  });

  it('prioritizes recovery for state_unknown and exposes no re-execute or new-plan action', () => {
    const unknown = run('state_unknown');
    useDeploymentStore.setState({
      runs: [unknown],
      selectedRunId: unknown.id,
      runDetail: detail(unknown),
      recoveryCandidates: [{
        runId: unknown.id,
        planId: `plan-${unknown.approvalDigest}`,
        planDigest: unknown.approvalDigest,
        status: 'state_unknown',
        lastEventSequence: unknown.lastEventSequence,
        reconciliationRequired: true,
      }],
    });
    render(<DeploymentRunHistory />);

    expect(screen.getByText('deployment.history.next.reconcile')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'deployment.history.createNewPlan' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deployment.recovery.open' })).toBeInTheDocument();
  });

  it('starts a clean new-plan flow after failure without reusing the old approval', async () => {
    const failed = run('failed');
    useDeploymentStore.setState({
      runs: [failed],
      selectedRunId: failed.id,
      runDetail: detail(failed),
      plan: {
        planId: `plan-${failed.approvalDigest}`,
        planDigest: failed.approvalDigest,
        runId: failed.id,
        runRevision: 2,
        status: 'failed',
        approvalSummary: failed.approvalSummary,
        createdAt: failed.createdAt,
        expiresAt: failed.approvalSummary.expiresAt,
      },
    });
    render(<DeploymentRunHistory />);

    await userEvent.click(screen.getByRole('button', { name: 'deployment.history.createNewPlan' }));
    expect(useDeploymentStore.getState()).toMatchObject({
      selectedWorkflowId: workflow.id,
      selectedRunId: null,
      runDetail: null,
      plan: null,
      navigationTarget: 'newRelease',
    });
  });

  it('paginates durable runs and returns keyboard focus after closing details', async () => {
    const failed = run('failed');
    const succeeded = { ...run('succeeded'), id: 'run-succeeded-next', finishedAt: 4 };
    ipc.listPage.mockResolvedValue({ items: [succeeded], nextCursor: null });
    ipc.getDetail.mockResolvedValue(detail(failed));
    useDeploymentStore.setState({ runs: [failed], runsNextCursor: '1:run-failed' });
    render(<DeploymentRunHistory />);

    await userEvent.click(screen.getByRole('button', { name: 'deployment.history.loadMore' }));
    await waitFor(() => expect(screen.getByText('run-succeeded-next')).toBeInTheDocument());
    expect(ipc.listPage).toHaveBeenCalledWith(null, '1:run-failed', 50);

    const trigger = screen.getAllByRole('button', { name: /API/ })[0]!;
    trigger.focus();
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const close = screen.getAllByRole('button', { name: 'common.close' })
      .find((button) => button.getAttribute('data-slot') !== 'dialog-close');
    expect(close).toBeDefined();
    await userEvent.click(close!);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
