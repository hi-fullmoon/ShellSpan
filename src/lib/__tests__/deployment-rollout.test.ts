import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import runbook from '../../../docs/examples/deployment-runbook-v2.runbook.json';
import fixture from '../../../tests/fixtures/deployment-runbook/v2/multi-host-rollout.json';
import schema from '../../../protocol/runbook/v2/deployment-rollout.schema.json';
import {
  applyDeploymentRolloutTargetResult,
  cancelDeploymentRollout,
  createDeploymentRolloutBatchApproval,
  createDeploymentRolloutState,
  normalizeDeploymentRolloutBatches,
  recoverDeploymentRolloutState,
  sealInterruptedDeploymentRollout,
  startDeploymentRolloutBatch,
  validateDeploymentRolloutReviewRequest,
} from '@/lib/deployment-rollout';
import type { DeploymentExecutionResultV2, DeploymentExecutionReviewV2 } from '@/types/deployment-runbook';
import type {
  DeploymentRolloutPolicyV2,
  DeploymentRolloutReviewRequestV2,
  DeploymentRolloutReviewV2,
} from '@/types/deployment-rollout';

const deploymentPolicy = {
  artifactTimeoutSeconds: 30,
  maxArtifactBytes: 10_485_760,
  maxExpandedBytes: 52_428_800,
  maxArchiveEntries: 1_000,
  totalTimeoutSeconds: 600,
};

function request(): DeploymentRolloutReviewRequestV2 {
  return {
    rolloutId: 'rollout:fixture',
    runbookText: JSON.stringify(runbook),
    profileIds: [...fixture.profileIds],
    targets: fixture.targets.map((target) => ({
      profileId: target.profileId,
      environment: target.environment,
      connection: {
        host: target.host,
        port: target.port,
        username: target.username,
        authMethod: target.authMethod as 'key',
        keychainKeyId: `key-${target.profileId}`,
      },
    })),
    policy: structuredClone(fixture.policy) as DeploymentRolloutPolicyV2,
    deploymentPolicy,
  };
}

function childReview(profileId: string, index: number): DeploymentExecutionReviewV2 {
  const target = fixture.targets[index]!;
  return {
    schemaVersion: 2,
    reviewId: `deployment-review:${profileId}`,
    operationId: `deployment:rollout-fixture:${index}`,
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
      host: target.host,
      port: target.port,
      username: target.username,
      authMethod: target.authMethod,
      identityDigest: `sha256-v1:target-${index}`,
    },
    policy: deploymentPolicy,
    actions: [],
    reviewedAt: 100,
    expiresAt: 600_100,
  };
}

function review(policy: DeploymentRolloutPolicyV2 = request().policy): DeploymentRolloutReviewV2 {
  const batches = normalizeDeploymentRolloutBatches(fixture.profileIds, policy).map((batch) => ({
    ...batch,
    batchDigest: `sha256-v1:batch-${batch.batchIndex}`,
  }));
  return {
    schemaVersion: 2,
    rolloutId: 'rollout:fixture',
    reviewId: 'rollout-review:fixture',
    normalizedRunbookText: `${JSON.stringify(runbook, null, 2)}\n`,
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:rollout-plan',
    deploymentId: runbook.deployment.id,
    applicationId: runbook.deployment.applicationId,
    environment: runbook.deployment.environment,
    version: runbook.deployment.version,
    declaredRisk: 'stateChange',
    policy,
    deploymentPolicy,
    profileIds: [...fixture.profileIds],
    targets: fixture.profileIds.map((profileId, index) => ({
      targetIndex: index,
      batchIndex: batches.find((batch) => batch.targetIndexes.includes(index))!.batchIndex,
      profileId,
      environment: 'production',
      operationId: `deployment:rollout-fixture:${index}`,
      target: childReview(profileId, index).target,
      deploymentReview: childReview(profileId, index),
    })),
    batches,
    reviewedAt: 100,
    expiresAt: 600_100,
  };
}

function result(reviewed: DeploymentExecutionReviewV2, succeeded = true): DeploymentExecutionResultV2 {
  return {
    schemaVersion: 2,
    operationId: reviewed.operationId,
    reviewId: reviewed.reviewId,
    documentDigest: reviewed.documentDigest,
    planDigest: reviewed.planDigest,
    deploymentId: reviewed.deploymentId,
    version: reviewed.version,
    target: reviewed.target,
    phase: succeeded ? 'succeeded' : 'failed',
    startedAt: 200,
    completedAt: 300,
    actions: [],
    healthChecks: [{
      checkId: 'health', kind: 'service', status: succeeded ? 'passed' : 'failed', attemptsUsed: 1,
    }],
    rollbackSnapshot: {
      strategy: 'reactivatePreviousRelease',
      previousRelease: '/srv/acme-api/releases/previous',
      newRelease: runbook.release.releaseDirectory,
      releasesDirectory: runbook.release.releasesDirectory,
      activeSymlink: runbook.release.activeSymlink,
      activationChanged: true,
      capturedAt: 250,
    },
    ...(succeeded ? {} : { errorCategory: 'healthCheck', error: 'health failed' }),
  };
}

function runBatch(
  state: ReturnType<typeof createDeploymentRolloutState>,
  rolloutReview: DeploymentRolloutReviewV2,
  outcomes: boolean[],
) {
  const batchIndex = state.currentBatchIndex!;
  let next = startDeploymentRolloutBatch(
    state,
    createDeploymentRolloutBatchApproval(rolloutReview, batchIndex, {
      authorized: true,
      destructiveConfirmed: false,
    }),
    200 + batchIndex,
  );
  const batch = rolloutReview.batches[batchIndex]!;
  for (let index = 0; index < outcomes.length; index += 1) {
    const target = rolloutReview.targets[batch.targetIndexes[index]!]!;
    next = applyDeploymentRolloutTargetResult(next, result(target.deploymentReview!, outcomes[index]), 300 + index);
  }
  return next;
}

describe('Deployment rollout v2 deterministic coordinator', () => {
  it('accepts only explicit ordered profile targets and normalizes canary plus rolling batches', () => {
    expect(validateDeploymentRolloutReviewRequest(request()).map((batch) => batch.profileIds))
      .toEqual([['prod-a'], ['prod-b', 'prod-c'], ['prod-d', 'prod-e']]);
    expect(() => validateDeploymentRolloutReviewRequest({
      ...request(),
      targets: request().targets.map((target, index) => index === 1
        ? { ...target, profileId: 'prod-c' }
        : target),
    })).toThrow(/order/);
    expect(() => validateDeploymentRolloutReviewRequest({
      ...request(),
      targets: request().targets.map((target, index) => index === 1
        ? { ...target, connection: request().targets[0]!.connection }
        : target),
    })).toThrow(/duplicate host/);
    expect(() => validateDeploymentRolloutReviewRequest({
      ...request(),
      targets: request().targets.map((target, index) => index === 1
        ? { ...target, environment: 'staging' }
        : target),
    })).toThrow(/mixes environment/);
  });

  it('publishes a strict structural schema for the rollout review boundary', () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const valid = request();
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    const dynamic = { ...valid, discovery: { tag: 'production' } };
    expect(validate(dynamic)).toBe(false);
    const noGate = { ...valid, policy: { ...valid.policy, requireBatchApproval: false } };
    expect(validate(noGate)).toBe(false);
  });

  it('passes a healthy canary and stops at the next manual batch gate', () => {
    const rolloutReview = review();
    const state = runBatch(createDeploymentRolloutState(rolloutReview, 100), rolloutReview, [true]);
    expect(state.phase).toBe('awaitingBatchApproval');
    expect(state.currentBatchIndex).toBe(1);
    expect(state.batches[0]?.health).toMatchObject({ healthy: 1, failed: 0, thresholdMet: true });
    expect(state.targets.filter((target) => target.status === 'running')).toHaveLength(0);
  });

  it('trips the canary circuit and produces only separately approved rollback suggestions', () => {
    const rolloutReview = review({ ...request().policy, canary: { mode: 'count', value: 2 } });
    const state = runBatch(createDeploymentRolloutState(rolloutReview), rolloutReview, [true, false]);
    expect(state).toMatchObject({ phase: 'paused', circuitOpen: true, circuitReason: 'canaryFailed' });
    expect(state.targets.slice(2).every((target) => target.status === 'notStarted')).toBe(true);
    expect(state.rollbackSuggestions).toEqual([expect.objectContaining({
      profileId: 'prod-a', requiresSeparateApproval: true,
    })]);
  });

  it('honors maxParallel and allows a rolling batch within the reviewed thresholds', () => {
    const policy: DeploymentRolloutPolicyV2 = {
      ...request().policy,
      canary: { mode: 'count', value: 1 },
      batchSize: 3,
      maxParallel: 1,
      minHealthyPercent: 66,
      maxFailuresPerBatch: 1,
    };
    const rolloutReview = review(policy);
    let state = runBatch(createDeploymentRolloutState(rolloutReview), rolloutReview, [true]);
    const approval = createDeploymentRolloutBatchApproval(rolloutReview, 1, {
      authorized: true, destructiveConfirmed: false,
    });
    state = startDeploymentRolloutBatch(state, approval, 400);
    expect(state.targets.filter((target) => target.status === 'running')).toHaveLength(1);
    for (const [offset, succeeded] of [true, true, false].entries()) {
      const target = rolloutReview.targets[rolloutReview.batches[1]!.targetIndexes[offset]!]!;
      state = applyDeploymentRolloutTargetResult(state, result(target.deploymentReview!, succeeded), 500 + offset);
      expect(state.targets.filter((entry) => entry.status === 'running').length).toBeLessThanOrEqual(1);
    }
    expect(state.phase).toBe('awaitingBatchApproval');
    expect(state.batches[1]?.health).toMatchObject({ healthy: 2, failed: 1, thresholdMet: true });
  });

  it('fails closed on threshold breach, approval drift, and late cross-batch results', () => {
    const rolloutReview = review();
    let state = runBatch(createDeploymentRolloutState(rolloutReview), rolloutReview, [true]);
    const changedApproval = {
      ...createDeploymentRolloutBatchApproval(rolloutReview, 1, { authorized: true, destructiveConfirmed: false }),
      batchDigest: 'sha256-v1:changed',
    };
    expect(startDeploymentRolloutBatch(state, changedApproval).circuitReason).toBe('approvalMismatch');

    state = startDeploymentRolloutBatch(state, createDeploymentRolloutBatchApproval(
      rolloutReview, 1, { authorized: true, destructiveConfirmed: false },
    ));
    const late = result(rolloutReview.targets[0]!.deploymentReview!);
    expect(applyDeploymentRolloutTargetResult(state, late).circuitReason).toBe('lateResult');

    state = runBatch(runBatch(createDeploymentRolloutState(rolloutReview), rolloutReview, [true]), rolloutReview, [false, false]);
    expect(state.circuitReason).toBe('failureThreshold');
  });

  it('cancels without rollback and seals restart ambiguity without replaying pending hosts', () => {
    const rolloutReview = review();
    let state = startDeploymentRolloutBatch(
      createDeploymentRolloutState(rolloutReview),
      createDeploymentRolloutBatchApproval(rolloutReview, 0, { authorized: true, destructiveConfirmed: false }),
    );
    const cancelled = cancelDeploymentRollout(state, 500);
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.targets.every((target) => target.status === 'cancelled')).toBe(true);

    const sealed = sealInterruptedDeploymentRollout(state, 600);
    expect(sealed).toMatchObject({ phase: 'recoveryRequired', recoveryRequired: true });
    expect(sealed.targets[0]?.status).toBe('interrupted');
    expect(sealed.targets.slice(1).every((target) => target.status === 'notStarted')).toBe(true);
  });

  it('requires a fresh recovery review and never redeploys completed targets', () => {
    const rolloutReview = review({ ...request().policy, canary: { mode: 'count', value: 2 } });
    let state = startDeploymentRolloutBatch(
      createDeploymentRolloutState(rolloutReview),
      createDeploymentRolloutBatchApproval(rolloutReview, 0, { authorized: true, destructiveConfirmed: false }),
    );
    state = applyDeploymentRolloutTargetResult(state, result(rolloutReview.targets[0]!.deploymentReview!), 300);
    const sealed = sealInterruptedDeploymentRollout(state, 400);
    const recoveryReview = review(rolloutReview.policy);
    recoveryReview.reviewId = 'rollout-review:recovery';
    recoveryReview.recoveryOfReviewId = rolloutReview.reviewId;
    recoveryReview.targets[0] = {
      ...recoveryReview.targets[0]!,
      deploymentReview: undefined,
      completedOperationId: rolloutReview.targets[0]!.operationId,
    };
    const recovered = recoverDeploymentRolloutState(sealed, recoveryReview, 500);
    expect(recovered.targets[0]).toMatchObject({ status: 'succeeded', deploymentReview: undefined });
    expect(recovered.targets[1]).toMatchObject({ status: 'notStarted' });
    expect(recovered.phase).toBe('awaitingCanaryApproval');
    expect(createDeploymentRolloutBatchApproval(recoveryReview, 0, {
      authorized: true,
      destructiveConfirmed: false,
    }).targetApprovals.map((approval) => approval.profileId)).toEqual(['prod-b']);
  });
});
