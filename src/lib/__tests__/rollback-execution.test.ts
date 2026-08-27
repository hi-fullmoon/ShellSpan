import { describe, expect, it } from 'vitest';
import {
  createRollbackExecutionApproval,
  isRollbackExecutionTerminal,
  requireRollbackExecutionResultIdentity,
  rollbackExecutionResultMatchesReview,
  transitionRollbackExecutionPhase,
} from '@/lib/rollback-execution';
import type {
  RollbackExecutionResultV2,
  RollbackExecutionReviewV2,
} from '@/types/deployment-runbook';

const review: RollbackExecutionReviewV2 = {
  schemaVersion: 2,
  reviewId: 'rollback-review:fixture',
  operationId: 'rollback:fixture',
  sourceOperationId: 'deployment:source',
  sourceReviewId: 'deployment-review:source',
  sourcePhase: 'succeeded',
  documentDigest: 'sha256-v1:document',
  planDigest: 'sha256-v1:rollback-plan',
  deploymentId: 'release-2',
  applicationId: 'app',
  environment: 'production',
  version: '2.0.0',
  currentRelease: '/srv/app/releases/release-2',
  previousRelease: '/srv/app/releases/release-1',
  releasesDirectory: '/srv/app/releases',
  activeSymlink: '/srv/app/current',
  snapshotCapturedAt: 1_000,
  declaredRisk: 'stateChange',
  target: {
    profileId: 'profile-1',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
    authMethod: 'password',
    identityDigest: 'sha256-v1:target',
  },
  totalTimeoutSeconds: 600,
  actions: [],
  reviewedAt: 1_000,
  expiresAt: 601_000,
};

const result: RollbackExecutionResultV2 = {
  schemaVersion: 2,
  operationId: review.operationId,
  reviewId: review.reviewId,
  sourceOperationId: review.sourceOperationId,
  documentDigest: review.documentDigest,
  planDigest: review.planDigest,
  deploymentId: review.deploymentId,
  version: review.version,
  target: review.target,
  phase: 'succeeded',
  startedAt: 2_000,
  completedAt: 3_000,
  actions: [],
  healthEvidence: [],
  reactivation: {
    currentRelease: review.currentRelease,
    previousRelease: review.previousRelease,
    releasesDirectory: review.releasesDirectory,
    activeSymlink: review.activeSymlink,
    activationChanged: true,
    changedAt: 2_500,
  },
};

describe('separately reviewed rollback execution', () => {
  it('copies source, current, previous, target, plan, and risk into approval', () => {
    expect(createRollbackExecutionApproval(review, {
      authorized: true,
      destructiveConfirmed: false,
    })).toEqual({
      reviewId: review.reviewId,
      operationId: review.operationId,
      sourceOperationId: review.sourceOperationId,
      documentDigest: review.documentDigest,
      planDigest: review.planDigest,
      targetDigest: review.target.identityDigest,
      currentRelease: review.currentRelease,
      previousRelease: review.previousRelease,
      approvedRisk: review.declaredRisk,
      authorized: true,
      destructiveConfirmed: false,
    });
  });

  it('allows only the reviewed non-recursive rollback sequence', () => {
    let phase = transitionRollbackExecutionPhase('pending', 'inspectingTarget');
    phase = transitionRollbackExecutionPhase(phase, 'reactivatingPreviousRelease');
    phase = transitionRollbackExecutionPhase(phase, 'applyingServices');
    phase = transitionRollbackExecutionPhase(phase, 'verifying');
    phase = transitionRollbackExecutionPhase(phase, 'succeeded');
    expect(isRollbackExecutionTerminal(phase)).toBe(true);
    expect(() => transitionRollbackExecutionPhase('succeeded', 'reactivatingPreviousRelease'))
      .toThrow(/invalid rollback execution transition/);
  });

  it.each([
    ['sourceOperationId', 'deployment:other'],
    ['planDigest', 'sha256-v1:changed'],
    ['deploymentId', 'release-3'],
  ] as const)('rejects late or cross-version result field %s', (field, value) => {
    const changed = { ...result, [field]: value };
    expect(rollbackExecutionResultMatchesReview(review, changed)).toBe(false);
    expect(() => requireRollbackExecutionResultIdentity(review, changed))
      .toThrow(/separate review/);
  });

  it('rejects current or previous release substitution in a late result', () => {
    const changed = {
      ...result,
      reactivation: { ...result.reactivation, previousRelease: '/srv/app/releases/injected' },
    };
    expect(() => requireRollbackExecutionResultIdentity(review, changed))
      .toThrow(/separate review/);
  });
});
