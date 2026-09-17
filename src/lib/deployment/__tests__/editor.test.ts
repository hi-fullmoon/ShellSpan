import { describe, expect, it } from 'vitest';
import {
  buildDeploymentTemplate,
  compatibleOutputBindings,
  localDeploymentEditorIssues,
  mapNativeValidationErrors,
  projectDeploymentEdges,
  topologyOrder,
} from '@/lib/deployment/editor';
import type { DeploymentNodeTypeCatalog } from '@/lib/deployment/types';

const nameForNode = (typeName: string): string => typeName;

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [
    {
      typeName: 'source.snapshot',
      typeVersion: 1,
      displayNameKey: 'deployment.node.source_snapshot.name',
      descriptionKey: 'deployment.node.source_snapshot.description',
      category: 'source',
      inputs: [],
      outputs: [{ name: 'source', portType: 'source.snapshot', required: false }],
      executionDomain: 'local',
      effectClass: 'localRead',
      capabilities: ['sourceSnapshot'],
      configSchemaVersion: 1,
      configSchema: { schemaVersion: 1, fields: [] },
      defaultConfig: { sourceRef: 'workspace' },
      riskLevel: 'low',
      fixedActions: ['freeze_source_snapshot'],
      retryable: true,
    },
    {
      typeName: 'build.package-script',
      typeVersion: 1,
      displayNameKey: 'deployment.node.build_package_script.name',
      descriptionKey: 'deployment.node.build_package_script.description',
      category: 'build',
      inputs: [{ name: 'source', portType: 'source.snapshot', required: true }],
      outputs: [{
        name: 'bundle',
        portType: 'artifact.bundle',
        required: false,
        artifactTypes: ['application/vnd.shellspan.file-tree'],
      }],
      executionDomain: 'local',
      effectClass: 'localBuild',
      capabilities: ['packageManager'],
      configSchemaVersion: 1,
      configSchema: { schemaVersion: 1, fields: [] },
      defaultConfig: {
        packageManager: 'pnpm',
        workingDirectory: '.',
        installMode: 'frozen',
        scriptName: 'build',
        outputDirectory: 'dist',
        environmentRefs: [],
      },
      riskLevel: 'medium',
      fixedActions: ['run_fixed_package_manager_script'],
      retryable: true,
    },
  ],
};

describe('deployment editor domain', () => {
  it('builds each template as a binding graph without a second edges source', () => {
    const target = { connectionProfileId: 'profile-1', remoteRoot: '/srv/example' };
    const staticSite = buildDeploymentTemplate('staticSite', target, nameForNode);
    const docker = buildDeploymentTemplate('dockerCompose', target, nameForNode);
    const imported = buildDeploymentTemplate('prebuiltFiles', target, nameForNode);
    const blank = buildDeploymentTemplate('blank', target, nameForNode);

    expect(staticSite.definition.nodes.some((node) => node.type === 'deploy.static-switch')).toBe(true);
    expect(docker.definition.nodes.some((node) => node.type === 'deploy.compose')).toBe(true);
    expect(imported.definition.nodes.some((node) => node.type === 'artifact.collect')).toBe(true);
    expect(blank.definition.nodes).toEqual([]);
    expect(staticSite.definition).not.toHaveProperty('edges');
    expect(projectDeploymentEdges(staticSite.definition)).toHaveLength(12);
  });

  it('projects connections from inputs and offers only compatible readable sources', () => {
    const definition = buildDeploymentTemplate(
      'blank',
      { connectionProfileId: 'profile-1', remoteRoot: '/srv/example' },
      nameForNode,
    ).definition;
    definition.nodes = [
      {
        id: 'source', type: 'source.snapshot', typeVersion: 1, displayName: 'Source', inputs: {},
        config: { sourceRef: 'workspace' }, timeoutSeconds: 60,
        retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
      },
      {
        id: 'build', type: 'build.package-script', typeVersion: 1, displayName: 'Build', inputs: {},
        config: catalog.nodes[1].defaultConfig, timeoutSeconds: 120,
        retry: { maxAttempts: 1, initialBackoffSeconds: 0, maxBackoffSeconds: 0 }, runWhen: 'allSucceeded',
      },
    ];
    expect(localDeploymentEditorIssues(definition, catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LOCAL_MISSING_INPUT', nodeId: 'build' }),
      expect.objectContaining({ code: 'MISSING_APPROVAL' }),
      expect.objectContaining({ code: 'MISSING_DEPLOYMENT' }),
      expect.objectContaining({ code: 'MISSING_VERIFICATION' }),
    ]));
    const compatible = compatibleOutputBindings(definition, catalog, 'build', 'source');
    expect(compatible.map((item) => item.binding)).toEqual([{ fromNodeId: 'source', fromPort: 'source' }]);
    definition.nodes[1].inputs = { source: compatible[0].binding };
    expect(projectDeploymentEdges(definition)).toEqual([
      expect.objectContaining({ sourceNodeId: 'source', targetNodeId: 'build' }),
    ]);
    expect(topologyOrder(definition).map((node) => node.id)).toEqual(['source', 'build']);
  });

  it('maps stable native codes to localized editor issues', () => {
    expect(mapNativeValidationErrors([
      { code: 'CYCLE_DETECTED', message: 'diagnostic only', nodeId: 'build' },
      { code: 'INVALID_NODE_CONFIG', message: 'do not render as title', path: 'nodes.build.config' },
    ])).toEqual([
      expect.objectContaining({ messageKey: 'deployment.editor.validation.cycle', source: 'native' }),
      expect.objectContaining({ messageKey: 'deployment.editor.validation.invalidConfig', source: 'native' }),
    ]);
  });
});
