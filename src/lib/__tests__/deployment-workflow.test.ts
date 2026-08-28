import { describe, expect, it } from 'vitest';
import { parseDeploymentRunbookV2Text } from '@/lib/deployment-runbook';
import {
  createDeploymentTemplate,
  deploymentTemplatePlaceholderPaths,
  deploymentWorkflowPersistableSnapshot,
  deploymentWorkflowReviewExpired,
  deploymentWorkflowReviewIsCurrent,
  editDeploymentWorkflowDraft,
  freezeDeploymentWorkflowReview,
  validateDeploymentWorkflowDraft,
  type DeploymentWorkflowDraft,
  type DeploymentWorkflowState,
} from '@/lib/deployment-workflow';
import type { DeploymentExecutionReviewV2 } from '@/types/deployment-runbook';
import type { DeploymentRolloutReviewV2 } from '@/types/deployment-rollout';

function resolvedDraft(template: 'singleSystemdWeb' | 'canaryRollingSystemdWeb'): DeploymentWorkflowDraft {
  const draft = createDeploymentTemplate(template);
  const document = draft.document;
  document.id = 'acme-web-production';
  document.name = 'Deploy Acme Web';
  document.deployment.applicationId = 'acme-web';
  document.deployment.version = '1.2.3';
  document.deployment.id = 'acme-web-1.2.3';
  document.artifacts[0]!.description = 'Verified Acme Web release archive.';
  document.artifacts[0]!.sourceUri = 'file:///opt/termbridge-artifacts/acme-web.tar.gz';
  document.artifacts[0]!.sha256 = 'a'.repeat(64);
  document.artifacts[0]!.targetPath = 'artifacts/acme-web.tar.gz';
  document.release.rootDirectory = '/srv/acme-web';
  document.release.releasesDirectory = '/srv/acme-web/releases';
  document.release.releaseDirectory = '/srv/acme-web/releases/acme-web-1.2.3';
  document.release.activeSymlink = '/srv/acme-web/current';
  document.services[0]!.unit = 'acme-web.service';
  draft.targetProfileIds = template === 'singleSystemdWeb' ? ['prod-a'] : ['prod-a', 'prod-b', 'prod-c'];
  return draft;
}

function singleReview(draft: DeploymentWorkflowDraft): DeploymentExecutionReviewV2 {
  return {
    schemaVersion: 2,
    reviewId: 'deployment-review:ui',
    operationId: 'deployment:ui',
    normalizedRunbookText: validateDeploymentWorkflowDraft(draft).normalizedText!,
    documentDigest: 'sha256-v1:document',
    planDigest: 'sha256-v1:plan',
    deploymentId: draft.document.deployment.id,
    applicationId: draft.document.deployment.applicationId,
    environment: draft.document.deployment.environment,
    version: draft.document.deployment.version,
    artifactDigests: [],
    declaredRisk: 'stateChange',
    target: {
      profileId: draft.targetProfileIds[0]!,
      host: 'prod-a.example.test',
      port: 22,
      username: 'deploy',
      authMethod: 'key',
      identityDigest: 'sha256-v1:target-a',
    },
    policy: draft.deploymentPolicy,
    actions: [],
    reviewedAt: 100,
    expiresAt: 200,
  };
}

describe('deployment workflow templates', () => {
  it.each(['singleSystemdWeb', 'canaryRollingSystemdWeb'] as const)(
    'generates a legal, secret-free v2 document for %s',
    (template) => {
      const draft = createDeploymentTemplate(template);
      const parsed = parseDeploymentRunbookV2Text(JSON.stringify(draft.document));
      const serialized = JSON.stringify(parsed);

      expect(parsed.schemaVersion).toBe(2);
      expect(deploymentTemplatePlaceholderPaths(draft.document)).not.toHaveLength(0);
      expect(draft.document.security.secretRefs).toEqual([]);
      expect(serialized).not.toMatch(/password|passphrase|api[_-]?key|-----BEGIN/i);
      expect(serialized).not.toContain('"command"');
      expect(draft.document.artifacts[0]!.sourceUri).not.toMatch(/[?#]/);
    },
  );

  it('validates resolved single-host and canary/rolling drafts with deterministic batches', () => {
    const single = validateDeploymentWorkflowDraft(resolvedDraft('singleSystemdWeb'));
    const rollout = validateDeploymentWorkflowDraft(resolvedDraft('canaryRollingSystemdWeb'));

    expect(single.errors).toEqual([]);
    expect(rollout.errors).toEqual([]);
    expect(rollout.batches.map((batch) => batch.profileIds)).toEqual([
      ['prod-a'],
      ['prod-b', 'prod-c'],
    ]);
    expect(rollout.batches.every((batch) => batch.approvalRequired)).toBe(true);
  });
});

describe('deployment workflow review freezing', () => {
  it('freezes a matching backend review and invalidates it on any draft edit', () => {
    const draft = resolvedDraft('singleSystemdWeb');
    const frozen = freezeDeploymentWorkflowReview({ draft }, singleReview(draft));

    expect(deploymentWorkflowReviewIsCurrent(frozen)).toBe(true);
    const edited = editDeploymentWorkflowDraft(frozen, (current) => ({
      ...current,
      document: {
        ...current.document,
        deployment: { ...current.document.deployment, version: '1.2.4' },
      },
    }));
    expect(edited.frozenReview).toBeUndefined();
    expect(deploymentWorkflowReviewIsCurrent(edited)).toBe(false);
  });

  it('rejects a review for a different explicit target and marks expired reviews unusable', () => {
    const draft = resolvedDraft('singleSystemdWeb');
    const review = singleReview(draft);
    expect(() => freezeDeploymentWorkflowReview(
      { draft },
      { ...review, target: { ...review.target, profileId: 'prod-b' } },
    )).toThrow(/does not match/);
    const frozen = freezeDeploymentWorkflowReview({ draft }, review);
    expect(deploymentWorkflowReviewExpired(frozen, review.expiresAt)).toBe(true);
  });

  it('binds rollout review order and never includes connection secrets in a persistable UI snapshot', () => {
    const draft = resolvedDraft('canaryRollingSystemdWeb');
    const validation = validateDeploymentWorkflowDraft(draft);
    const review = {
      schemaVersion: 2,
      rolloutId: 'rollout:ui',
      reviewId: 'rollout-review:ui',
      normalizedRunbookText: validation.normalizedText!,
      documentDigest: 'sha256-v1:document',
      planDigest: 'sha256-v1:plan',
      deploymentId: draft.document.deployment.id,
      applicationId: draft.document.deployment.applicationId,
      environment: draft.document.deployment.environment,
      version: draft.document.deployment.version,
      declaredRisk: 'stateChange',
      policy: draft.rolloutPolicy,
      deploymentPolicy: draft.deploymentPolicy,
      profileIds: [...draft.targetProfileIds],
      targets: [],
      batches: [],
      reviewedAt: 100,
      expiresAt: 200,
    } satisfies DeploymentRolloutReviewV2;
    const frozen = freezeDeploymentWorkflowReview({ draft }, review);
    expect(frozen.frozenReview?.kind).toBe('rollout');

    (draft as DeploymentWorkflowDraft & { connection?: unknown }).connection = {
      password: 'must-never-persist',
      privateKeyData: 'private-key',
    };
    const snapshot = deploymentWorkflowPersistableSnapshot(draft);
    expect(snapshot).not.toContain('must-never-persist');
    expect(snapshot).not.toContain('privateKeyData');
    expect(snapshot).not.toContain('connection');
  });

  it('fails closed when an in-memory document changes behind a frozen fingerprint', () => {
    const draft = resolvedDraft('singleSystemdWeb');
    const state: DeploymentWorkflowState = freezeDeploymentWorkflowReview({ draft }, singleReview(draft));
    state.draft.document.name = 'Mutated behind the form boundary';
    expect(deploymentWorkflowReviewIsCurrent(state)).toBe(false);
  });
});
