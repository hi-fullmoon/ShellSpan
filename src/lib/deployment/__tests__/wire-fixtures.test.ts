import { describe, expect, it } from 'vitest';

import dockerComposeJson from '../../../../protocol/deployment/fixtures/docker-compose-workflow.json';
import staticSiteJson from '../../../../protocol/deployment/fixtures/static-site-workflow.json';
import type {
  DeploymentArtifactBundleManifest,
  DeploymentArtifactHandle,
  DeploymentJsonValue,
  DeploymentPortBinding,
  DeploymentWorkflowNode,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowLayout,
} from '@/lib/deployment/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is DeploymentJsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isBinding(value: unknown): value is DeploymentPortBinding {
  return (
    isRecord(value) &&
    typeof value.fromNodeId === 'string' &&
    typeof value.fromPort === 'string'
  );
}

function isNode(value: unknown): value is DeploymentWorkflowNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.typeVersion === 'number' &&
    typeof value.displayName === 'string' &&
    isRecord(value.inputs) &&
    Object.values(value.inputs).every(isBinding) &&
    isRecord(value.config) &&
    Object.values(value.config).every(isJsonValue) &&
    typeof value.timeoutSeconds === 'number' &&
    isRecord(value.retry) &&
    typeof value.retry.maxAttempts === 'number' &&
    typeof value.retry.initialBackoffSeconds === 'number' &&
    typeof value.retry.maxBackoffSeconds === 'number' &&
    ['allSucceeded', 'anyFailed', 'always'].includes(String(value.runWhen)) &&
    value.condition === undefined
  );
}

function assertWorkflowFixture(
  value: unknown,
): asserts value is DeploymentWorkflowDefinition {
  const valid =
    isRecord(value) &&
    value.schemaVersion === 3 &&
    Array.isArray(value.targets) &&
    value.targets.every(
      (target) =>
        isRecord(target) &&
        typeof target.id === 'string' &&
        typeof target.connectionProfileId === 'string' &&
        typeof target.remoteRoot === 'string',
    ) &&
    Array.isArray(value.parameters) &&
    value.parameters.length === 0 &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isNode) &&
    isRecord(value.outputs) &&
    Object.values(value.outputs).every(isBinding) &&
    isRecord(value.policy) &&
    value.policy.failFast === true &&
    typeof value.policy.maxParallelLocalNodes === 'number' &&
    typeof value.policy.releasesToKeep === 'number' &&
    typeof value.policy.automaticRestore === 'boolean';
  if (!valid) {
    throw new Error('shared workflow fixture does not match the workflow wire contract');
  }
}

const staticSiteFixture: unknown = staticSiteJson;
const dockerComposeFixture: unknown = dockerComposeJson;
assertWorkflowFixture(staticSiteFixture);
assertWorkflowFixture(dockerComposeFixture);

describe('deployment workflow wire fixtures', () => {
  it('keeps the shared static-site fixture aligned with the strict TypeScript wire type', () => {
    expect(staticSiteFixture).toEqual(staticSiteJson);
    expect(staticSiteFixture.nodes.map((node) => `${node.type}@${node.typeVersion}`)).toContain(
      'deploy.static-switch@1',
    );
  });

  it('keeps the shared Docker Compose fixture aligned with the strict TypeScript wire type', () => {
    expect(dockerComposeFixture).toEqual(dockerComposeJson);
    expect(dockerComposeFixture.nodes.map((node) => `${node.type}@${node.typeVersion}`)).toContain(
      'deploy.compose@2',
    );
  });

  it('keeps layout, artifact manifest, and opaque handle versioned separately', () => {
    const layout: DeploymentWorkflowLayout = {
      schemaVersion: 1,
      nodes: { source: { x: 20, y: 40 } },
      groups: [],
    };
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const manifest: DeploymentArtifactBundleManifest = {
      schemaVersion: 2,
      artifactType: 'application/vnd.shellspan.file-tree',
      source: { revision: 'abc123', dirty: false, snapshotDigest: digest },
      components: [
        {
          name: 'dist/index.html',
          role: 'application',
          mediaType: 'text/html',
          digest,
          size: 12,
          annotations: {},
        },
      ],
      producer: {
        nodeType: 'artifact.collect',
        nodeTypeVersion: 1,
        configDigest: digest,
      },
      annotations: {},
    };
    const handle: DeploymentArtifactHandle = {
      artifactReference: `deployment-artifact:${digest}`,
      manifestDigest: digest,
      contentDigest: digest,
    };

    expect(layout.schemaVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(2);
    expect(handle.artifactReference).not.toContain('/');
  });
});
