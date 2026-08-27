import { describe, expect, it } from 'vitest';
import {
  createDeploymentExecutionApproval,
  deploymentExecutionResultMatchesReview,
  isDeploymentExecutionTerminal,
  requireDeploymentExecutionResultIdentity,
  transitionDeploymentExecutionPhase,
} from '@/lib/deployment-execution';
import type {
  DeploymentExecutionResultV2,
  DeploymentExecutionReviewV2,
} from '@/types/deployment-runbook';

const review: DeploymentExecutionReviewV2 = {
  schemaVersion: 2,
  reviewId: 'deployment-review:fixture',
  operationId: 'deployment:fixture',
  normalizedRunbookText: '{"schemaVersion":2}\n',
  documentDigest: 'sha256-v1:document',
  planDigest: 'sha256-v1:plan',
  deploymentId: 'acme-api-2.4.0-20260828',
  applicationId: 'acme-api',
  environment: 'production',
  version: '2.4.0',
  artifactDigests: [{
    artifactId: 'bundle',
    sha256: 'a'.repeat(64),
    targetPath: 'artifacts/bundle.tar.gz',
  }],
  declaredRisk: 'stateChange',
  target: {
    profileId: 'profile-1',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
    authMethod: 'password',
    identityDigest: 'sha256-v1:target',
  },
  policy: {
    artifactTimeoutSeconds: 30,
    maxArtifactBytes: 10_485_760,
    maxExpandedBytes: 52_428_800,
    maxArchiveEntries: 1_000,
    totalTimeoutSeconds: 600,
  },
  actions: [],
  reviewedAt: 1_000,
  expiresAt: 601_000,
};

const result: DeploymentExecutionResultV2 = {
  schemaVersion: 2,
  operationId: review.operationId,
  reviewId: review.reviewId,
  documentDigest: review.documentDigest,
  planDigest: review.planDigest,
  deploymentId: review.deploymentId,
  version: review.version,
  target: review.target,
  phase: 'succeeded',
  startedAt: 2_000,
  completedAt: 3_000,
  actions: [],
  healthChecks: [],
  rollbackSnapshot: {
    strategy: 'reactivatePreviousRelease',
    previousRelease: '/srv/acme/releases/previous',
    newRelease: '/srv/acme/releases/current-release',
    releasesDirectory: '/srv/acme/releases',
    activeSymlink: '/srv/acme/current',
    activationChanged: true,
    capturedAt: 2_500,
  },
};

describe('Deployment Runbook v2 single-host execution contract', () => {
  it('copies every frozen approval binding without accepting caller substitutions', () => {
    expect(createDeploymentExecutionApproval(review, {
      authorized: true,
      destructiveConfirmed: false,
    })).toEqual({
      reviewId: review.reviewId,
      operationId: review.operationId,
      documentDigest: review.documentDigest,
      planDigest: review.planDigest,
      targetDigest: review.target.identityDigest,
      approvedRisk: review.declaredRisk,
      authorized: true,
      destructiveConfirmed: false,
    });
  });

  it('allows only the narrow forward state machine and terminal safe stops', () => {
    let phase = transitionDeploymentExecutionPhase('pending', 'preparingArtifacts');
    phase = transitionDeploymentExecutionPhase(phase, 'inspectingTarget');
    phase = transitionDeploymentExecutionPhase(phase, 'creatingRelease');
    phase = transitionDeploymentExecutionPhase(phase, 'stagingArtifacts');
    phase = transitionDeploymentExecutionPhase(phase, 'activatingRelease');
    phase = transitionDeploymentExecutionPhase(phase, 'applyingServices');
    phase = transitionDeploymentExecutionPhase(phase, 'verifying');
    phase = transitionDeploymentExecutionPhase(phase, 'succeeded');
    expect(isDeploymentExecutionTerminal(phase)).toBe(true);
    expect(() => transitionDeploymentExecutionPhase('preparingArtifacts', 'activatingRelease'))
      .toThrow(/invalid Deployment Runbook v2 execution transition/);
    expect(() => transitionDeploymentExecutionPhase('failed', 'preparingArtifacts')).toThrow();
  });

  it.each([
    ['operationId', 'deployment:late'],
    ['reviewId', 'deployment-review:late'],
    ['documentDigest', 'sha256-v1:changed'],
    ['planDigest', 'sha256-v1:changed'],
    ['deploymentId', 'other-release'],
    ['version', '2.4.1'],
  ] as const)('rejects a late result with mismatched %s', (field, value) => {
    const changed = { ...result, [field]: value };
    expect(deploymentExecutionResultMatchesReview(review, changed)).toBe(false);
    expect(() => requireDeploymentExecutionResultIdentity(review, changed))
      .toThrow(/identity does not match/);
  });

  it('rejects target drift even when the operation and plan digests look current', () => {
    const changed = {
      ...result,
      target: { ...result.target, host: 'changed.example.com' },
    };
    expect(() => requireDeploymentExecutionResultIdentity(review, changed))
      .toThrow(/identity does not match/);

    const jumpChanged = {
      ...result,
      target: {
        ...result.target,
        jumpHost: {
          host: 'jump.example.com',
          port: 22,
          username: 'operator',
          authMethod: 'password',
        },
      },
    };
    expect(() => requireDeploymentExecutionResultIdentity(review, jumpChanged))
      .toThrow(/identity does not match/);
  });
});
