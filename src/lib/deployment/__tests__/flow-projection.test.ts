import { describe, expect, it } from 'vitest';
import {
  deploymentFlowEdgeId,
  parseDeploymentFlowEdgeId,
  projectDeploymentFlow,
} from '@/lib/deployment/flow-projection';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowLayout,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';

const retry = { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 };

function node(
  id: string,
  type: string,
  inputs: DeploymentWorkflowNode['inputs'] = {},
): DeploymentWorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    displayName: id,
    inputs,
    config: {},
    timeoutSeconds: 60,
    retry,
    runWhen: 'allSucceeded',
  };
}

function spec(
  typeName: string,
  ports: Pick<DeploymentNodeTypeSpec, 'inputs' | 'outputs'>,
): DeploymentNodeTypeSpec {
  return {
    typeName,
    typeVersion: 1,
    displayNameKey: 'deployment.node.source_snapshot.name',
    descriptionKey: 'deployment.node.source_snapshot.description',
    category: 'source',
    ...ports,
    executionDomain: 'local',
    effectClass: 'pure',
    capabilities: [],
    configSchemaVersion: 1,
    configSchema: { schemaVersion: 1, fields: [] },
    defaultConfig: {},
    riskLevel: 'low',
    fixedActions: [],
    retryable: true,
  };
}

const definition: DeploymentWorkflowDefinition = {
  schemaVersion: 3,
  targets: [],
  parameters: [],
  nodes: [
    node('source:primary', 'producer'),
    node('target/primary', 'consumer', {
      input: { fromNodeId: 'source:primary', fromPort: 'output/value' },
    }),
  ],
  outputs: {},
  policy: {
    failFast: true,
    maxParallelLocalNodes: 4,
    releasesToKeep: 5,
    automaticRestore: true,
  },
};

const layout: DeploymentWorkflowLayout = {
  schemaVersion: 1,
  nodes: {
    'source:primary': { x: 24, y: 36, collapsed: true },
  },
  groups: [],
};

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [
    spec('producer', {
      inputs: [],
      outputs: [{ name: 'output/value', portType: 'scalar.string', required: false }],
    }),
    spec('consumer', {
      inputs: [{ name: 'input', portType: 'scalar.string', required: true }],
      outputs: [],
    }),
  ],
};

describe('deployment flow projection', () => {
  it('projects stable typed nodes and reversible edges from bindings only', () => {
    const first = projectDeploymentFlow(definition, layout, catalog, 'target/primary');
    const second = projectDeploymentFlow(
      structuredClone(definition),
      structuredClone(layout),
      structuredClone(catalog),
      'target/primary',
    );

    expect(second).toEqual(first);
    expect(first.nodes).toEqual([
      expect.objectContaining({
        id: 'source:primary',
        type: 'deployment',
        position: { x: 24, y: 36 },
        selected: false,
        data: expect.objectContaining({
          workflowNode: expect.objectContaining({ id: 'source:primary' }),
          catalogNode: expect.objectContaining({ typeName: 'producer' }),
        }),
      }),
      expect.objectContaining({
        id: 'target/primary',
        position: { x: 280, y: 0 },
        selected: true,
      }),
    ]);
    expect(first.edges).toEqual([expect.objectContaining({
      source: 'source:primary',
      sourceHandle: 'output:output/value',
      target: 'target/primary',
      targetHandle: 'input:input',
    })]);
    expect(parseDeploymentFlowEdgeId(first.edges[0].id)).toEqual({
      sourceNodeId: 'source:primary',
      sourcePort: 'output/value',
      targetNodeId: 'target/primary',
      targetPort: 'input',
    });
    expect(first.edges[0].id).toBe(deploymentFlowEdgeId({
      sourceNodeId: 'source:primary',
      sourcePort: 'output/value',
      targetNodeId: 'target/primary',
      targetPort: 'input',
    }));
    expect(definition).not.toHaveProperty('edges');
  });

  it('uses deterministic fallback positions and safe empty port metadata', () => {
    const projected = projectDeploymentFlow(definition, null, null, null);

    expect(projected.nodes.map((item) => item.position)).toEqual([
      { x: 0, y: 0 },
      { x: 280, y: 0 },
    ]);
    expect(projected.nodes.every((item) => item.data.catalogNode === null)).toBe(true);
    expect(projected.nodes.every((item) => item.data.inputPorts.length === 0)).toBe(true);
    expect(projected.nodes.every((item) => item.data.outputPorts.length === 0)).toBe(true);
    expect(projected.edges).toHaveLength(1);
  });

  it('rejects malformed edge ids instead of guessing endpoints', () => {
    expect(parseDeploymentFlowEdgeId('edge:not-enough-parts')).toBeNull();
    expect(parseDeploymentFlowEdgeId('not-a-deployment-edge')).toBeNull();
  });
});
