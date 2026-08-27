import { parseDeploymentRunbookV2Text } from '@/lib/deployment-runbook';
import { deploymentExecutionResultMatchesReview } from '@/lib/deployment-execution';
import type {
  DeploymentRolloutBatchApprovalV2,
  DeploymentRolloutBatchExecutionResultV2,
  DeploymentRolloutBatchPlanV2,
  DeploymentRolloutCircuitReasonV2,
  DeploymentRolloutDetailV2,
  DeploymentRolloutPolicyV2,
  DeploymentRolloutRollbackSuggestionV2,
  DeploymentRolloutReviewRequestV2,
  DeploymentRolloutReviewV2,
  DeploymentRolloutTargetApprovalV2,
} from '@/types/deployment-rollout';
import type { DeploymentExecutionResultV2 } from '@/types/deployment-runbook';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(message: string): never {
  throw new Error(`Deployment rollout v2: ${message}`);
}

function exactKeys(value: object, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${field}.${key} is not supported`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${field}.${key} is required`);
  }
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function validatePolicy(policy: DeploymentRolloutPolicyV2, targetCount: number): void {
  exactKeys(policy, [
    'strategy', 'canary', 'batchSize', 'maxParallel', 'requireBatchApproval',
    'minHealthyPercent', 'maxFailuresPerBatch', 'stopPolicy', 'rollbackSuggestion',
  ], 'policy');
  if (policy.strategy !== 'canaryRolling') fail('policy.strategy must be canaryRolling');
  if (policy.stopPolicy !== 'pause') fail('policy.stopPolicy must be pause');
  if (!['none', 'successfulTargets'].includes(policy.rollbackSuggestion)) {
    fail('policy.rollbackSuggestion is invalid');
  }
  if (policy.requireBatchApproval !== true) {
    fail('policy.requireBatchApproval must be true in phase 4');
  }
  exactKeys(policy.canary, ['mode', 'value'], 'policy.canary');
  if (policy.canary.mode === 'count') {
    boundedInteger(policy.canary.value, 'policy.canary.value', 1, targetCount - 1);
  } else if (policy.canary.mode === 'percentage') {
    boundedInteger(policy.canary.value, 'policy.canary.value', 1, 99);
  } else {
    fail('policy.canary.mode must be count or percentage');
  }
  const batchSize = boundedInteger(policy.batchSize, 'policy.batchSize', 1, 100);
  const maxParallel = boundedInteger(policy.maxParallel, 'policy.maxParallel', 1, 32);
  if (maxParallel > batchSize) fail('policy.maxParallel cannot exceed policy.batchSize');
  boundedInteger(policy.minHealthyPercent, 'policy.minHealthyPercent', 1, 100);
  boundedInteger(policy.maxFailuresPerBatch, 'policy.maxFailuresPerBatch', 0, batchSize);
}

export function deploymentRolloutCanaryCount(
  targetCount: number,
  policy: DeploymentRolloutPolicyV2,
): number {
  validatePolicy(policy, targetCount);
  return policy.canary.mode === 'count'
    ? policy.canary.value
    : Math.min(targetCount - 1, Math.max(1, Math.ceil(targetCount * policy.canary.value / 100)));
}

export function normalizeDeploymentRolloutBatches(
  profileIds: readonly string[],
  policy: DeploymentRolloutPolicyV2,
): Array<Omit<DeploymentRolloutBatchPlanV2, 'batchDigest'>> {
  const canaryCount = deploymentRolloutCanaryCount(profileIds.length, policy);
  const batches: Array<Omit<DeploymentRolloutBatchPlanV2, 'batchDigest'>> = [];
  for (let start = 0; start < profileIds.length;) {
    const batchIndex = batches.length;
    const size = batchIndex === 0 ? canaryCount : policy.batchSize;
    const end = Math.min(profileIds.length, start + size);
    const ids = profileIds.slice(start, end);
    const requiredHealthy = batchIndex === 0
      ? ids.length
      : Math.ceil(ids.length * policy.minHealthyPercent / 100);
    batches.push({
      batchIndex,
      kind: batchIndex === 0 ? 'canary' : 'rolling',
      profileIds: [...ids],
      targetIndexes: Array.from({ length: ids.length }, (_, index) => start + index),
      requiredHealthy,
      maximumFailures: batchIndex === 0 ? 0 : Math.min(policy.maxFailuresPerBatch, ids.length),
      approvalRequired: batchIndex === 0 || policy.requireBatchApproval,
    });
    start = end;
  }
  return batches;
}

export function validateDeploymentRolloutReviewRequest(
  request: DeploymentRolloutReviewRequestV2,
): ReturnType<typeof normalizeDeploymentRolloutBatches> {
  exactKeys(request, [
    'rolloutId', 'runbookText', 'profileIds', 'targets', 'policy', 'deploymentPolicy',
  ], 'request');
  if (!ID_PATTERN.test(request.rolloutId)) fail('rolloutId is invalid');
  if (!Array.isArray(request.profileIds) || request.profileIds.length < 2 || request.profileIds.length > 500) {
    fail('profileIds must contain from 2 to 500 explicit targets');
  }
  if (!Array.isArray(request.targets) || request.targets.length !== request.profileIds.length) {
    fail('targets must map one-to-one to profileIds');
  }
  const document = parseDeploymentRunbookV2Text(request.runbookText);
  const profileIds = new Set<string>();
  const hosts = new Set<string>();
  request.profileIds.forEach((profileId, index) => {
    if (!ID_PATTERN.test(profileId)) fail(`profileIds[${index}] is invalid`);
    if (profileIds.has(profileId)) fail(`duplicate profile ${profileId}`);
    profileIds.add(profileId);
    const target = request.targets[index];
    if (!target || target.profileId !== profileId) fail(`targets[${index}] order does not match profileIds`);
    exactKeys(target, ['profileId', 'environment', 'connection'], `targets[${index}]`);
    if (target.environment !== document.deployment.environment) {
      fail(`targets[${index}] mixes environment ${target.environment}`);
    }
    const connection = target.connection;
    const hostIdentity = `${connection.host}\u0000${connection.port}\u0000${connection.username}`;
    if (hosts.has(hostIdentity)) fail(`duplicate host at targets[${index}]`);
    hosts.add(hostIdentity);
  });
  return normalizeDeploymentRolloutBatches(request.profileIds, request.policy);
}

export function createDeploymentRolloutBatchApproval(
  review: DeploymentRolloutReviewV2,
  batchIndex: number,
  options: { authorized: boolean; destructiveConfirmed: boolean },
): DeploymentRolloutBatchApprovalV2 {
  const batch = review.batches[batchIndex];
  if (!batch) fail(`batch ${batchIndex} does not exist`);
  const targetApprovals = batch.targetIndexes.flatMap((targetIndex): DeploymentRolloutTargetApprovalV2[] => {
    const target = review.targets[targetIndex];
    if (!target?.deploymentReview) return [];
    const child = target.deploymentReview;
    return [{
      profileId: target.profileId,
      batchIndex,
      targetIndex,
      reviewId: child.reviewId,
      operationId: child.operationId,
      documentDigest: child.documentDigest,
      planDigest: child.planDigest,
      targetDigest: child.target.identityDigest,
      approvedRisk: child.declaredRisk,
      authorized: options.authorized,
      destructiveConfirmed: options.destructiveConfirmed,
    }];
  });
  return {
    rolloutId: review.rolloutId,
    rolloutReviewId: review.reviewId,
    rolloutPlanDigest: review.planDigest,
    batchIndex,
    batchDigest: batch.batchDigest,
    targetApprovals,
    authorized: options.authorized,
    destructiveConfirmed: options.destructiveConfirmed,
  };
}

export function deploymentRolloutBatchResultMatchesReview(
  review: DeploymentRolloutReviewV2,
  result: DeploymentRolloutBatchExecutionResultV2,
): boolean {
  const batch = review.batches[result.batchIndex];
  if (!batch
    || result.schemaVersion !== 2
    || result.rolloutId !== review.rolloutId
    || result.rolloutReviewId !== review.reviewId
    || result.rolloutPlanDigest !== review.planDigest
    || result.batchDigest !== batch.batchDigest
    || result.detail.rolloutId !== review.rolloutId
    || result.detail.reviewId !== review.reviewId
    || result.detail.planDigest !== review.planDigest) return false;
  if (result.targetResults.length > batch.profileIds.length) return false;
  const expected = new Map(batch.targetIndexes.map((index) => {
    const target = review.targets[index]!;
    return [target.operationId, target] as const;
  }));
  return result.targetResults.every((targetResult) => {
    const target = expected.get(targetResult.operationId);
    return Boolean(target?.deploymentReview
      && target.batchIndex === result.batchIndex
      && deploymentExecutionResultMatchesReview(target.deploymentReview, targetResult));
  });
}

export function requireDeploymentRolloutBatchResultIdentity(
  review: DeploymentRolloutReviewV2,
  result: DeploymentRolloutBatchExecutionResultV2,
): DeploymentRolloutBatchExecutionResultV2 {
  if (!deploymentRolloutBatchResultMatchesReview(review, result)) {
    fail('result identity does not match the exact rollout review, plan, batch, and targets');
  }
  return result;
}

function emptyHealth(total: number) {
  return { total, healthy: 0, failed: 0, healthyPercent: 0, thresholdMet: false };
}

export function createDeploymentRolloutState(
  review: DeploymentRolloutReviewV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  if (review.batches.length === 0 || review.targets.length !== review.profileIds.length) {
    fail('review has an invalid or empty normalized plan');
  }
  return {
    rolloutId: review.rolloutId,
    reviewId: review.reviewId,
    planDigest: review.planDigest,
    deploymentId: review.deploymentId,
    applicationId: review.applicationId,
    environment: review.environment,
    version: review.version,
    phase: 'awaitingCanaryApproval',
    currentBatchIndex: 0,
    circuitOpen: false,
    recoveryRequired: false,
    totalTargets: review.targets.length,
    succeededTargets: 0,
    failedTargets: 0,
    notStartedTargets: review.targets.length,
    createdAt: now,
    updatedAt: now,
    review,
    policy: review.policy,
    batches: review.batches.map((batch, index) => ({
      ...batch,
      status: index === 0 ? 'awaitingApproval' : 'pending',
      health: emptyHealth(batch.profileIds.length),
    })),
    targets: review.targets.map((target) => ({
      ...target,
      status: target.completedOperationId ? 'succeeded' : 'notStarted',
      recoveryRequired: false,
    })),
    rollbackSuggestions: [],
  };
}

function approvalMatchesBatch(
  detail: DeploymentRolloutDetailV2,
  approval: DeploymentRolloutBatchApprovalV2,
): boolean {
  const batch = detail.batches[approval.batchIndex];
  if (!batch
    || approval.rolloutId !== detail.rolloutId
    || approval.rolloutReviewId !== detail.reviewId
    || approval.rolloutPlanDigest !== detail.planDigest
    || approval.batchDigest !== batch.batchDigest
    || !approval.authorized) return false;
  const pendingIndexes = batch.targetIndexes.filter((targetIndex) => (
    detail.targets[targetIndex]?.deploymentReview !== undefined
  ));
  if (approval.targetApprovals.length !== pendingIndexes.length) return false;
  return pendingIndexes.every((targetIndex, index) => {
    const target = detail.targets[targetIndex];
    const child = target?.deploymentReview;
    const targetApproval = approval.targetApprovals[index];
    return Boolean(target && child && targetApproval
      && target.status === 'notStarted'
      && targetApproval.profileId === target.profileId
      && targetApproval.batchIndex === batch.batchIndex
      && targetApproval.targetIndex === targetIndex
      && targetApproval.operationId === child.operationId
      && targetApproval.reviewId === child.reviewId
      && targetApproval.documentDigest === child.documentDigest
      && targetApproval.planDigest === child.planDigest
      && targetApproval.targetDigest === child.target.identityDigest
      && targetApproval.approvedRisk === child.declaredRisk
      && targetApproval.authorized
      && targetApproval.destructiveConfirmed === approval.destructiveConfirmed);
  });
}

function recount(detail: DeploymentRolloutDetailV2): DeploymentRolloutDetailV2 {
  return {
    ...detail,
    succeededTargets: detail.targets.filter((target) => target.status === 'succeeded').length,
    failedTargets: detail.targets.filter((target) => (
      target.status === 'failed' || target.status === 'cancelled' || target.status === 'interrupted'
    )).length,
    notStartedTargets: detail.targets.filter((target) => target.status === 'notStarted').length,
  };
}

function rollbackSuggestions(detail: DeploymentRolloutDetailV2): DeploymentRolloutRollbackSuggestionV2[] {
  if (detail.policy.rollbackSuggestion !== 'successfulTargets') return [];
  return detail.targets.flatMap((target) => target.status === 'succeeded' && target.result
    ? [{
        profileId: target.profileId,
        targetDigest: target.target.identityDigest,
        sourceOperationId: target.result.operationId,
        reason: 'rolloutCircuitOpen' as const,
        requiresSeparateApproval: true as const,
      }]
    : []);
}

function tripRolloutCircuit(
  detail: DeploymentRolloutDetailV2,
  reason: DeploymentRolloutCircuitReasonV2,
  now: number,
): DeploymentRolloutDetailV2 {
  const next = recount({
    ...detail,
    phase: reason === 'recoveryRequired' ? 'recoveryRequired' : 'paused',
    circuitOpen: true,
    circuitReason: reason,
    recoveryRequired: reason === 'recoveryRequired' || detail.recoveryRequired,
    updatedAt: now,
  });
  return { ...next, rollbackSuggestions: rollbackSuggestions(next) };
}

function fillDeploymentRolloutParallelSlots(
  detail: DeploymentRolloutDetailV2,
  batchIndex: number,
  now: number,
): DeploymentRolloutDetailV2 {
  const batch = detail.batches[batchIndex];
  if (!batch) return detail;
  const batchIndexes = new Set(batch.targetIndexes);
  const running = detail.targets.filter((target) => (
    batchIndexes.has(target.targetIndex) && target.status === 'running'
  )).length;
  let available = Math.max(0, detail.policy.maxParallel - running);
  return {
    ...detail,
    targets: detail.targets.map((target) => {
      if (available === 0 || !batchIndexes.has(target.targetIndex) || target.status !== 'notStarted') return target;
      available -= 1;
      return { ...target, status: 'running', startedAt: now };
    }),
  };
}

export function startDeploymentRolloutBatch(
  detail: DeploymentRolloutDetailV2,
  approval: DeploymentRolloutBatchApprovalV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  const batchIndex = detail.currentBatchIndex;
  const batch = batchIndex === undefined ? undefined : detail.batches[batchIndex];
  if (detail.circuitOpen || detail.recoveryRequired || !batch || batch.status !== 'awaitingApproval') {
    return tripRolloutCircuit(detail, detail.recoveryRequired ? 'recoveryRequired' : 'planDrift', now);
  }
  if (approval.batchIndex !== batchIndex || !approvalMatchesBatch(detail, approval)) {
    return tripRolloutCircuit(detail, 'approvalMismatch', now);
  }
  return recount(fillDeploymentRolloutParallelSlots({
    ...detail,
    phase: 'running',
    updatedAt: now,
    batches: detail.batches.map((entry) => entry.batchIndex === batchIndex
      ? { ...entry, status: 'running', approvalReviewId: approval.rolloutReviewId, approvalConsumedAt: now, startedAt: now }
      : entry),
  }, batchIndex, now));
}

function resultSucceeded(result: DeploymentExecutionResultV2): boolean {
  return result.phase === 'succeeded'
    && result.healthChecks.length > 0
    && result.healthChecks.every((check) => check.status === 'passed');
}

export function applyDeploymentRolloutTargetResult(
  detail: DeploymentRolloutDetailV2,
  result: DeploymentExecutionResultV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  const targetIndex = detail.targets.findIndex((target) => target.operationId === result.operationId);
  const target = detail.targets[targetIndex];
  if (!target?.deploymentReview || target.status !== 'running'
    || target.batchIndex !== detail.currentBatchIndex
    || !deploymentExecutionResultMatchesReview(target.deploymentReview, result)) {
    return tripRolloutCircuit(detail, 'lateResult', now);
  }
  const succeeded = resultSucceeded(result);
  let next = recount({
    ...detail,
    updatedAt: now,
    targets: detail.targets.map((entry, index) => index === targetIndex
      ? {
          ...entry,
          status: succeeded ? 'succeeded' : result.phase === 'cancelled' ? 'cancelled' : 'failed',
          result,
          completedAt: now,
          errorCategory: result.errorCategory,
          error: result.error,
        }
      : entry),
  });
  const batchIndex = next.currentBatchIndex!;
  const batch = next.batches[batchIndex]!;
  next = recount(fillDeploymentRolloutParallelSlots(next, batchIndex, now));
  const batchTargets = batch.targetIndexes.map((index) => next.targets[index]!);
  if (batchTargets.some((entry) => entry.status === 'running' || entry.status === 'notStarted')) return next;

  const healthy = batchTargets.filter((entry) => entry.status === 'succeeded').length;
  const failed = batchTargets.length - healthy;
  const healthyPercent = Math.floor(healthy * 100 / batchTargets.length);
  const thresholdMet = healthy >= batch.requiredHealthy && failed <= batch.maximumFailures;
  next = {
    ...next,
    batches: next.batches.map((entry) => entry.batchIndex === batchIndex
      ? {
          ...entry,
          status: thresholdMet ? 'succeeded' : 'failed',
          completedAt: now,
          health: { total: batchTargets.length, healthy, failed, healthyPercent, thresholdMet },
        }
      : entry),
  };
  if (!thresholdMet) {
    const reason = batch.kind === 'canary'
      ? 'canaryFailed'
      : failed > batch.maximumFailures ? 'failureThreshold' : 'healthThreshold';
    return tripRolloutCircuit(next, reason, now);
  }
  const nextBatch = next.batches[batchIndex + 1];
  if (!nextBatch) {
    return recount({
      ...next,
      phase: next.failedTargets > 0 ? 'partialSuccess' : 'succeeded',
      currentBatchIndex: undefined,
      updatedAt: now,
    });
  }
  return recount({
    ...next,
    phase: 'awaitingBatchApproval',
    currentBatchIndex: nextBatch.batchIndex,
    updatedAt: now,
    batches: next.batches.map((entry) => entry.batchIndex === nextBatch.batchIndex
      ? { ...entry, status: 'awaitingApproval' }
      : entry),
  });
}

export function cancelDeploymentRollout(
  detail: DeploymentRolloutDetailV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  const next = recount({
    ...detail,
    phase: 'cancelled',
    circuitOpen: true,
    circuitReason: 'cancelled',
    currentBatchIndex: undefined,
    updatedAt: now,
    batches: detail.batches.map((batch) => ['succeeded', 'failed'].includes(batch.status)
      ? batch
      : { ...batch, status: 'cancelled', completedAt: now }),
    targets: detail.targets.map((target) => ['succeeded', 'failed'].includes(target.status)
      ? target
      : { ...target, status: 'cancelled', completedAt: now }),
  });
  return { ...next, rollbackSuggestions: rollbackSuggestions(next) };
}

export function sealInterruptedDeploymentRollout(
  detail: DeploymentRolloutDetailV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  if (!['running', 'awaitingBatchApproval', 'awaitingCanaryApproval'].includes(detail.phase)) return detail;
  const next = recount({
    ...detail,
    phase: 'recoveryRequired',
    circuitOpen: true,
    circuitReason: 'recoveryRequired',
    recoveryRequired: true,
    updatedAt: now,
    batches: detail.batches.map((batch) => batch.status === 'running'
      ? { ...batch, status: 'interrupted', completedAt: now }
      : batch),
    targets: detail.targets.map((target) => target.status === 'running'
      ? {
          ...target,
          status: 'interrupted',
          completedAt: now,
          recoveryRequired: true,
          errorCategory: 'recoveryRequired',
          error: 'application restart interrupted this deployment target; it was not replayed',
        }
      : target),
  });
  return { ...next, rollbackSuggestions: rollbackSuggestions(next) };
}

export function recoverDeploymentRolloutState(
  previous: DeploymentRolloutDetailV2,
  review: DeploymentRolloutReviewV2,
  now = Date.now(),
): DeploymentRolloutDetailV2 {
  if (!previous.recoveryRequired
    || review.recoveryOfReviewId !== previous.reviewId
    || review.rolloutId !== previous.rolloutId
    || review.profileIds.join('\u0000') !== previous.review.profileIds.join('\u0000')
    || review.documentDigest !== previous.review.documentDigest) {
    fail('recovery review does not preserve the interrupted rollout identity and order');
  }
  const recovered = createDeploymentRolloutState(review, now);
  recovered.targets = recovered.targets.map((target, index) => {
    const old = previous.targets[index];
    if (old?.status !== 'succeeded') return target;
    if (target.deploymentReview) fail(`completed target ${target.profileId} must not receive a new deployment review`);
    return { ...target, status: 'succeeded', result: old.result, completedAt: old.completedAt };
  });
  recovered.batches = recovered.batches.map((batch) => {
    const targets = batch.targetIndexes.map((index) => recovered.targets[index]!);
    const succeeded = targets.filter((target) => target.status === 'succeeded').length;
    if (succeeded !== targets.length) return { ...batch, status: 'pending', health: emptyHealth(targets.length) };
    return {
      ...batch,
      status: 'succeeded',
      health: { total: targets.length, healthy: targets.length, failed: 0, healthyPercent: 100, thresholdMet: true },
    };
  });
  const firstPending = recovered.batches.find((batch) => batch.status !== 'succeeded');
  if (!firstPending) {
    return recount({ ...recovered, phase: 'succeeded', currentBatchIndex: undefined });
  }
  recovered.currentBatchIndex = firstPending.batchIndex;
  recovered.phase = firstPending.kind === 'canary' ? 'awaitingCanaryApproval' : 'awaitingBatchApproval';
  recovered.batches = recovered.batches.map((batch) => batch.batchIndex === firstPending.batchIndex
    ? { ...batch, status: 'awaitingApproval' }
    : batch);
  return recount(recovered);
}
