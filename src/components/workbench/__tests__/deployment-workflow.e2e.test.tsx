import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import runbook from '../../../../docs/examples/deployment-runbook-v2.runbook.json';
import targetsFixture from '../../../../tests/fixtures/deployment-runbook/v2/multi-host-rollout.json';
import acceptanceFixture from '../../../../tests/fixtures/deployment-runbook/v2/ui-workflow-e2e.json';
import { DeploymentPanel } from '../deployment-panel';
import {
  applyDeploymentRolloutTargetResult,
  createDeploymentRolloutBatchApproval,
  createDeploymentRolloutState,
  normalizeDeploymentRolloutBatches,
  startDeploymentRolloutBatch,
} from '@/lib/deployment-rollout';
import * as tauri from '@/lib/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import type {
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewRequestV2,
  DeploymentExecutionReviewV2,
  RollbackExecutionResultV2,
  RollbackExecutionReviewV2,
} from '@/types/deployment-runbook';
import type {
  DeploymentRolloutBatchExecutionResultV2,
  DeploymentRolloutReviewRequestV2,
  DeploymentRolloutReviewV2,
} from '@/types/deployment-rollout';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

const originalEnsurePassword = useProfileStore.getState().ensurePassword;
const scenario = acceptanceFixture.scenarios.canaryFailureRollback;

function profiles(): ConnectionProfile[] {
  return targetsFixture.targets.slice(0, 3).map((target) => ({
    id: target.profileId,
    name: target.profileId.toUpperCase(),
    host: target.host,
    port: target.port,
    username: target.username,
    authMethod: 'key',
    privateKeyData: `private-material-${target.profileId}`,
    createdAt: 1,
    updatedAt: 1,
  }));
}

function childReview(
  request: DeploymentRolloutReviewRequestV2,
  profileId: string,
  index: number,
): DeploymentExecutionReviewV2 {
  const target = request.targets[index]!;
  return {
    schemaVersion: 2,
    reviewId: `deployment-review:${profileId}`,
    operationId: `deployment:e2e:${index}`,
    normalizedRunbookText: `${JSON.stringify(runbook, null, 2)}\n`,
    documentDigest: 'sha256-v1:document',
    planDigest: `sha256-v1:child-${index}`,
    deploymentId: runbook.deployment.id,
    applicationId: runbook.deployment.applicationId,
    environment: runbook.deployment.environment,
    version: runbook.deployment.version,
    artifactDigests: [],
    declaredRisk: 'stateChange',
    target: {
      profileId,
      host: target.connection.host,
      port: target.connection.port,
      username: target.connection.username,
      authMethod: target.connection.authMethod,
      identityDigest: `sha256-v1:target-${index}`,
    },
    policy: request.deploymentPolicy,
    actions: [],
    reviewedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function rolloutReview(request: DeploymentRolloutReviewRequestV2): DeploymentRolloutReviewV2 {
  const batches = normalizeDeploymentRolloutBatches(request.profileIds, request.policy).map((batch) => ({
    ...batch,
    batchDigest: `sha256-v1:batch-${batch.batchIndex}`,
  }));
  return {
    schemaVersion: 2,
    rolloutId: request.rolloutId,
    reviewId: 'rollout-review:e2e',
    normalizedRunbookText: `${JSON.stringify(runbook, null, 2)}\n`,
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:rollout-plan',
    deploymentId: runbook.deployment.id,
    applicationId: runbook.deployment.applicationId,
    environment: runbook.deployment.environment,
    version: runbook.deployment.version,
    declaredRisk: 'stateChange',
    policy: request.policy,
    deploymentPolicy: request.deploymentPolicy,
    profileIds: request.profileIds,
    targets: request.profileIds.map((profileId, index) => {
      const deploymentReview = childReview(request, profileId, index);
      return {
        targetIndex: index,
        batchIndex: batches.find((batch) => batch.targetIndexes.includes(index))!.batchIndex,
        profileId,
        environment: request.targets[index]!.environment,
        operationId: deploymentReview.operationId,
        target: deploymentReview.target,
        deploymentReview,
      };
    }),
    batches,
    reviewedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

function targetResult(review: DeploymentExecutionReviewV2, succeeded: boolean): DeploymentExecutionResultV2 {
  return {
    schemaVersion: 2,
    operationId: review.operationId,
    reviewId: review.reviewId,
    documentDigest: review.documentDigest,
    planDigest: review.planDigest,
    deploymentId: review.deploymentId,
    version: review.version,
    target: review.target,
    phase: succeeded ? 'succeeded' : 'failed',
    startedAt: 1,
    completedAt: 2,
    actions: [],
    healthChecks: [{
      checkId: 'api-http-health',
      kind: 'http',
      status: succeeded ? 'passed' : 'failed',
      attemptsUsed: 1,
      observedStatus: succeeded ? 200 : 503,
    }],
    rollbackSnapshot: {
      strategy: 'reactivatePreviousRelease',
      previousRelease: '/srv/acme-api/releases/acme-api-2.3.9',
      newRelease: runbook.release.releaseDirectory,
      releasesDirectory: runbook.release.releasesDirectory,
      activeSymlink: runbook.release.activeSymlink,
      activationChanged: true,
    },
    ...(succeeded ? {} : { errorCategory: 'healthCheck', error: 'fixture health failure' }),
  };
}

function singleReview(request: DeploymentExecutionReviewRequestV2): DeploymentExecutionReviewV2 {
  return {
    schemaVersion: 2,
    reviewId: 'deployment-review:single-e2e',
    operationId: request.operationId,
    normalizedRunbookText: request.runbookText,
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:single-plan',
    deploymentId: runbook.deployment.id,
    applicationId: runbook.deployment.applicationId,
    environment: runbook.deployment.environment,
    version: runbook.deployment.version,
    artifactDigests: [],
    declaredRisk: 'stateChange',
    target: {
      profileId: request.profileId,
      host: request.connection.host,
      port: request.connection.port,
      username: request.connection.username,
      authMethod: request.connection.authMethod,
      identityDigest: 'sha256-v1:single-target',
    },
    policy: request.policy,
    actions: [],
    reviewedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

describe('DeploymentPanel fixture E2E', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    act(() => useProfileStore.setState({ profiles: [], ensurePassword: originalEnsurePassword }));
  });

  it('runs the fixture single-host success path through review and explicit approval', async () => {
    expect(acceptanceFixture.scenarios.singleHostSuccess.deploymentPhase).toBe('succeeded');
    const fixtureProfiles = profiles();
    act(() => useProfileStore.setState({
      profiles: fixtureProfiles,
      ensurePassword: vi.fn(async (profile: ConnectionProfile) => profile),
    }));
    vi.spyOn(tauri, 'invokeListDeploymentRollouts').mockResolvedValue([]);
    vi.spyOn(tauri, 'invokeListDeploymentOperations').mockResolvedValue([]);
    vi.spyOn(tauri, 'invokeOpenDeploymentRunbookFile').mockResolvedValue({
      path: 'C:\\fixtures\\single-v2.json',
      text: `${JSON.stringify(runbook, null, 2)}\n`,
    });
    vi.spyOn(tauri, 'invokeReviewDeploymentExecution').mockImplementation(async (request) => (
      singleReview(request)
    ));
    const execute = vi.spyOn(tauri, 'invokeExecuteDeployment').mockImplementation(async (_request, review) => (
      targetResult(review, true)
    ));

    const { container } = render(<DeploymentPanel />);
    await waitFor(() => expect(screen.getByText('deployment.backend.available')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /deployment.import/ }));
    await waitFor(() => expect(screen.getByDisplayValue(runbook.deployment.applicationId)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /PROD-A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'deployment.review' }));
    await waitFor(() => expect(container.querySelector('[data-slot="deployment-review-summary"]')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'deployment.approval.reviewSingle' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(runbook.deployment.environment)).toBeInTheDocument();
    expect(within(dialog).getByText(runbook.deployment.version)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'deployment.approval.executeSingle' }));

    const result = await waitFor(() => {
      const value = container.querySelector('[data-slot="deployment-single-result"]');
      expect(value).toBeInTheDocument();
      return value!;
    });
    expect(within(result as HTMLElement).getByText('succeeded')).toBeInTheDocument();
    expect(within(result as HTMLElement).getByText('api-http-health')).toBeInTheDocument();
    expect(within(result as HTMLElement).getByText(acceptanceFixture.scenarios.singleHostSuccess.healthStatus)).toBeInTheDocument();
    expect(execute).toHaveBeenCalledOnce();
    expect(container.textContent).not.toMatch(/private-material-prod-[abc]/);
  });

  it('runs canary failure → circuit open → rollback suggestion → separate rollback approval without real SSH', async () => {
    expect(acceptanceFixture.transport).toBe('mocked-typed-ipc');
    const fixtureProfiles = profiles();
    act(() => useProfileStore.setState({
      profiles: fixtureProfiles,
      ensurePassword: vi.fn(async (profile: ConnectionProfile) => profile),
    }));
    vi.spyOn(tauri, 'invokeListDeploymentRollouts').mockResolvedValue([]);
    vi.spyOn(tauri, 'invokeListDeploymentOperations').mockResolvedValue([]);
    vi.spyOn(tauri, 'invokeOpenDeploymentRunbookFile').mockResolvedValue({
      path: 'C:\\fixtures\\canary-v2.json',
      text: `${JSON.stringify(runbook, null, 2)}\n`,
    });
    let reviewed: DeploymentRolloutReviewV2 | undefined;
    vi.spyOn(tauri, 'invokeReviewDeploymentRollout').mockImplementation(async (request) => {
      reviewed = rolloutReview(request);
      return reviewed;
    });
    vi.spyOn(tauri, 'invokeStartDeploymentRollout').mockImplementation(async (_request, review) => {
      let detail = createDeploymentRolloutState(review);
      detail = startDeploymentRolloutBatch(detail, createDeploymentRolloutBatchApproval(review, 0, {
        authorized: true,
        destructiveConfirmed: false,
      }));
      for (const [index, outcome] of scenario.canaryOutcomes.entries()) {
        detail = applyDeploymentRolloutTargetResult(
          detail,
          targetResult(review.targets[index]!.deploymentReview!, outcome === 'succeeded'),
        );
      }
      return {
        schemaVersion: 2,
        rolloutId: review.rolloutId,
        rolloutReviewId: review.reviewId,
        rolloutPlanDigest: review.planDigest,
        batchIndex: 0,
        batchDigest: review.batches[0]!.batchDigest,
        phase: detail.phase,
        circuitOpen: detail.circuitOpen,
        circuitReason: detail.circuitReason,
        targetResults: detail.targets.slice(0, 2).flatMap((target) => target.result ? [target.result] : []),
        detail,
      } satisfies DeploymentRolloutBatchExecutionResultV2;
    });
    const rollbackReview: RollbackExecutionReviewV2 = {
      schemaVersion: 2,
      reviewId: 'rollback-review:e2e',
      operationId: 'rollback:e2e',
      sourceOperationId: 'deployment:e2e:0',
      sourceReviewId: 'deployment-review:prod-a',
      sourcePhase: 'succeeded',
      documentDigest: 'sha256-v1:document',
      planDigest: 'sha256-v1:rollback-plan',
      deploymentId: runbook.deployment.id,
      applicationId: runbook.deployment.applicationId,
      environment: runbook.deployment.environment,
      version: runbook.deployment.version,
      currentRelease: runbook.release.releaseDirectory,
      previousRelease: '/srv/acme-api/releases/acme-api-2.3.9',
      releasesDirectory: runbook.release.releasesDirectory,
      activeSymlink: runbook.release.activeSymlink,
      snapshotCapturedAt: 2,
      declaredRisk: 'stateChange',
      target: reviewed?.targets[0]?.target ?? {
        profileId: 'prod-a', host: fixtureProfiles[0]!.host, port: 22, username: 'deploy', authMethod: 'key', identityDigest: 'sha256-v1:target-0',
      },
      totalTimeoutSeconds: 600,
      actions: [],
      reviewedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    vi.spyOn(tauri, 'invokeReviewRollbackExecution').mockResolvedValue(rollbackReview);
    vi.spyOn(tauri, 'invokeExecuteRollback').mockResolvedValue({
      schemaVersion: 2,
      operationId: rollbackReview.operationId,
      reviewId: rollbackReview.reviewId,
      sourceOperationId: rollbackReview.sourceOperationId,
      documentDigest: rollbackReview.documentDigest,
      planDigest: rollbackReview.planDigest,
      deploymentId: rollbackReview.deploymentId,
      version: rollbackReview.version,
      target: rollbackReview.target,
      phase: scenario.rollbackPhase as RollbackExecutionResultV2['phase'],
      startedAt: 3,
      completedAt: 4,
      actions: [],
      healthEvidence: [{ checkId: 'api-http-health', kind: 'http', status: 'passed', attemptsUsed: 1, observedStatus: 200 }],
      reactivation: {
        currentRelease: rollbackReview.currentRelease,
        previousRelease: rollbackReview.previousRelease,
        releasesDirectory: rollbackReview.releasesDirectory,
        activeSymlink: rollbackReview.activeSymlink,
        activationChanged: true,
      },
    } satisfies RollbackExecutionResultV2);

    const { container } = render(<DeploymentPanel />);
    await waitFor(() => expect(screen.getByText('deployment.backend.available')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /deployment.import/ }));
    await waitFor(() => expect(screen.getByDisplayValue(runbook.deployment.applicationId)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'deployment.mode.rollout' }));
    for (const profile of fixtureProfiles) {
      fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(profile.name) }));
    }
    fireEvent.change(screen.getByRole('spinbutton', { name: 'deployment.canaryCount' }), {
      target: { value: String(scenario.canaryCount) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'deployment.review' }));
    await waitFor(() => expect(container.querySelector('[data-slot="deployment-review-summary"]')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'deployment.approval.reviewCanary' }));
    let dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'deployment.approval.executeCanary' }));
    await waitFor(() => expect(screen.getByText('deployment.circuitOpen')).toBeInTheDocument());
    expect(screen.getByText('deployment.circuit.canaryFailed')).toBeInTheDocument();
    expect(screen.getByText('deployment.rollback.suggestions')).toBeInTheDocument();
    expect(screen.getByText('notStarted')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'deployment.rollback.review' }));
    dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('deployment.rollback.approvalTitle')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'deployment.rollback.execute' }));
    await waitFor(() => expect(container.querySelector('[data-slot="deployment-rollback-result"]')).toBeInTheDocument());
    expect(screen.getByText('deployment.rollback.completed')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/private-material-prod-[abc]/);
  });
});
