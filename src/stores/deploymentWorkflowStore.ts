import { create } from 'zustand';
import { getErrorMessage } from '@/lib/error';
import {
  buildDeploymentTemplate,
  createNodeFromCatalog,
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
  requestedTab: 'design' | 'prepare' | 'runs' | 'versions' | null;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  selectWorkflow: (id: string) => void;
  setProfileFilter: (profileId: string | null) => void;
  requestTab: (tab: 'design' | 'prepare' | 'runs' | 'versions') => void;
  clearRequestedTab: () => void;
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
  moveNode: (id: string, x: number, y: number) => void;
  validateDraft: () => Promise<DeploymentEditorIssue[]>;
  saveDraft: () => Promise<DeploymentWorkflowRecord>;
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
  requestedTab: null,
};

export const useDeploymentWorkflowStore = create<DeploymentWorkflowStoreState>((set, get) => ({
  ...initialState,
  initialize: async () => {
    if (get().loading) return;
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
      });
    } catch (error) {
      set({ loading: false, initialized: true, error: getErrorMessage(error) });
      throw error;
    }
  },
  refresh: async () => {
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
      });
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  selectWorkflow: (id) => {
    const record = get().workflows.find((item) => item.id === id);
    if (!record) return;
    const draft = cloneRecord(record);
    set({
      selectedWorkflowId: id,
      selectedNodeId: record.definition.nodes[0]?.id ?? null,
      draft,
      semanticDirty: false,
      layoutDirty: false,
      issues: localIssues(draft, get().catalog),
      error: null,
    });
  },
  setProfileFilter: (profileFilterId) => set({ profileFilterId }),
  requestTab: (requestedTab) => set({ requestedTab }),
  clearRequestedTab: () => set({ requestedTab: null }),
  startTemplate: (kind, name, connectionProfileId, remoteRoot) => {
    const catalog = get().catalog;
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
      selectedWorkflowId: null,
      selectedNodeId: definition.nodes[0]?.id ?? null,
      draft,
      semanticDirty: true,
      layoutDirty: true,
      issues: localIssues(draft, catalog),
      error: null,
    });
  },
  selectNode: (id) => set({ selectedNodeId: id }),
  updateWorkflowMeta: (input) => {
    const draft = get().draft;
    if (!draft) return;
    const next = { ...draft, ...input };
    set({ draft: next, semanticDirty: true, issues: localIssues(next, get().catalog) });
  },
  addNode: (typeName, typeVersion) => {
    const { draft, catalog } = get();
    const spec = catalog?.nodes.find(
      (item) => item.typeName === typeName && item.typeVersion === typeVersion,
    );
    if (!draft || !spec) return;
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
          [added.id]: { x: (index % 4) * 280, y: Math.floor(index / 4) * 190 },
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
    if (!draft) return;
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
    if (!draft) return;
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
    if (!draft) return;
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
    if (!draft) return;
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
  moveNode: (id, x, y) => {
    const draft = get().draft;
    if (!draft || !Number.isFinite(x) || !Number.isFinite(y)) return;
    set({
      draft: {
        ...draft,
        layout: {
          ...draft.layout,
          nodes: {
            ...draft.layout.nodes,
            [id]: { ...draft.layout.nodes[id], x, y },
          },
        },
      },
      layoutDirty: true,
    });
  },
  validateDraft: async () => {
    const { draft, catalog } = get();
    if (!draft) return [];
    set({ validating: true });
    const immediate = localDeploymentEditorIssues(draft.definition, catalog);
    try {
      const result = await invokeValidateDeploymentWorkflow(draft.definition);
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
}));
