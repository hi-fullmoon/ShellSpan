import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';
import type { DeploymentWorkflowDraft } from '@/stores/deploymentWorkflowStore';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';
import { NodeInspector } from '../node-inspector';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [{
    typeName: 'deploy.copy-files', typeVersion: 1,
    displayNameKey: 'deployment.node.deploy_copy_files.name',
    descriptionKey: 'deployment.node.deploy_copy_files.description', category: 'deploy',
    inputs: [], outputs: [],
    executionDomain: 'target', effectClass: 'remoteWrite', capabilities: [],
    configSchemaVersion: 1,
    configSchema: {
      schemaVersion: 1,
      fields: [
        {
          name: 'patterns', labelKey: 'deployment.editor.config.patterns.label',
          descriptionKey: 'deployment.editor.config.patterns.description', kind: 'stringList',
          required: false,
        },
        {
          name: 'port', labelKey: 'deployment.editor.config.port.label',
          descriptionKey: 'deployment.editor.config.port.description', kind: 'integer',
          required: false, minimum: 1, maximum: 65_535,
        },
      ],
    },
    defaultConfig: { patterns: ['dist'], port: 22 }, riskLevel: 'medium',
    fixedActions: [], retryable: true,
  }],
};

const node: DeploymentWorkflowNode = {
  id: 'deploy', type: 'deploy.copy-files', typeVersion: 1, displayName: 'Copy files',
  inputs: {}, config: { patterns: ['dist'], port: 22 }, timeoutSeconds: 120,
  retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
};

const definition: DeploymentWorkflowDefinition = {
  schemaVersion: 3,
  targets: [],
  parameters: [],
  nodes: [node],
  outputs: {},
  policy: { failFast: true, maxParallelLocalNodes: 2, releasesToKeep: 3, automaticRestore: true },
};

const draft: DeploymentWorkflowDraft = {
  id: 'workflow-1', name: 'Site', enabled: true, revision: 1, layoutRevision: 1,
  definition,
  layout: { schemaVersion: 1, nodes: {}, groups: [] },
};

function nodeConfig(): Record<string, unknown> {
  return useDeploymentWorkflowStore.getState().draft!.definition.nodes[0].config;
}

describe('NodeInspector config inputs', () => {
  beforeEach(() => {
    useDeploymentWorkflowStore.getState().reset();
    useDeploymentWorkflowStore.setState({
      draft: structuredClone(draft),
      selectedNodeId: node.id,
    });
  });

  it('keeps raw text while typing a list and only commits parsed entries on blur', () => {
    render(<NodeInspector draft={useDeploymentWorkflowStore.getState().draft!} node={node} catalog={catalog} />);
    const textarea = screen.getByLabelText('deployment.editor.config.patterns.label');

    fireEvent.change(textarea, { target: { value: 'a,' } });
    // A trailing comma used to be normalized away on every keystroke.
    expect(textarea).toHaveValue('a,');
    expect(nodeConfig().patterns).toEqual(['dist']);

    fireEvent.change(textarea, { target: { value: 'a,b\nc, d' } });
    fireEvent.blur(textarea);
    expect(nodeConfig().patterns).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects non-integer config input with a field error and keeps the committed value', () => {
    render(<NodeInspector draft={useDeploymentWorkflowStore.getState().draft!} node={node} catalog={catalog} />);
    const input = screen.getByLabelText('deployment.editor.config.port.label');

    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('deployment.editor.config.invalidNumber');
    expect(nodeConfig().port).toBe(22);

    fireEvent.change(input, { target: { value: '8080' } });
    fireEvent.blur(input);
    expect(nodeConfig().port).toBe(8080);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clamps integer config input to the field bounds on blur', () => {
    render(<NodeInspector draft={useDeploymentWorkflowStore.getState().draft!} node={node} catalog={catalog} />);
    const input = screen.getByLabelText('deployment.editor.config.port.label');

    fireEvent.change(input, { target: { value: '99999' } });
    fireEvent.blur(input);
    expect(nodeConfig().port).toBe(65_535);
    expect(input).toHaveValue('65535');
  });

  it('reverts an emptied timeout input instead of writing zero', () => {
    render(<NodeInspector draft={useDeploymentWorkflowStore.getState().draft!} node={node} catalog={catalog} />);
    const input = screen.getByLabelText('deployment.editor.timeout');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[0].timeoutSeconds).toBe(120);
    expect(input).toHaveValue('120');
  });

  it('clamps the timeout to its bounds on blur', () => {
    render(<NodeInspector draft={useDeploymentWorkflowStore.getState().draft!} node={node} catalog={catalog} />);
    const input = screen.getByLabelText('deployment.editor.timeout');

    fireEvent.change(input, { target: { value: '99999999' } });
    fireEvent.blur(input);
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[0].timeoutSeconds).toBe(86_400);
  });
});
