import type {
  DeploymentExecutionApprovalV2,
  DeploymentExecutionPhaseV2,
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewV2,
} from '@/types/deployment-runbook';

const TERMINAL_PHASES = new Set<DeploymentExecutionPhaseV2>([
  'succeeded',
  'failed',
  'cancelled',
  'timedOut',
  'identityMismatch',
  'unauthorized',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<DeploymentExecutionPhaseV2, readonly DeploymentExecutionPhaseV2[]>> = {
  pending: ['preparingArtifacts', 'unauthorized', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  preparingArtifacts: ['inspectingTarget', 'cancelled', 'timedOut', 'failed'],
  inspectingTarget: ['creatingRelease', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  creatingRelease: ['stagingArtifacts', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  stagingArtifacts: ['activatingRelease', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  activatingRelease: ['applyingServices', 'verifying', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  applyingServices: ['verifying', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  verifying: ['succeeded', 'cancelled', 'timedOut', 'identityMismatch', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timedOut: [],
  identityMismatch: [],
  unauthorized: [],
};

export function transitionDeploymentExecutionPhase(
  current: DeploymentExecutionPhaseV2,
  next: DeploymentExecutionPhaseV2,
): DeploymentExecutionPhaseV2 {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid Deployment Runbook v2 execution transition: ${current} -> ${next}`);
  }
  return next;
}

export function isDeploymentExecutionTerminal(phase: DeploymentExecutionPhaseV2): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function createDeploymentExecutionApproval(
  review: DeploymentExecutionReviewV2,
  options: { authorized: boolean; destructiveConfirmed: boolean },
): DeploymentExecutionApprovalV2 {
  return {
    reviewId: review.reviewId,
    operationId: review.operationId,
    documentDigest: review.documentDigest,
    planDigest: review.planDigest,
    targetDigest: review.target.identityDigest,
    approvedRisk: review.declaredRisk,
    authorized: options.authorized,
    destructiveConfirmed: options.destructiveConfirmed,
  };
}

export function deploymentExecutionResultMatchesReview(
  review: DeploymentExecutionReviewV2,
  result: DeploymentExecutionResultV2,
): boolean {
  const reviewedJump = review.target.jumpHost;
  const resultJump = result.target.jumpHost;
  const jumpMatches = reviewedJump === undefined
    ? resultJump === undefined
    : resultJump !== undefined
      && resultJump.host === reviewedJump.host
      && resultJump.port === reviewedJump.port
      && resultJump.username === reviewedJump.username
      && resultJump.authMethod === reviewedJump.authMethod;
  return result.schemaVersion === 2
    && result.operationId === review.operationId
    && result.reviewId === review.reviewId
    && result.documentDigest === review.documentDigest
    && result.planDigest === review.planDigest
    && result.deploymentId === review.deploymentId
    && result.version === review.version
    && result.target.profileId === review.target.profileId
    && result.target.host === review.target.host
    && result.target.port === review.target.port
    && result.target.username === review.target.username
    && result.target.authMethod === review.target.authMethod
    && result.target.identityDigest === review.target.identityDigest
    && jumpMatches;
}

export function requireDeploymentExecutionResultIdentity(
  review: DeploymentExecutionReviewV2,
  result: DeploymentExecutionResultV2,
): DeploymentExecutionResultV2 {
  if (!deploymentExecutionResultMatchesReview(review, result)) {
    throw new Error('Deployment Runbook v2 execution result identity does not match its review');
  }
  return result;
}
