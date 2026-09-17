import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeploymentNodeTypeCatalog,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  catalog: vi.fn(),
  list: vi.fn(),
  validate: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateLayout: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc/tauri')>()),
  invokeDeploymentWorkflowCapabilities: mocks.capabilities,
  invokeListDeploymentNodeTypes: mocks.catalog,
  invokeListDeploymentWorkflows: mocks.list,
  invokeValidateDeploymentWorkflow: mocks.validate,
  invokeCreateDeploymentWorkflow: mocks.create,
  invokeUpdateDeploymentWorkflow: mocks.update,
  invokeUpdateDeploymentWorkflowLayout: mocks.updateLayout,
}));

import { buildDeploymentTemplate, projectDeploymentEdges } from '@/lib/deployment/editor';
import { useDeploymentWorkflowStore } from '@/stores/deploymentWorkflowStore';

const catalog: DeploymentNodeTypeCatalog = {
  schemaVersion: 1,
  nodes: [{
    typeName: 'source.snapshot', typeVersion: 1,
    displayNameKey: 'deployment.node.source_snapshot.name',
    descriptionKey: 'deployment.node.source_snapshot.description', category: 'source',
    inputs: [], outputs: [{ name: 'source', portType: 'source.snapshot', required: false }],
    executionDomain: 'local', effectClass: 'localRead', capabilities: ['sourceSnapshot'],
    configSchemaVersion: 1, configSchema: { schemaVersion: 1, fields: [] },
    defaultConfig: { sourceRef: 'workspace' }, riskLevel: 'low',
    fixedActions: ['freeze_source_snapshot'], retryable: true,
  }],
};

function record(revision = 1, layoutRevision = 1): DeploymentWorkflowRecord {
  const { definition, layout } = buildDeploymentTemplate(
    'staticSite',
    { connectionProfileId: 'profile-1', remoteRoot: '/srv/example' },
    (type) => type,
  );
  return {
    id: 'workflow-1', name: 'Site', enabled: false, archived: false,
    revision, definitionDigest: `sha256:${'a'.repeat(64)}`, definition,
    layoutRevision, layout, createdAt: 1, updatedAt: revision,
  };
}

describe('deploymentWorkflowStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDeploymentWorkflowStore.getState().reset();
    mocks.validate.mockResolvedValue({ valid: true, errors: [], compiled: {} });
  });

  it('starts all four templates and keeps connections solely in input bindings', () => {
    for (const kind of ['staticSite', 'dockerCompose', 'prebuiltFiles', 'blank'] as const) {
      useDeploymentWorkflowStore.getState().startTemplate(kind, 'Draft', 'profile-1', '/srv/example');
      const draft = useDeploymentWorkflowStore.getState().draft!;
      expect(draft.definition.schemaVersion).toBe(3);
      expect(draft.definition).not.toHaveProperty('edges');
      if (kind === 'blank') expect(draft.definition.nodes).toHaveLength(0);
      else expect(projectDeploymentEdges(draft.definition).length).toBeGreaterThan(0);
    }
  });

  it('creates a valid template through the high-level workflow IPC with its layout', async () => {
    useDeploymentWorkflowStore.setState({ catalog: null });
    useDeploymentWorkflowStore.getState().startTemplate(
      'dockerCompose',
      'Compose app',
      'profile-1',
      '/srv/example',
    );
    const created = {
      ...record(),
      name: 'Compose app',
      definition: useDeploymentWorkflowStore.getState().draft!.definition,
      layout: useDeploymentWorkflowStore.getState().draft!.layout,
    };
    mocks.create.mockResolvedValue(created);
    await useDeploymentWorkflowStore.getState().saveDraft();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Compose app',
      definition: expect.objectContaining({ schemaVersion: 3 }),
      layout: expect.objectContaining({ schemaVersion: 1 }),
    }));
    expect(useDeploymentWorkflowStore.getState().notice?.kind).toBe('created');
  });

  it('adds, connects, and removes nodes while cleaning dependent bindings', () => {
    useDeploymentWorkflowStore.setState({ catalog });
    useDeploymentWorkflowStore.getState().startTemplate('blank', 'Draft', 'profile-1', '/srv/example');
    useDeploymentWorkflowStore.getState().addNode('source.snapshot', 1);
    useDeploymentWorkflowStore.getState().addNode('source.snapshot', 1);
    const [first, second] = useDeploymentWorkflowStore.getState().draft!.definition.nodes;
    useDeploymentWorkflowStore.getState().connectInput(second.id, 'source', { fromNodeId: first.id, fromPort: 'source' });
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[1].inputs.source).toEqual({
      fromNodeId: first.id,
      fromPort: 'source',
    });
    useDeploymentWorkflowStore.getState().removeNode(first.id);
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[0].inputs).toEqual({});
  });

  it('saves layout without incrementing semantic revision and semantic changes with CAS revision', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    const firstNode = current.definition.nodes[0];
    useDeploymentWorkflowStore.getState().moveNode(firstNode.id, 42, 64);
    mocks.updateLayout.mockResolvedValue({
      workflowId: current.id,
      layoutRevision: 2,
      layoutDigest: `sha256:${'b'.repeat(64)}`,
      layout: useDeploymentWorkflowStore.getState().draft!.layout,
      createdAt: 2,
    });
    await useDeploymentWorkflowStore.getState().saveDraft();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateLayout).toHaveBeenCalledWith(current.id, 1, expect.anything());
    expect(useDeploymentWorkflowStore.getState().draft?.revision).toBe(1);
    expect(useDeploymentWorkflowStore.getState().draft?.layoutRevision).toBe(2);

    useDeploymentWorkflowStore.getState().updateNode(firstNode.id, { displayName: 'Renamed source' });
    mocks.update.mockResolvedValue({
      ...current,
      revision: 2,
      definition: useDeploymentWorkflowStore.getState().draft!.definition,
      updatedAt: 3,
    });
    await useDeploymentWorkflowStore.getState().saveDraft();
    expect(mocks.update).toHaveBeenCalledWith(current.id, 1, expect.objectContaining({
      definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ displayName: 'Renamed source' })]) }),
    }));
    expect(useDeploymentWorkflowStore.getState().draft?.revision).toBe(2);
  });

  it('surfaces semantic revision conflicts without replacing the draft', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().updateNode('source', { displayName: 'Local draft' });
    mocks.update.mockRejectedValue(new Error('DEPLOYMENT_WORKFLOW_REVISION_CONFLICT'));
    await expect(useDeploymentWorkflowStore.getState().saveDraft()).rejects.toThrow('REVISION_CONFLICT');
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes[0].displayName).toBe('Local draft');
    expect(useDeploymentWorkflowStore.getState().semanticDirty).toBe(true);
  });
});
