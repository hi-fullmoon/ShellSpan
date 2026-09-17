import { create } from 'zustand';
import { getErrorMessage } from '@/lib/error';
import type {
  DeploymentArtifactInspection,
  DeploymentNodeAttemptRecord,
  DeploymentReleaseRecord,
  DeploymentRunDetail,
  DeploymentRunEvent,
  DeploymentRunNodeRecord,
  DeploymentRunSummary,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import {
  invokeApproveDeploymentRun,
  invokeCancelDeploymentRun,
  invokeGetDeploymentRunDetail,
  invokeInspectDeploymentArtifact,
  invokeListDeploymentNodeAttempts,
  invokeListDeploymentReleases,
  invokeListDeploymentRunEvents,
  invokeListDeploymentRunNodes,
  invokeListDeploymentRuns,
  invokePrepareDeploymentRun,
  invokeReconcileDeploymentRun,
  invokeStartDeploymentRun,
  listenToDeploymentNodeProgress,
} from '@/lib/ipc/tauri';

export type DeploymentRunNoticeKind =
  | 'prepared'
  | 'rollbackPrepared'
  | 'started'
  | 'canceled'
  | 'reconciled'
  | 'refreshed';

export interface DeploymentRunNotice {
  id: number;
  kind: DeploymentRunNoticeKind;
}

export interface DeploymentPreparationNode {
  nodeId: string;
  displayName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
}

interface DeploymentWorkflowRunState {
  workflowId: string | null;
  runs: DeploymentRunSummary[];
  nextRunCursor: string | null;
  selectedRunId: string | null;
  detail: DeploymentRunDetail | null;
  nodes: DeploymentRunNodeRecord[];
  events: DeploymentRunEvent[];
  nextEventSequence: number | null;
  selectedNodeId: string | null;
  attempts: DeploymentNodeAttemptRecord[];
  nextAttempt: number | null;
  releases: DeploymentReleaseRecord[];
  artifact: DeploymentArtifactInspection | null;
  loading: boolean;
  loadingMoreRuns: boolean;
  loadingMoreEvents: boolean;
  loadingAttempts: boolean;
  preparing: boolean;
  preparationNodes: DeploymentPreparationNode[];
  preparationCompleted: number;
  preparationTotal: number;
  action: 'approve' | 'cancel' | 'reconcile' | 'artifact' | null;
  error: string | null;
  notice: DeploymentRunNotice | null;
  loadWorkflow: (workflowId: string) => Promise<void>;
  refreshWorkflow: (workflowId: string, notify?: boolean) => Promise<void>;
  loadMoreRuns: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  refreshSelectedRun: () => Promise<void>;
  selectNode: (nodeId: string) => Promise<void>;
  loadMoreAttempts: () => Promise<void>;
  loadMoreEvents: () => Promise<void>;
  prepare: (workflow: DeploymentWorkflowRecord, rollbackReleaseId?: string) => Promise<void>;
  approveAndStart: () => Promise<void>;
  cancel: () => Promise<void>;
  reconcile: () => Promise<void>;
  inspectArtifact: (artifactReference: DeploymentArtifactInspection['handle']['artifactReference']) => Promise<void>;
  clearArtifact: () => void;
  clearError: () => void;
  clearNotice: () => void;
  reset: () => void;
}

let noticeSequence = 0;
let workflowLoadSequence = 0;

const initialState = {
  workflowId: null,
  runs: [] as DeploymentRunSummary[],
  nextRunCursor: null,
  selectedRunId: null,
  detail: null,
  nodes: [] as DeploymentRunNodeRecord[],
  events: [] as DeploymentRunEvent[],
  nextEventSequence: null,
  selectedNodeId: null,
  attempts: [] as DeploymentNodeAttemptRecord[],
  nextAttempt: null,
  releases: [] as DeploymentReleaseRecord[],
  artifact: null,
  loading: false,
  loadingMoreRuns: false,
  loadingMoreEvents: false,
  loadingAttempts: false,
  preparing: false,
  preparationNodes: [] as DeploymentPreparationNode[],
  preparationCompleted: 0,
  preparationTotal: 0,
  action: null,
  error: null,
  notice: null,
};

function nextNotice(kind: DeploymentRunNoticeKind): DeploymentRunNotice {
  noticeSequence += 1;
  return { id: noticeSequence, kind };
}

async function runDetail(runId: string): Promise<{
  detail: DeploymentRunDetail;
  nodes: DeploymentRunNodeRecord[];
  events: DeploymentRunEvent[];
  nextEventSequence: number | null;
  attempts: DeploymentNodeAttemptRecord[];
  nextAttempt: number | null;
}> {
  const [detail, nodes, eventPage] = await Promise.all([
    invokeGetDeploymentRunDetail(runId),
    invokeListDeploymentRunNodes(runId),
    invokeListDeploymentRunEvents(runId, null, 50),
  ]);
  if (!detail) throw new Error('DEPLOYMENT_WORKFLOW_RUN_NOT_FOUND');
  const attemptPage = nodes[0]
    ? await invokeListDeploymentNodeAttempts(runId, nodes[0].nodeId, null, 20)
    : { items: [], nextBeforeAttempt: null };
  return {
    detail,
    nodes,
    events: [...eventPage.items],
    nextEventSequence: eventPage.nextBeforeSequence,
    attempts: [...attemptPage.items],
    nextAttempt: attemptPage.nextBeforeAttempt,
  };
}

export const useDeploymentWorkflowRunStore = create<DeploymentWorkflowRunState>((set, get) => ({
  ...initialState,
  loadWorkflow: async (workflowId) => {
    const sequence = ++workflowLoadSequence;
    set({ ...initialState, workflowId, loading: true });
    try {
      const [page, releases] = await Promise.all([
        invokeListDeploymentRuns(workflowId, null, 20),
        invokeListDeploymentReleases(workflowId),
      ]);
      if (sequence !== workflowLoadSequence || get().workflowId !== workflowId) return;
      const selectedRunId = page.items[0]?.runId ?? null;
      const selected = selectedRunId ? await runDetail(selectedRunId) : null;
      if (sequence !== workflowLoadSequence || get().workflowId !== workflowId) return;
      set({
        runs: [...page.items],
        nextRunCursor: page.nextCursor,
        releases,
        selectedRunId,
        detail: selected?.detail ?? null,
        nodes: selected?.nodes ?? [],
        events: selected?.events ?? [],
        nextEventSequence: selected?.nextEventSequence ?? null,
        selectedNodeId: selected?.nodes[0]?.nodeId ?? null,
        attempts: selected?.attempts ?? [],
        nextAttempt: selected?.nextAttempt ?? null,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (sequence === workflowLoadSequence) set({ loading: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  refreshWorkflow: async (workflowId, notify = false) => {
    if (get().workflowId !== workflowId) return get().loadWorkflow(workflowId);
    set({ loading: true, error: null });
    try {
      const [page, releases] = await Promise.all([
        invokeListDeploymentRuns(workflowId, null, 20),
        invokeListDeploymentReleases(workflowId),
      ]);
      const selectedRunId = get().selectedRunId && page.items.some((run) => run.runId === get().selectedRunId)
        ? get().selectedRunId
        : page.items[0]?.runId ?? null;
      const selected = selectedRunId ? await runDetail(selectedRunId) : null;
      set({
        runs: [...page.items],
        nextRunCursor: page.nextCursor,
        releases,
        selectedRunId,
        detail: selected?.detail ?? null,
        nodes: selected?.nodes ?? [],
        events: selected?.events ?? [],
        nextEventSequence: selected?.nextEventSequence ?? null,
        selectedNodeId: selected?.nodes[0]?.nodeId ?? null,
        attempts: selected?.attempts ?? [],
        nextAttempt: selected?.nextAttempt ?? null,
        loading: false,
        notice: notify ? nextNotice('refreshed') : get().notice,
      });
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  loadMoreRuns: async () => {
    const { workflowId, nextRunCursor, loadingMoreRuns } = get();
    if (!workflowId || !nextRunCursor || loadingMoreRuns) return;
    set({ loadingMoreRuns: true });
    try {
      const page = await invokeListDeploymentRuns(workflowId, nextRunCursor, 20);
      set({
        runs: [...get().runs, ...page.items],
        nextRunCursor: page.nextCursor,
        loadingMoreRuns: false,
      });
    } catch (error) {
      set({ loadingMoreRuns: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  selectRun: async (runId) => {
    set({ selectedRunId: runId, loading: true, selectedNodeId: null, attempts: [], nextAttempt: null });
    try {
      const selected = await runDetail(runId);
      if (get().selectedRunId !== runId) return;
      set({
        ...selected,
        selectedNodeId: selected.nodes[0]?.nodeId ?? null,
        loading: false,
        error: null,
      });
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  refreshSelectedRun: async () => {
    const runId = get().selectedRunId;
    if (!runId) return;
    const selected = await runDetail(runId);
    if (get().selectedRunId !== runId) return;
    set({ ...selected, error: null });
  },
  selectNode: async (nodeId) => {
    const runId = get().selectedRunId;
    set({ selectedNodeId: nodeId, attempts: [], nextAttempt: null });
    if (!runId) return;
    set({ loadingAttempts: true });
    try {
      const page = await invokeListDeploymentNodeAttempts(runId, nodeId, null, 20);
      if (get().selectedRunId !== runId || get().selectedNodeId !== nodeId) return;
      set({ attempts: [...page.items], nextAttempt: page.nextBeforeAttempt, loadingAttempts: false });
    } catch (error) {
      set({ loadingAttempts: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  loadMoreAttempts: async () => {
    const { selectedRunId, selectedNodeId, nextAttempt, loadingAttempts } = get();
    if (!selectedRunId || !selectedNodeId || !nextAttempt || loadingAttempts) return;
    set({ loadingAttempts: true });
    try {
      const page = await invokeListDeploymentNodeAttempts(
        selectedRunId,
        selectedNodeId,
        nextAttempt,
        20,
      );
      set({
        attempts: [...get().attempts, ...page.items],
        nextAttempt: page.nextBeforeAttempt,
        loadingAttempts: false,
      });
    } catch (error) {
      set({ loadingAttempts: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  loadMoreEvents: async () => {
    const { selectedRunId, nextEventSequence, loadingMoreEvents } = get();
    if (!selectedRunId || !nextEventSequence || loadingMoreEvents) return;
    set({ loadingMoreEvents: true });
    try {
      const page = await invokeListDeploymentRunEvents(selectedRunId, nextEventSequence, 50);
      set({
        events: [...get().events, ...page.items],
        nextEventSequence: page.nextBeforeSequence,
        loadingMoreEvents: false,
      });
    } catch (error) {
      set({ loadingMoreEvents: false, error: getErrorMessage(error) });
      throw error;
    }
  },
  prepare: async (workflow, rollbackReleaseId) => {
    if (get().preparing) return;
    const approvalIndex = workflow.definition.nodes.findIndex((node) => node.type === 'control.approval');
    const preApprovalNodes = workflow.definition.nodes
      .slice(0, approvalIndex < 0 ? workflow.definition.nodes.length : approvalIndex)
      .map((node, index) => ({
        nodeId: node.id,
        displayName: node.displayName,
        status: index === 0 ? 'running' as const : 'pending' as const,
      }));
    set({
      preparing: true,
      preparationNodes: preApprovalNodes,
      preparationCompleted: 0,
      preparationTotal: preApprovalNodes.length,
      error: null,
    });
    let unlisten: (() => void) | null = null;
    try {
      let lastSequence = 0;
      unlisten = await listenToDeploymentNodeProgress((event) => {
        const progress = event.payload;
        if (progress.sequence <= lastSequence) return;
        lastSequence = progress.sequence;
        set((current) => ({
          preparationNodes: current.preparationNodes.map((node) => node.nodeId === progress.nodeId
            ? { ...node, status: progress.phase }
            : node),
          preparationCompleted: progress.completed,
          preparationTotal: progress.total,
        }));
      });
      const prepared = await invokePrepareDeploymentRun({
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        operationKind: rollbackReleaseId ? 'rollback' : 'deploy',
        triggerKind: 'manual',
        parameters: {},
        ...(rollbackReleaseId ? { rollbackReleaseId } : {}),
      });
      const [page, releases, selected] = await Promise.all([
        invokeListDeploymentRuns(workflow.id, null, 20),
        invokeListDeploymentReleases(workflow.id),
        runDetail(prepared.runId),
      ]);
      set({
        workflowId: workflow.id,
        runs: [...page.items],
        nextRunCursor: page.nextCursor,
        releases,
        selectedRunId: prepared.runId,
        ...selected,
        selectedNodeId: selected.nodes[0]?.nodeId ?? null,
        preparing: false,
        preparationNodes: [],
        preparationCompleted: 0,
        preparationTotal: 0,
        notice: nextNotice(rollbackReleaseId ? 'rollbackPrepared' : 'prepared'),
      });
    } catch (error) {
      set({
        preparing: false,
        preparationNodes: [],
        preparationCompleted: 0,
        preparationTotal: 0,
        error: getErrorMessage(error),
      });
      throw error;
    } finally {
      unlisten?.();
    }
  },
  approveAndStart: async () => {
    const summary = get().detail?.summary;
    if (!summary || get().action) return;
    set({ action: 'approve', error: null });
    try {
      const binding = { runId: summary.runId, planDigest: summary.planDigest };
      await invokeApproveDeploymentRun(binding);
      await invokeStartDeploymentRun(binding);
      const selected = await runDetail(summary.runId);
      set({ ...selected, action: null, notice: nextNotice('started') });
    } catch (error) {
      const latest = await runDetail(summary.runId).catch(() => null);
      set({
        ...(latest ?? {}),
        action: null,
        error: getErrorMessage(error),
      });
      throw error;
    }
  },
  cancel: async () => {
    const runId = get().selectedRunId;
    if (!runId || get().action) return;
    set({ action: 'cancel', error: null });
    try {
      await invokeCancelDeploymentRun({ runId });
      const selected = await runDetail(runId);
      set({ ...selected, action: null, notice: nextNotice('canceled') });
    } catch (error) {
      set({ action: null, error: getErrorMessage(error) });
      throw error;
    }
  },
  reconcile: async () => {
    const runId = get().selectedRunId;
    if (!runId || get().action) return;
    set({ action: 'reconcile', error: null });
    try {
      await invokeReconcileDeploymentRun({ runId });
      const selected = await runDetail(runId);
      set({ ...selected, action: null, notice: nextNotice('reconciled') });
    } catch (error) {
      set({ action: null, error: getErrorMessage(error) });
      throw error;
    }
  },
  inspectArtifact: async (artifactReference) => {
    set({ action: 'artifact', error: null });
    try {
      const artifact = await invokeInspectDeploymentArtifact(artifactReference);
      set({ artifact, action: null });
    } catch (error) {
      set({ action: null, error: getErrorMessage(error) });
      throw error;
    }
  },
  clearArtifact: () => set({ artifact: null }),
  clearError: () => set({ error: null }),
  clearNotice: () => set({ notice: null }),
  reset: () => {
    workflowLoadSequence += 1;
    set(initialState);
  },
}));
