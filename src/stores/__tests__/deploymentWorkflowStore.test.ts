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
  archive: vi.fn(),
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
  invokeArchiveDeploymentWorkflow: mocks.archive,
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
      else {
        expect(projectDeploymentEdges(draft.definition).length).toBeGreaterThan(0);
        expect(Object.values(draft.layout.nodes).every(
          (position) => position.x >= 36 && position.y >= 36,
        )).toBe(true);
      }
    }
  });

  it('preserves a matching profile filter and clears a mismatched one for a new template', () => {
    useDeploymentWorkflowStore.getState().setProfileFilter('profile-1');
    useDeploymentWorkflowStore.getState().startTemplate(
      'blank',
      'Matching target',
      'profile-1',
      '/srv/example',
    );
    expect(useDeploymentWorkflowStore.getState().profileFilterId).toBe('profile-1');

    useDeploymentWorkflowStore.getState().setProfileFilter('profile-2');
    useDeploymentWorkflowStore.getState().startTemplate(
      'blank',
      'Different target',
      'profile-1',
      '/srv/example',
    );
    expect(useDeploymentWorkflowStore.getState().profileFilterId).toBeNull();
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
    expect(useDeploymentWorkflowStore.getState().draft?.layout.nodes[first.id]).toEqual({
      x: 36,
      y: 36,
    });
    useDeploymentWorkflowStore.getState().connectInput(second.id, 'source', { fromNodeId: first.id, fromPort: 'source' });
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[1].inputs.source).toEqual({
      fromNodeId: first.id,
      fromPort: 'source',
    });
    useDeploymentWorkflowStore.getState().removeNode(first.id);
    expect(useDeploymentWorkflowStore.getState().draft!.definition.nodes[0].inputs).toEqual({});
  });

  it('marks connections and disconnections as semantic-only draft changes', () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });

    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().connectInput('build', 'source', null);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      layoutDirty: false,
      semanticDirty: true,
    });
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes.find((node) => node.id === 'build')?.inputs).not.toHaveProperty('source');

    useDeploymentWorkflowStore.setState({
      selectedWorkflowId: null,
      draft: null,
      semanticDirty: false,
      layoutDirty: false,
    });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().connectInput('build', 'source', {
      fromNodeId: 'source',
      fromPort: 'source',
    });
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      layoutDirty: false,
      semanticDirty: true,
    });
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes.find((node) => node.id === 'build')?.inputs.source).toEqual({
      fromNodeId: 'source',
      fromPort: 'source',
    });
  });

  it('disconnects and reconnects bindings atomically without touching layout', () => {
    const current = record();
    const source = current.definition.nodes.find((item) => item.id === 'source')!;
    const build = current.definition.nodes.find((item) => item.id === 'build')!;
    const currentLayout = current.layout!;
    const withAlternativeSource: DeploymentWorkflowRecord = {
      ...current,
      definition: {
        ...current.definition,
        nodes: [
          ...current.definition.nodes,
          { ...source, id: 'source-2', displayName: 'Source 2' },
          { ...build, id: 'build-2', displayName: 'Build 2', inputs: {} },
        ],
      },
      layout: {
        ...currentLayout,
        nodes: {
          ...currentLayout.nodes,
          'source-2': { x: 0, y: 190 },
          'build-2': { x: 280, y: 190 },
        },
      },
    };
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [withAlternativeSource] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    const originalLayout = structuredClone(useDeploymentWorkflowStore.getState().draft!.layout);

    useDeploymentWorkflowStore.getState().disconnectInput('build', 'source');
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes
      .find((item) => item.id === 'build')?.inputs).not.toHaveProperty('source');
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: true,
      layoutDirty: false,
    });

    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    let draftUpdates = 0;
    const unsubscribe = useDeploymentWorkflowStore.subscribe((state, previous) => {
      if (state.draft !== previous.draft) draftUpdates += 1;
    });
    useDeploymentWorkflowStore.getState().reconnectInput(
      'build',
      'source',
      'build-2',
      'source',
      { fromNodeId: 'source-2', fromPort: 'source' },
    );
    unsubscribe();

    expect(draftUpdates).toBe(1);
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes
      .find((item) => item.id === 'build')?.inputs).not.toHaveProperty('source');
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes
      .find((item) => item.id === 'build-2')?.inputs.source).toEqual({
        fromNodeId: 'source-2',
        fromPort: 'source',
      });
    expect(useDeploymentWorkflowStore.getState().draft?.layout).toEqual(originalLayout);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: true,
      layoutDirty: false,
    });
    expect(useDeploymentWorkflowStore.getState().draft?.definition).not.toHaveProperty('edges');
  });

  it('saves layout without incrementing semantic revision and semantic changes with CAS revision', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    const firstNode = current.definition.nodes[0];
    useDeploymentWorkflowStore.setState({ layoutDirty: true });
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
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: false,
      layoutDirty: false,
    });

    useDeploymentWorkflowStore.getState().updateNode(firstNode.id, { displayName: 'Renamed source' });
    mocks.update.mockResolvedValue({
      ...current,
      revision: 2,
      layoutRevision: 2,
      layout: useDeploymentWorkflowStore.getState().draft!.layout,
      definition: useDeploymentWorkflowStore.getState().draft!.definition,
      updatedAt: 3,
    });
    await useDeploymentWorkflowStore.getState().saveDraft();
    expect(mocks.update).toHaveBeenCalledWith(current.id, 1, expect.objectContaining({
      definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ displayName: 'Renamed source' })]) }),
    }));
    expect(useDeploymentWorkflowStore.getState().draft?.revision).toBe(2);
    expect(useDeploymentWorkflowStore.getState().draft?.layoutRevision).toBe(2);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: false,
      layoutDirty: false,
    });
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

  it('keeps dirty drafts until a pending workflow selection is confirmed', () => {
    const current = record();
    const other = { ...record(), id: 'workflow-2', name: 'Other site' };
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current, other] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().updateNode('source', { displayName: 'Local source' });

    expect(useDeploymentWorkflowStore.getState().selectWorkflow(current.id)).toBe(true);
    expect(useDeploymentWorkflowStore.getState().draft?.definition.nodes[0].displayName).toBe('Local source');
    expect(useDeploymentWorkflowStore.getState().selectWorkflow(other.id)).toBe(false);
    expect(useDeploymentWorkflowStore.getState().pendingSelectionId).toBe(other.id);
    expect(useDeploymentWorkflowStore.getState().draft?.id).toBe(current.id);

    useDeploymentWorkflowStore.getState().confirmPendingSelection();
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      selectedWorkflowId: other.id,
      pendingSelectionId: null,
      semanticDirty: false,
      layoutDirty: false,
    });
  });

  it('keeps the committed semantic revision when a following layout save fails', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().updateNode('source', { displayName: 'Committed source' });
    useDeploymentWorkflowStore.setState({ layoutDirty: true });
    const updated = {
      ...current,
      revision: 2,
      definition: useDeploymentWorkflowStore.getState().draft!.definition,
      updatedAt: 3,
    };
    mocks.update.mockResolvedValue(updated);
    mocks.updateLayout.mockRejectedValueOnce(new Error('LAYOUT_WRITE_FAILED'));

    await expect(useDeploymentWorkflowStore.getState().saveDraft()).rejects.toThrow('LAYOUT_WRITE_FAILED');
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: false,
      layoutDirty: true,
    });
    expect(useDeploymentWorkflowStore.getState().draft?.revision).toBe(2);

    mocks.updateLayout.mockResolvedValue({
      workflowId: current.id,
      layoutRevision: 2,
      layoutDigest: `sha256:${'b'.repeat(64)}`,
      layout: useDeploymentWorkflowStore.getState().draft!.layout,
      createdAt: 4,
    });
    await useDeploymentWorkflowStore.getState().saveDraft();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: false,
      layoutDirty: false,
    });
  });

  it('locks semantic and layout mutations while a save is in flight', () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    const before = structuredClone(useDeploymentWorkflowStore.getState().draft!);
    useDeploymentWorkflowStore.setState({ saving: true });

    useDeploymentWorkflowStore.getState().updateNode('source', { displayName: 'Late edit' });

    expect(useDeploymentWorkflowStore.getState().draft).toEqual(before);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      semanticDirty: false,
      layoutDirty: false,
    });
  });

  it('yields to an in-flight save instead of reinitializing over the draft', async () => {
    const current = record();
    const draft = {
      id: current.id, name: current.name, enabled: current.enabled,
      revision: current.revision, layoutRevision: current.layoutRevision,
      definition: structuredClone(current.definition),
      layout: structuredClone(current.layout!),
    };
    useDeploymentWorkflowStore.setState({
      catalog: null,
      workflows: [current],
      selectedWorkflowId: current.id,
      draft,
      issues: [],
      semanticDirty: true,
      saving: true,
    });

    await useDeploymentWorkflowStore.getState().initialize();

    expect(mocks.capabilities).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      initialized: false,
      saving: true,
      semanticDirty: true,
      draft,
    });
  });

  it('drops native validation results that raced with a draft switch', async () => {
    const current = record();
    const other = { ...record(), id: 'workflow-2', name: 'Other site' };
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current, other] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);

    let resolveValidate: ((result: { valid: boolean; errors: { code: 'CYCLE_DETECTED' }[]; compiled: object }) => void) | undefined;
    mocks.validate.mockImplementationOnce(() => new Promise((resolve) => {
      resolveValidate = resolve;
    }));

    const pending = useDeploymentWorkflowStore.getState().validateDraft();
    useDeploymentWorkflowStore.getState().selectWorkflow(other.id);
    resolveValidate!({ valid: false, errors: [{ code: 'CYCLE_DETECTED' }], compiled: {} });

    const issues = await pending;
    expect(issues.every((issue) => issue.source === 'local')).toBe(true);
    expect(useDeploymentWorkflowStore.getState().issues).toEqual([]);
    expect(useDeploymentWorkflowStore.getState().validating).toBe(false);
  });

  it('archives a workflow, removing its record and clearing the current draft', async () => {
    const current = record();
    const other = { ...record(), id: 'workflow-2', name: 'Other site' };
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current, other] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);

    const archived = await useDeploymentWorkflowStore.getState().archiveWorkflow(current.id);

    expect(archived).toBe(true);
    expect(mocks.archive).toHaveBeenCalledWith(current.id, current.revision);
    expect(useDeploymentWorkflowStore.getState().workflows.map((item) => item.id)).toEqual([other.id]);
    expect(useDeploymentWorkflowStore.getState()).toMatchObject({
      selectedWorkflowId: null,
      selectedNodeId: null,
      draft: null,
      semanticDirty: false,
      layoutDirty: false,
      error: null,
    });
  });

  it('refuses to archive while the workflow has a dirty draft', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    useDeploymentWorkflowStore.getState().updateNode('source', { displayName: 'Local edit' });

    const archived = await useDeploymentWorkflowStore.getState().archiveWorkflow(current.id);

    expect(archived).toBe(false);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(useDeploymentWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useDeploymentWorkflowStore.getState().semanticDirty).toBe(true);
  });

  it('surfaces archive revision conflicts through the shared error channel', async () => {
    const current = record();
    useDeploymentWorkflowStore.setState({ catalog: null, workflows: [current] });
    useDeploymentWorkflowStore.getState().selectWorkflow(current.id);
    mocks.archive.mockRejectedValue(new Error('DEPLOYMENT_WORKFLOW_REVISION_CONFLICT'));

    const archived = await useDeploymentWorkflowStore.getState().archiveWorkflow(current.id);

    expect(archived).toBe(false);
    expect(useDeploymentWorkflowStore.getState().error).toContain('REVISION_CONFLICT');
    expect(useDeploymentWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useDeploymentWorkflowStore.getState().draft?.id).toBe(current.id);
  });
});
