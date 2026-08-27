import { serializeDeploymentRunbookV2 } from '@/lib/deployment-runbook';
import { normalizeDeploymentRolloutBatches } from '@/lib/deployment-rollout';
import type {
  DeploymentExecutionPolicyV2,
  DeploymentExecutionReviewV2,
  DeploymentRunbookDocumentV2,
} from '@/types/deployment-runbook';
import type {
  DeploymentRolloutPolicyV2,
  DeploymentRolloutReviewV2,
} from '@/types/deployment-rollout';

export type DeploymentTemplateId = 'singleSystemdWeb' | 'canaryRollingSystemdWeb';
export type DeploymentWorkflowMode = 'single' | 'rollout';

export interface DeploymentWorkflowDraft {
  templateId?: DeploymentTemplateId;
  mode: DeploymentWorkflowMode;
  document: DeploymentRunbookDocumentV2;
  targetProfileIds: string[];
  rolloutPolicy: DeploymentRolloutPolicyV2;
  deploymentPolicy: DeploymentExecutionPolicyV2;
}

export type DeploymentWorkflowReview =
  | { kind: 'single'; review: DeploymentExecutionReviewV2; draftFingerprint: string }
  | { kind: 'rollout'; review: DeploymentRolloutReviewV2; draftFingerprint: string };

export interface DeploymentWorkflowState {
  draft: DeploymentWorkflowDraft;
  frozenReview?: DeploymentWorkflowReview;
}

export interface DeploymentDraftValidation {
  normalizedText?: string;
  placeholderPaths: string[];
  errors: string[];
  batches: ReturnType<typeof normalizeDeploymentRolloutBatches>;
}

export const DEFAULT_DEPLOYMENT_EXECUTION_POLICY: Readonly<DeploymentExecutionPolicyV2> = {
  artifactTimeoutSeconds: 120,
  maxArtifactBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  totalTimeoutSeconds: 900,
};

export const DEFAULT_DEPLOYMENT_ROLLOUT_POLICY: Readonly<DeploymentRolloutPolicyV2> = {
  strategy: 'canaryRolling',
  canary: { mode: 'count', value: 1 },
  batchSize: 2,
  maxParallel: 2,
  requireBatchApproval: true,
  minHealthyPercent: 100,
  maxFailuresPerBatch: 0,
  stopPolicy: 'pause',
  rollbackSuggestion: 'successfulTargets',
};

function cloneDocument(document: DeploymentRunbookDocumentV2): DeploymentRunbookDocumentV2 {
  return JSON.parse(JSON.stringify(document)) as DeploymentRunbookDocumentV2;
}

function cloneRolloutPolicy(policy: DeploymentRolloutPolicyV2): DeploymentRolloutPolicyV2 {
  return JSON.parse(JSON.stringify(policy)) as DeploymentRolloutPolicyV2;
}

function templateDocument(name: string, description: string): DeploymentRunbookDocumentV2 {
  const applicationId = 'replace-me-web';
  const deploymentId = 'replace-me-web-0.0.0-replace-me';
  const rootDirectory = `/srv/${applicationId}`;
  return {
    schemaVersion: 2,
    kind: 'deployment',
    id: `${applicationId}-production`,
    name,
    description,
    deployment: {
      id: deploymentId,
      applicationId,
      environment: 'production',
      version: '0.0.0-replace-me',
    },
    artifacts: [{
      id: 'application-bundle',
      description: 'Replace this path and digest with the verified web service release archive.',
      kind: 'archive',
      sourceUri: 'file:///opt/termbridge-artifacts/replace-me-web.tar.gz',
      sha256: '0'.repeat(64),
      targetPath: 'artifacts/replace-me-web.tar.gz',
      unpack: {
        format: 'tarGz',
        destinationPath: '.',
        stripComponents: 1,
      },
    }],
    release: {
      rootDirectory,
      releasesDirectory: `${rootDirectory}/releases`,
      releaseDirectory: `${rootDirectory}/releases/${deploymentId}`,
      activeSymlink: `${rootDirectory}/current`,
      activationStrategy: 'atomicSymlinkSwap',
    },
    services: [{
      id: 'web',
      manager: 'systemd',
      unit: 'replace-me-web.service',
    }],
    serviceActions: [{
      id: 'restart-web',
      serviceId: 'web',
      action: 'restart',
      risk: 'stateChange',
      timeoutSeconds: 60,
    }],
    verification: {
      checks: [{
        id: 'web-service-active',
        kind: 'service',
        serviceId: 'web',
        expectedState: 'active',
        timeoutSeconds: 10,
        attempts: 3,
        intervalSeconds: 2,
      }, {
        id: 'web-http-health',
        kind: 'http',
        url: 'http://127.0.0.1:8080/health',
        expectedStatus: 200,
        timeoutSeconds: 5,
        attempts: 12,
        intervalSeconds: 5,
      }],
    },
    rollback: {
      strategy: 'reactivatePreviousRelease',
      serviceActions: [{
        id: 'rollback-restart-web',
        serviceId: 'web',
        action: 'restart',
        risk: 'stateChange',
        timeoutSeconds: 60,
      }],
      verificationCheckIds: ['web-service-active', 'web-http-health'],
    },
    security: {
      declaredRisk: 'stateChange',
      allowPrivilegeEscalation: false,
      approval: {
        deployment: 'explicit',
        rollback: 'separate',
        destructive: 'doubleConfirmation',
        targetBinding: 'frozenProfile',
      },
      secretRefs: [],
    },
  };
}

export function createDeploymentTemplate(templateId: DeploymentTemplateId): DeploymentWorkflowDraft {
  const rollout = templateId === 'canaryRollingSystemdWeb';
  const document = templateDocument(
    rollout ? 'Canary and rolling systemd web deployment' : 'Single-host systemd web deployment',
    rollout
      ? 'Deploy a verified archive to an explicit canary and rolling target order.'
      : 'Deploy a verified archive to one explicit target with atomic activation and health checks.',
  );
  return {
    templateId,
    mode: rollout ? 'rollout' : 'single',
    document,
    targetProfileIds: [],
    rolloutPolicy: cloneRolloutPolicy(DEFAULT_DEPLOYMENT_ROLLOUT_POLICY),
    deploymentPolicy: { ...DEFAULT_DEPLOYMENT_EXECUTION_POLICY },
  };
}

export function createImportedDeploymentDraft(
  document: DeploymentRunbookDocumentV2,
): DeploymentWorkflowDraft {
  return {
    mode: 'single',
    document: cloneDocument(document),
    targetProfileIds: [],
    rolloutPolicy: cloneRolloutPolicy(DEFAULT_DEPLOYMENT_ROLLOUT_POLICY),
    deploymentPolicy: { ...DEFAULT_DEPLOYMENT_EXECUTION_POLICY },
  };
}

function findPlaceholderPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return /replace-me/i.test(value) || /^0{64}$/.test(value) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPlaceholderPaths(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => (
      findPlaceholderPaths(entry, path ? `${path}.${key}` : key)
    ));
  }
  return [];
}

export function deploymentTemplatePlaceholderPaths(
  document: DeploymentRunbookDocumentV2,
): string[] {
  return findPlaceholderPaths(document);
}

export function validateDeploymentWorkflowDraft(
  draft: DeploymentWorkflowDraft,
): DeploymentDraftValidation {
  const errors: string[] = [];
  let normalizedText: string | undefined;
  let batches: ReturnType<typeof normalizeDeploymentRolloutBatches> = [];
  try {
    normalizedText = serializeDeploymentRunbookV2(draft.document);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const placeholderPaths = deploymentTemplatePlaceholderPaths(draft.document);
  if (placeholderPaths.length > 0) errors.push(`unresolved placeholders: ${placeholderPaths.join(', ')}`);
  if (new Set(draft.targetProfileIds).size !== draft.targetProfileIds.length) {
    errors.push('deployment targets must be unique');
  }
  if (draft.mode === 'single' && draft.targetProfileIds.length !== 1) {
    errors.push('single-host deployment requires exactly one explicit target');
  }
  if (draft.mode === 'rollout') {
    if (draft.targetProfileIds.length < 2 || draft.targetProfileIds.length > 500) {
      errors.push('deployment rollout requires 2-500 explicit targets');
    } else {
      try {
        batches = normalizeDeploymentRolloutBatches(draft.targetProfileIds, draft.rolloutPolicy);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { normalizedText, placeholderPaths, errors, batches };
}

export function deploymentWorkflowDraftFingerprint(draft: DeploymentWorkflowDraft): string {
  const normalizedText = serializeDeploymentRunbookV2(draft.document);
  return JSON.stringify({
    mode: draft.mode,
    normalizedText,
    targetProfileIds: draft.targetProfileIds,
    rolloutPolicy: draft.mode === 'rollout' ? draft.rolloutPolicy : undefined,
    deploymentPolicy: draft.deploymentPolicy,
  });
}

export function freezeDeploymentWorkflowReview(
  state: DeploymentWorkflowState,
  review: DeploymentExecutionReviewV2 | DeploymentRolloutReviewV2,
): DeploymentWorkflowState {
  const fingerprint = deploymentWorkflowDraftFingerprint(state.draft);
  const normalizedText = serializeDeploymentRunbookV2(state.draft.document);
  const reviewedDeploymentPolicy = 'deploymentPolicy' in review
    ? review.deploymentPolicy
    : review.policy;
  const identityMatches = review.normalizedRunbookText === normalizedText
    && review.deploymentId === state.draft.document.deployment.id
    && review.applicationId === state.draft.document.deployment.applicationId
    && review.environment === state.draft.document.deployment.environment
    && review.version === state.draft.document.deployment.version
    && JSON.stringify(reviewedDeploymentPolicy) === JSON.stringify(state.draft.deploymentPolicy);
  if (!identityMatches) {
    throw new Error('deployment review does not match the normalized draft identity and policy');
  }
  if (state.draft.mode === 'single') {
    if (!('operationId' in review) || review.target.profileId !== state.draft.targetProfileIds[0]) {
      throw new Error('single-host deployment review does not match the explicit draft target');
    }
    return {
      ...state,
      frozenReview: { kind: 'single', review, draftFingerprint: fingerprint },
    };
  }
  if ('operationId' in review
    || review.profileIds.join('\u0000') !== state.draft.targetProfileIds.join('\u0000')
    || JSON.stringify(review.policy) !== JSON.stringify(state.draft.rolloutPolicy)) {
    throw new Error('deployment rollout review does not match the explicit draft target order');
  }
  return {
    ...state,
    frozenReview: { kind: 'rollout', review, draftFingerprint: fingerprint },
  };
}

export function editDeploymentWorkflowDraft(
  state: DeploymentWorkflowState,
  edit: (draft: DeploymentWorkflowDraft) => DeploymentWorkflowDraft,
): DeploymentWorkflowState {
  return { draft: edit(state.draft), frozenReview: undefined };
}

export function deploymentWorkflowReviewIsCurrent(state: DeploymentWorkflowState): boolean {
  if (!state.frozenReview) return false;
  try {
    return state.frozenReview.draftFingerprint === deploymentWorkflowDraftFingerprint(state.draft);
  } catch {
    return false;
  }
}

export function deploymentWorkflowReviewExpired(
  state: DeploymentWorkflowState,
  now = Date.now(),
): boolean {
  return Boolean(state.frozenReview && state.frozenReview.review.expiresAt <= now);
}

export function deploymentWorkflowPersistableSnapshot(draft: DeploymentWorkflowDraft): string {
  return JSON.stringify({
    schemaVersion: 1,
    mode: draft.mode,
    document: JSON.parse(serializeDeploymentRunbookV2(draft.document)) as unknown,
    targetProfileIds: [...draft.targetProfileIds],
    rolloutPolicy: cloneRolloutPolicy(draft.rolloutPolicy),
    deploymentPolicy: { ...draft.deploymentPolicy },
  });
}
