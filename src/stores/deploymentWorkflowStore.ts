import { create } from 'zustand';
import { getErrorMessage } from '@/lib/error';
import {
  buildDeploymentTemplate,
  createNodeFromCatalog,
  DEPLOYMENT_FLOW_CONTENT_PADDING,
  localDeploymentEditorIssues,
  mapNativeValidationErrors,
  type DeploymentEditorIssue,
  type DeploymentWorkflowTemplateKind,
} from '@/lib/deployment/editor';
import type {
  DeploymentJsonValue,
  DeploymentNodeTypeCatalog,
  DeploymentPortBinding,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowLayout,
  DeploymentWorkflowNode,
  DeploymentWorkflowCapabilities,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import {
  invokeArchiveDeploymentWorkflow,
  invokeCreateDeploymentWorkflow,
  invokeDeploymentWorkflowCapabilities,
  invokeListDeploymentNodeTypes,
  invokeListDeploymentWorkflows,
  invokeUpdateDeploymentWorkflowLayout,
  invokeUpdateDeploymentWorkflow,
  invokeValidateDeploymentWorkflow,
} from '@/lib/ipc/tauri';
import { t, type LocaleKey } from '@/locales';

export interface DeploymentWorkflowDraft {
  id: string | null;
  name: string;
  enabled: boolean;
  revision: number;
  layoutRevision: number;
  definition: DeploymentWorkflowDefinition;
  layout: DeploymentWorkflowLayout;
  templateKind?: DeploymentWorkflowTemplateKind;
}

export interface DeploymentEditorNotice {
  id: number;
  kind: 'created' | 'saved' | 'layoutSaved';
}

export type DeploymentWorkflowTab = 'pipeline' | 'runs' | 'versions';

interface DeploymentWorkflowStoreState {
  capabilities: DeploymentWorkflowCapabilities | null;
  catalog: DeploymentNodeTypeCatalog | null;
  workflows: DeploymentWorkflowRecord[];
  selectedWorkflowId: string | null;
  selectedNodeId: string | null;
  draft: DeploymentWorkflowDraft | null;
  initialized: boolean;
  loading: boolean;
  saving: boolean;
  validating: boolean;
  semanticDirty: boolean;
  layoutDirty: boolean;
  issues: DeploymentEditorIssue[];
  error: string | null;
  notice: DeploymentEditorNotice | null;
  profileFilterId: string | null;
  activeTab: DeploymentWorkflowTab;
  requestedTab: DeploymentWorkflowTab | null;
  deployRequested: boolean;
  pendingSelectionId: string | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  selectWorkflow: (id: string) => boolean;
  confirmPendingSelection: () => void;
  clearPendingSelection: () => void;
  setProfileFilter: (profileId: string | null) => void;
  setActiveTab: (tab: DeploymentWorkflowTab) => void;
  requestTab: (tab: DeploymentWorkflowTab) => void;
  clearRequestedTab: () => void;
  requestDeploy: () => void;
  clearDeployRequest: () => void;
  startTemplate: (
    kind: DeploymentWorkflowTemplateKind,
    name: string,
    connectionProfileId: string,
    remoteRoot: string,
  ) => void;
  selectNode: (id: string | null) => void;
  updateWorkflowMeta: (input: { name?: string; enabled?: boolean }) => void;
  addNode: (typeName: string, typeVersion: number) => void;
  removeNode: (id: string) => void;
  updateNode: (id: string, input: Partial<Pick<DeploymentWorkflowNode, 'displayName' | 'timeoutSeconds' | 'retry'>>) => void;
  updateNodeConfig: (id: string, name: string, value: DeploymentJsonValue) => void;
  connectInput: (
    targetNodeId: string,
    targetPort: string,
    binding: DeploymentPortBinding | null,
  ) => void;
  disconnectInput: (targetNodeId: string, targetPort: string) => void;
  reconnectInput: (
    previousTargetNodeId: string,
    previousTargetPort: string,
    targetNodeId: string,
    targetPort: string,
    binding: DeploymentPortBinding,
  ) => void;
  validateDraft: () => Promise<DeploymentEditorIssue[]>;
  saveDraft: () => Promise<DeploymentWorkflowRecord>;
  archiveWorkflow: (id: string) => Promise<boolean>;
  clearError: () => void;
  clearNotice: () => void;
  reset: () => void;
}

const EMPTY_LAYOUT: DeploymentWorkflowLayout = {
  schemaVersion: 1,
  nodes: {},
  groups: [],
};

function cloneRecord(record: DeploymentWorkflowRecord): DeploymentWorkflowDraft {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    revision: record.revision,
    layoutRevision: record.layoutRevision,
    definition: structuredClone(record.definition),
    layout: structuredClone(record.layout ?? EMPTY_LAYOUT),
  };
}

function sortWorkflows(workflows: readonly DeploymentWorkflowRecord[]): DeploymentWorkflowRecord[] {
  return [...workflows].sort((left, right) => left.name.localeCompare(right.name));
}

function replaceWorkflow(
  workflows: readonly DeploymentWorkflowRecord[],
  record: DeploymentWorkflowRecord,
): DeploymentWorkflowRecord[] {
  return sortWorkflows([
    ...workflows.filter((item) => item.id !== record.id),
    record,
  ]);
}

function localIssues(
  draft: DeploymentWorkflowDraft | null,
  catalog: DeploymentNodeTypeCatalog | null,
): DeploymentEditorIssue[] {
  return draft ? localDeploymentEditorIssues(draft.definition, catalog) : [];
}

function translatedNodeName(catalog: DeploymentNodeTypeCatalog | null, typeName: string): string {
  const spec = catalog?.nodes.find((item) => item.typeName === typeName);
  return spec ? t(spec.displayNameKey as LocaleKey) : typeName;
}

let noticeSequence = 0;

const initialState = {
  capabilities: null,
  catalog: null,
  workflows: [] as DeploymentWorkflowRecord[],
  selectedWorkflowId: null,
  selectedNodeId: null,
  draft: null,
  initialized: false,
  loading: false,
  saving: false,
  validating: false,
  semanticDirty: false,
  layoutDirty: false,
  issues: [] as DeploymentEditorIssue[],
  error: null,
  notice: null,
  profileFilterId: null,
  activeTab: 'pipeline' as DeploymentWorkflowTab,
  requestedTab: null,
  deployRequested: false,
  pendingSelectionId: null,
};

export const useDeploymentWorkflowStore = create<DeploymentWorkflowStoreState>((set, get) => ({
  ...initialState,
  initialize: async () => {
    if (get().loading || get().saving) return;
    set({ loading: true, error: null });
    try {
      const [capabilities, catalog, page] = await Promise.all([
        invokeDeploymentWorkflowCapabilities(),
        invokeListDeploymentNodeTypes(),
        invokeListDeploymentWorkflows(null, 100, false),
      ]);
      const workflows = sortWorkflows(page.items);
      const selected = workflows.find((item) => item.id === get().selectedWorkflowId) ?? workflows[0];
      set({
        capabilities,
        catalog,
        workflows,
        selectedWorkflowId: selected?.id ?? null,
        selectedNodeId: selected?.definition.nodes[0]?.id ?? null,
        draft: selected ? cloneRecord(selected) : null,
        issues: selected ? localDeploymentEditorIssues(selected.definition, catalog) : [],
        initialized: true,
        loading: false,
        semanticDirty: false,
        layoutDirty: false,
        pendingSelectionId: null,
      });
    } catch (error) {
      set({ loading: false, initialized: true, error: getErrorMessage(error) });
      throw error;
    }
  },
  refresh: async () => {
    if (get().saving) return;
    set({ loading: true, error: null });
    try {
      const page = await invokeListDeploymentWorkflows(null, 100, false);
      const workflows = sortWorkflows(page.items);
      const selected = workflows.find((item) => item.id === get().selectedWorkflowId) ?? workflows[0];
      set({
        workflows,
        selectedWorkflowId: selected?.id ?? null,
        selectedNodeId: selected?.definition.nodes[0]?.id ?? null,
        draft: selected ? cloneRecord(selected) : null,
        issues: localIssues(selected ? cloneRecord(selected) : null, get().catalog),
        loading: false,
        semanticDirty: false,
        layoutDirty: false,
        pendingSelectionId: null,
      });
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  selectWorkflow: (id) => {
    const state = get();
    if (state.saving) return false;
    if (state.selectedWorkflowId === id && state.draft?.id === id) return true;
    const record = state.workflows.find((item) => item.id === id);
    if (!record) return false;
    if (state.semanticDirty || state.layoutDirty) {
      set({ pendingSelectionId: id });
      return false;
    }
    const draft = cloneRecord(record);
    set({
      selectedWorkflowId: id,
      selectedNodeId: record.definition.nodes[0]?.id ?? null,
      draft,
      semanticDirty: false,
      layoutDirty: false,
      issues: localIssues(draft, get().catalog),
      error: null,
      pendingSelectionId: null,
    });
    return true;
  },
  confirmPendingSelection: () => {
    const id = get().pendingSelectionId;
    const record = id ? get().workflows.find((item) => item.id === id) : null;
    if (!record) {
      set({ pendingSelectionId: null });
      return;
    }
    const draft = cloneRecord(record);
    set({
      selectedWorkflowId: record.id,
      selectedNodeId: record.definition.nodes[0]?.id ?? null,
      draft,
      semanticDirty: false,
      layoutDirty: false,
      issues: localIssues(draft, get().catalog),
      error: null,
      pendingSelectionId: null,
    });
  },
  clearPendingSelection: () => set({ pendingSelectionId: null }),
  setProfileFilter: (profileFilterId) => set({ profileFilterId }),
  setActiveTab: (activeTab) => set({ activeTab }),
  requestTab: (requestedTab) => set({ requestedTab }),
  clearRequestedTab: () => set({ requestedTab: null }),
  requestDeploy: () => set({ deployRequested: true }),
  clearDeployRequest: () => set({ deployRequested: false }),
  startTemplate: (kind, name, connectionProfileId, remoteRoot) => {
    if (get().saving) return;
    const { catalog, profileFilterId } = get();
    const { definition, layout } = buildDeploymentTemplate(
      kind,
      { connectionProfileId, remoteRoot },
      (typeName) => translatedNodeName(catalog, typeName),
    );
    const draft: DeploymentWorkflowDraft = {
      id: null,
      name,
      enabled: false,
      revision: 0,
      layoutRevision: 0,
      definition,
      layout,
      templateKind: kind,
    };
    set({
      profileFilterId: profileFilterId === connectionProfileId
        ? profileFilterId
        : null,
      selectedWorkflowId: null,
      selectedNodeId: definition.nodes[0]?.id ?? null,
      draft,
      semanticDirty: true,
      layoutDirty: true,
      issues: localIssues(draft, catalog),
      error: null,
      pendingSelectionId: null,
    });
  },
  selectNode: (id) => set({ selectedNodeId: id }),
  updateWorkflowMeta: (input) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    const next = { ...draft, ...input };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  addNode: (typeName, typeVersion) => {
    const { draft, catalog } = get();
    const spec = catalog?.nodes.find(
      (item) => item.typeName === typeName && item.typeVersion === typeVersion,
    );
    if (!draft || !spec || get().saving) return;
    const created = createNodeFromCatalog(
      spec,
      draft.definition.nodes,
      t(spec.displayNameKey as LocaleKey),
    );
    const firstTarget = draft.definition.targets[0];
    const added = firstTarget && Object.prototype.hasOwnProperty.call(created.config, 'targetId')
      ? { ...created, config: { ...created.config, targetId: firstTarget.id } }
      : created;
    const index = draft.definition.nodes.length;
    const next: DeploymentWorkflowDraft = {
      ...draft,
      definition: { ...draft.definition, nodes: [...draft.definition.nodes, added] },
      layout: {
        ...draft.layout,
        nodes: {
          ...draft.layout.nodes,
          [added.id]: {
            x: DEPLOYMENT_FLOW_CONTENT_PADDING + (index % 4) * 280,
            y: DEPLOYMENT_FLOW_CONTENT_PADDING + Math.floor(index / 4) * 190,
          },
        },
      },
    };
    set({
      draft: next,
      selectedNodeId: added.id,
      semanticDirty: true,
      layoutDirty: true,
      issues: localIssues(next, catalog),
    });
  },
  removeNode: (id) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    const nodes = draft.definition.nodes
      .filter((item) => item.id !== id)
      .map((item) => ({
        ...item,
        inputs: Object.fromEntries(
          Object.entries(item.inputs).filter(([, binding]) => binding.fromNodeId !== id),
        ),
      }));
    const { [id]: _removedLayout, ...layoutNodes } = draft.layout.nodes;
    const next: DeploymentWorkflowDraft = {
      ...draft,
      definition: {
        ...draft.definition,
        nodes,
        outputs: Object.fromEntries(
          Object.entries(draft.definition.outputs).filter(([, binding]) => binding.fromNodeId !== id),
        ),
      },
      layout: { ...draft.layout, nodes: layoutNodes },
    };
    set({
      draft: next,
      selectedNodeId: get().selectedNodeId === id ? nodes[0]?.id ?? null : get().selectedNodeId,
      semanticDirty: true,
      layoutDirty: true,
      issues: localIssues(next, get().catalog),
    });
  },
  updateNode: (id, input) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    const next = {
      ...draft,
      definition: {
        ...draft.definition,
        nodes: draft.definition.nodes.map((item) => item.id === id ? { ...item, ...input } : item),
      },
    };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  updateNodeConfig: (id, name, value) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    const next = {
      ...draft,
      definition: {
        ...draft.definition,
        nodes: draft.definition.nodes.map((item) => item.id === id
          ? { ...item, config: { ...item.config, [name]: value } }
          : item),
      },
    };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  connectInput: (targetNodeId, targetPort, binding) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    const next = {
      ...draft,
      definition: {
        ...draft.definition,
        nodes: draft.definition.nodes.map((item) => {
          if (item.id !== targetNodeId) return item;
          const inputs = { ...item.inputs };
          if (binding) inputs[targetPort] = binding;
          else delete inputs[targetPort];
          return { ...item, inputs };
        }),
      },
    };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  disconnectInput: (targetNodeId, targetPort) => {
    const draft = get().draft;
    const targetNode = draft?.definition.nodes.find((item) => item.id === targetNodeId);
    if (!draft || !targetNode?.inputs[targetPort] || get().saving) return;
    const next: DeploymentWorkflowDraft = {
      ...draft,
      definition: {
        ...draft.definition,
        nodes: draft.definition.nodes.map((item) => {
          if (item.id !== targetNodeId) return item;
          const inputs = { ...item.inputs };
          delete inputs[targetPort];
          return { ...item, inputs };
        }),
      },
    };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  reconnectInput: (
    previousTargetNodeId,
    previousTargetPort,
    targetNodeId,
    targetPort,
    binding,
  ) => {
    const draft = get().draft;
    if (!draft || get().saving) return;
    let changed = false;
    const nodes = draft.definition.nodes.map((item) => {
      if (item.id !== previousTargetNodeId && item.id !== targetNodeId) return item;
      const inputs = { ...item.inputs };
      let nodeChanged = false;
      if (item.id === previousTargetNodeId && inputs[previousTargetPort]) {
        delete inputs[previousTargetPort];
        nodeChanged = true;
      }
      if (item.id === targetNodeId) {
        const current = inputs[targetPort];
        if (current?.fromNodeId !== binding.fromNodeId || current.fromPort !== binding.fromPort) {
          inputs[targetPort] = binding;
          nodeChanged = true;
        }
      }
      changed ||= nodeChanged;
      return nodeChanged ? { ...item, inputs } : item;
    });
    if (!changed) return;
    const next: DeploymentWorkflowDraft = {
      ...draft,
      definition: { ...draft.definition, nodes },
    };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  validateDraft: async () => {
    const { draft, catalog } = get();
    if (!draft) return [];
    set({ validating: true });
    const immediate = localDeploymentEditorIssues(draft.definition, catalog);
    try {
      const result = await invokeValidateDeploymentWorkflow(draft.definition);
      const latest = get().draft;
      if (!latest) {
        set({ validating: false });
        return [];
      }
      if (latest.id !== draft.id || latest.revision !== draft.revision) {
        // The draft moved on (selection change or concurrent save) while the
        // native validator ran; the returned issues describe a stale definition.
        set({ validating: false });
        return localDeploymentEditorIssues(latest.definition, get().catalog);
      }
      const issues = [...immediate, ...mapNativeValidationErrors(result.errors)];
      set({ issues, validating: false, error: null });
      return issues;
    } catch (error) {
      set({ validating: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  saveDraft: async () => {
    const state = get();
    const { draft } = state;
    if (!draft || state.saving) throw new Error('DEPLOYMENT_WORKFLOW_NO_DRAFT');
    set({ saving: true, error: null });
    try {
      const validation = await invokeValidateDeploymentWorkflow(draft.definition);
      const issues = [
        ...localDeploymentEditorIssues(draft.definition, state.catalog),
        ...mapNativeValidationErrors(validation.errors),
      ];
      if (!validation.valid || issues.length > 0) {
        set({ saving: false, issues });
        throw new Error('DEPLOYMENT_WORKFLOW_VALIDATION_FAILED');
      }
      let record: DeploymentWorkflowRecord;
      let noticeKind: DeploymentEditorNotice['kind'];
      if (!draft.id) {
        record = await invokeCreateDeploymentWorkflow({
          name: draft.name.trim(),
          definition: draft.definition,
          layout: draft.layout,
          enabled: draft.enabled,
        });
        noticeKind = 'created';
      } else {
        if (state.semanticDirty) {
          record = await invokeUpdateDeploymentWorkflow(draft.id, draft.revision, {
              name: draft.name.trim(),
              definition: draft.definition,
              enabled: draft.enabled,
            });
          const semanticDraft: DeploymentWorkflowDraft = {
            ...draft,
            name: record.name,
            enabled: record.enabled,
            revision: record.revision,
            definition: structuredClone(record.definition),
          };
          set({
            workflows: replaceWorkflow(get().workflows, record),
            draft: semanticDraft,
            semanticDirty: false,
          });
        } else {
          const existing = state.workflows.find((item) => item.id === draft.id);
          if (!existing) throw new Error('DEPLOYMENT_WORKFLOW_NOT_FOUND');
          record = existing;
        }
        noticeKind = state.semanticDirty ? 'saved' : 'layoutSaved';
        if (state.layoutDirty) {
          const layoutRecord = await invokeUpdateDeploymentWorkflowLayout(
            draft.id,
            draft.layoutRevision,
            { layout: draft.layout },
          );
          record = { ...record, layoutRevision: layoutRecord.layoutRevision, layout: layoutRecord.layout };
          const currentDraft = get().draft;
          if (currentDraft?.id === draft.id) {
            set({
              workflows: replaceWorkflow(get().workflows, record),
              draft: {
                ...currentDraft,
                layoutRevision: layoutRecord.layoutRevision,
                layout: structuredClone(layoutRecord.layout),
              },
              layoutDirty: false,
            });
          }
        }
      }
      const workflows = replaceWorkflow(get().workflows, record);
      const nextDraft = cloneRecord(record);
      noticeSequence += 1;
      set({
        workflows,
        selectedWorkflowId: record.id,
        draft: nextDraft,
        saving: false,
        semanticDirty: false,
        layoutDirty: false,
        issues: localIssues(nextDraft, get().catalog),
        notice: { id: noticeSequence, kind: noticeKind },
      });
      return record;
    } catch (error) {
      set({ saving: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  clearError: () => set({ error: null }),
  clearNotice: () => set({ notice: null }),
  reset: () => set(initialState),
  archiveWorkflow: async (id) => {
    const state = get();
    if (state.saving) return false;
    const record = state.workflows.find((item) => item.id === id);
    if (!record) return false;
    // A dirty draft of this workflow must be explicitly discarded by the UI
    // (its confirm dialog discloses that) before archiving; the store does not
    // discard unsaved edits on its own.
    if (state.draft?.id === id && (state.semanticDirty || state.layoutDirty)) return false;
    try {
      await invokeArchiveDeploymentWorkflow(id, record.revision);
    } catch (error) {
      set({ error: getErrorMessage(error) });
      return false;
    }
    const clearingCurrent = state.draft?.id === id;
    set({
      workflows: state.workflows.filter((item) => item.id !== id),
      ...(clearingCurrent ? {
        selectedWorkflowId: null,
        selectedNodeId: null,
        draft: null,
        semanticDirty: false,
        layoutDirty: false,
        issues: [],
        pendingSelectionId: null,
      } : {}),
    });
    return true;
  },
}));
