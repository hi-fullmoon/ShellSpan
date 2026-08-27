import type {
  RollbackExecutionApprovalV2,
  RollbackExecutionPhaseV2,
  RollbackExecutionResultV2,
  RollbackExecutionReviewV2,
} from '@/types/deployment-runbook';

const TERMINAL_PHASES = new Set<RollbackExecutionPhaseV2>([
  'succeeded',
  'failed',
  'cancelled',
  'timedOut',
  'identityMismatch',
  'unauthorized',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<RollbackExecutionPhaseV2, readonly RollbackExecutionPhaseV2[]>> = {
  pending: ['inspectingTarget', 'unauthorized', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  inspectingTarget: ['reactivatingPreviousRelease', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  reactivatingPreviousRelease: ['applyingServices', 'verifying', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  applyingServices: ['verifying', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  verifying: ['succeeded', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timedOut: [],
  identityMismatch: [],
  unauthorized: [],
};

export function transitionRollbackExecutionPhase(
  current: RollbackExecutionPhaseV2,
  next: RollbackExecutionPhaseV2,
): RollbackExecutionPhaseV2 {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid rollback execution transition: ${current} -> ${next}`);
  }
  return next;
}

export function isRollbackExecutionTerminal(phase: RollbackExecutionPhaseV2): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function createRollbackExecutionApproval(
  review: RollbackExecutionReviewV2,
  options: { authorized: boolean; destructiveConfirmed: boolean },
): RollbackExecutionApprovalV2 {
  return {
    reviewId: review.reviewId,
    operationId: review.operationId,
    sourceOperationId: review.sourceOperationId,
    documentDigest: review.documentDigest,
    planDigest: review.planDigest,
    targetDigest: review.target.identityDigest,
    currentRelease: review.currentRelease,
    previousRelease: review.previousRelease,
    approvedRisk: review.declaredRisk,
    authorized: options.authorized,
    destructiveConfirmed: options.destructiveConfirmed,
  };
}

export function rollbackExecutionResultMatchesReview(
  review: RollbackExecutionReviewV2,
  result: RollbackExecutionResultV2,
): boolean {
  return result.schemaVersion === 2
    && result.operationId === review.operationId
    && result.reviewId === review.reviewId
    && result.sourceOperationId === review.sourceOperationId
    && result.documentDigest === review.documentDigest
    && result.planDigest === review.planDigest
    && result.deploymentId === review.deploymentId
    && result.version === review.version
    && result.target.identityDigest === review.target.identityDigest
    && result.target.profileId === review.target.profileId
    && result.reactivation.currentRelease === review.currentRelease
    && result.reactivation.previousRelease === review.previousRelease
    && result.reactivation.releasesDirectory === review.releasesDirectory
    && result.reactivation.activeSymlink === review.activeSymlink;
}

export function requireRollbackExecutionResultIdentity(
  review: RollbackExecutionReviewV2,
  result: RollbackExecutionResultV2,
): RollbackExecutionResultV2 {
  if (!rollbackExecutionResultMatchesReview(review, result)) {
    throw new Error('Rollback execution result identity does not match its separate review');
  }
  return result;
}
