import { describe, expect, it } from 'vitest';
import {
  deploymentInputHandleId,
  deploymentOutputHandleId,
  parseDeploymentHandleId,
  validateDeploymentFlowConnection,
} from '@/lib/deployment/flow-connection';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowDefinition,
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

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [
    spec('generic', {
      inputs: [
        { name: 'in', portType: 'scalar.string', required: false },
        {
          name: 'bundle',
          portType: 'artifact.bundle',
          required: false,
          artifactTypes: ['application/vnd.shellspan.container-image'],
        },
      ],
      outputs: [
        { name: 'out', portType: 'scalar.string', required: false },
        { name: 'count', portType: 'scalar.integer', required: false },
        {
          name: 'bundle',
          portType: 'artifact.bundle',
          required: false,
          artifactTypes: ['application/vnd.shellspan.file-tree'],
        },
      ],
    }),
  ],
};

function definition(nodes: readonly DeploymentWorkflowNode[]): DeploymentWorkflowDefinition {
  return {
    schemaVersion: 3,
    targets: [],
    parameters: [],
    nodes,
    outputs: {},
    policy: {
      failFast: true,
      maxParallelLocalNodes: 4,
      releasesToKeep: 5,
      automaticRestore: true,
    },
  };
}

function connection(source: string, sourcePort: string, target: string, targetPort: string) {
  return {
    source,
    sourceHandle: deploymentOutputHandleId(sourcePort),
    target,
    targetHandle: deploymentInputHandleId(targetPort),
  };
}

describe('deployment flow connection validation', () => {
  it('encodes and parses stable directional handle ids', () => {
    expect(deploymentInputHandleId('bundle')).toBe('input:bundle');
    expect(deploymentOutputHandleId('release:value')).toBe('output:release:value');
    expect(parseDeploymentHandleId('output:release:value')).toEqual({
      direction: 'output',
      portName: 'release:value',
    });
    expect(parseDeploymentHandleId('side:bundle')).toBeNull();
    expect(parseDeploymentHandleId('input:')).toBeNull();
  });

  it('returns the binding coordinates for a valid connection', () => {
    const current = definition([node('source', 'generic'), node('target', 'generic')]);
    const before = structuredClone(current);
    const result = validateDeploymentFlowConnection(
      current,
      catalog,
      connection('source', 'out', 'target', 'in'),
    );

    expect(result).toEqual({
      valid: true,
      sourceNodeId: 'source',
      sourcePort: 'out',
      targetNodeId: 'target',
      targetPort: 'in',
      binding: { fromNodeId: 'source', fromPort: 'out' },
    });
    expect(current).toEqual(before);
  });

  it.each([
    ['self connection', connection('source', 'out', 'source', 'in'), 'SELF_CONNECTION'],
    ['reversed source handle', {
      ...connection('source', 'out', 'target', 'in'),
      sourceHandle: deploymentInputHandleId('in'),
    }, 'INVALID_HANDLE_DIRECTION'],
    ['unknown output', connection('source', 'missing', 'target', 'in'), 'UNKNOWN_OUTPUT_PORT'],
    ['unknown input', connection('source', 'out', 'target', 'missing'), 'UNKNOWN_INPUT_PORT'],
    ['port type mismatch', connection('source', 'count', 'target', 'in'), 'PORT_TYPE_MISMATCH'],
    ['artifact type mismatch', connection('source', 'bundle', 'target', 'bundle'), 'ARTIFACT_TYPE_MISMATCH'],
  ])('rejects %s with a structured reason', (_name, candidate, code) => {
    const result = validateDeploymentFlowConnection(
      definition([node('source', 'generic'), node('target', 'generic')]),
      catalog,
      candidate,
    );

    expect(result).toEqual({ valid: false, reason: expect.objectContaining({ code }) });
  });

  it('rejects an occupied target input unless that binding is being reconnected', () => {
    const current = definition([
      node('source', 'generic'),
      node('replacement', 'generic'),
      node('target', 'generic', { in: { fromNodeId: 'source', fromPort: 'out' } }),
    ]);
    const candidate = connection('replacement', 'out', 'target', 'in');

    expect(validateDeploymentFlowConnection(current, catalog, candidate)).toEqual({
      valid: false,
      reason: expect.objectContaining({ code: 'INPUT_OCCUPIED' }),
    });
    expect(validateDeploymentFlowConnection(current, catalog, candidate, {
      replacing: { targetNodeId: 'target', targetPort: 'in' },
    })).toEqual(expect.objectContaining({ valid: true }));
  });

  it('rejects a new cycle and permits a replacement after excluding the old binding', () => {
    const current = definition([
      node('a', 'generic'),
      node('b', 'generic', { in: { fromNodeId: 'a', fromPort: 'out' } }),
      node('c', 'generic', { in: { fromNodeId: 'b', fromPort: 'out' } }),
    ]);

    expect(validateDeploymentFlowConnection(
      current,
      catalog,
      connection('c', 'out', 'a', 'in'),
    )).toEqual({
      valid: false,
      reason: expect.objectContaining({ code: 'CYCLE_DETECTED' }),
    });

    expect(validateDeploymentFlowConnection(
      current,
      catalog,
      connection('a', 'out', 'c', 'in'),
      { replacing: { targetNodeId: 'c', targetPort: 'in' } },
    )).toEqual(expect.objectContaining({ valid: true }));
  });
});
