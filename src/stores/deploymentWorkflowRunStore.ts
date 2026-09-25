import { create } from 'zustand';
import { getErrorMessage } from '@/lib/error';
import { topologyOrder } from '@/lib/deployment/editor';
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
  preparationRunId: string | null;
  cancelPreparation: () => Promise<void>;
  preparationNodes: DeploymentPreparationNode[];
  preparationCompleted: number;
  preparationTotal: number;
  action: 'approve' | 'cancel' | 'reconcile' | 'artifact' | null;
  error: string | null;
  errorContext: 'prepare' | 'operation' | null;
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
let runDetailLoadSequence = 0;
let attemptLoadSequence = 0;
let actionSequence = 0;

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
  preparationRunId: null,
  preparationNodes: [] as DeploymentPreparationNode[],
  preparationCompleted: 0,
  preparationTotal: 0,
  action: null,
  error: null,
  errorContext: null,
  notice: null,
};

function nextNotice(kind: DeploymentRunNoticeKind): DeploymentRunNotice {
  noticeSequence += 1;
  return { id: noticeSequence, kind };
}

async function runDetail(
  runId: string,
  nodeId?: string | null,
): Promise<{
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
  const attemptNodeId = nodeId ?? nodes[0]?.nodeId ?? null;
  const attemptPage = attemptNodeId
    ? await invokeListDeploymentNodeAttempts(runId, attemptNodeId, null, 20)
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

function preparationNodes(workflow: DeploymentWorkflowRecord): DeploymentPreparationNode[] {
  const approval = workflow.definition.nodes.find((node) => node.type === 'control.approval');
  if (!approval) {
    return topologyOrder(workflow.definition).map((node, index) => ({
      nodeId: node.id,
      displayName: node.displayName,
      status: index === 0 ? 'running' : 'pending',
    }));
  }
  const nodesById = new Map(workflow.definition.nodes.map((node) => [node.id, node]));
  const upstream = new Set<string>();
  const pending = [approval.id];
  while (pending.length > 0) {
    const node = nodesById.get(pending.pop()!);
    if (!node) continue;
    for (const binding of Object.values(node.inputs)) {
      if (upstream.has(binding.fromNodeId)) continue;
      upstream.add(binding.fromNodeId);
      pending.push(binding.fromNodeId);
    }
  }
  return topologyOrder(workflow.definition)
    .filter((node) => upstream.has(node.id))
    .map((node, index) => ({
      nodeId: node.id,
      displayName: node.displayName,
      status: index === 0 ? 'running' : 'pending',
    }));
}

export const useDeploymentWorkflowRunStore = create<DeploymentWorkflowRunState>((set, get) => ({
  ...initialState,
  loadWorkflow: async (workflowId) => {
    const sequence = ++workflowLoadSequence;
    const detailSequence = ++runDetailLoadSequence;
    attemptLoadSequence += 1;
    actionSequence += 1;
    set({ ...initialState, workflowId, loading: true });
    try {
      const [page, releases] = await Promise.all([
        invokeListDeploymentRuns(workflowId, null, 20),
        invokeListDeploymentReleases(workflowId),
      ]);
      if (sequence !== workflowLoadSequence || get().workflowId !== workflowId) return;
      const selectedRunId = page.items[0]?.runId ?? null;
      const selected = selectedRunId ? await runDetail(selectedRunId) : null;
      if (sequence !== workflowLoadSequence
        || detailSequence !== runDetailLoadSequence
        || get().workflowId !== workflowId) return;
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
        errorContext: null,
      });
    } catch (error) {
      if (sequence === workflowLoadSequence && get().workflowId === workflowId) {
        set({ loading: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  refreshWorkflow: async (workflowId, notify = false) => {
    if (get().workflowId !== workflowId) return get().loadWorkflow(workflowId);
    const sequence = ++workflowLoadSequence;
    const detailSequence = ++runDetailLoadSequence;
    attemptLoadSequence += 1;
    set({ loading: true, error: null, errorContext: null });
    try {
      const [page, releases] = await Promise.all([
        invokeListDeploymentRuns(workflowId, null, 20),
        invokeListDeploymentReleases(workflowId),
      ]);
      const selectedRunId = get().selectedRunId && page.items.some((run) => run.runId === get().selectedRunId)
        ? get().selectedRunId
        : page.items[0]?.runId ?? null;
      const selected = selectedRunId ? await runDetail(selectedRunId) : null;
      if (sequence !== workflowLoadSequence
        || detailSequence !== runDetailLoadSequence
        || get().workflowId !== workflowId) return;
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
        errorContext: null,
        notice: notify ? nextNotice('refreshed') : get().notice,
      });
    } catch (error) {
      if (sequence === workflowLoadSequence && get().workflowId === workflowId) {
        set({ loading: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  loadMoreRuns: async () => {
    const { workflowId, nextRunCursor, loadingMoreRuns } = get();
    if (!workflowId || !nextRunCursor || loadingMoreRuns) return;
    set({ loadingMoreRuns: true });
    try {
      const page = await invokeListDeploymentRuns(workflowId, nextRunCursor, 20);
      if (get().workflowId !== workflowId || get().nextRunCursor !== nextRunCursor) return;
      set({
        runs: [...get().runs, ...page.items],
        nextRunCursor: page.nextCursor,
        loadingMoreRuns: false,
      });
    } catch (error) {
      if (get().workflowId === workflowId) {
        set({ loadingMoreRuns: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  selectRun: async (runId) => {
    if (get().action) return;
    const sequence = ++runDetailLoadSequence;
    attemptLoadSequence += 1;
    set({
      selectedRunId: runId,
      loading: true,
      detail: null,
      nodes: [],
      events: [],
      nextEventSequence: null,
      selectedNodeId: null,
      attempts: [],
      nextAttempt: null,
      artifact: null,
      loadingMoreEvents: false,
      loadingAttempts: false,
      error: null,
      errorContext: null,
    });
    try {
      const selected = await runDetail(runId);
      if (sequence !== runDetailLoadSequence || get().selectedRunId !== runId) return;
      set({
        ...selected,
        selectedNodeId: selected.nodes[0]?.nodeId ?? null,
        loading: false,
        error: null,
        errorContext: null,
      });
    } catch (error) {
      if (sequence === runDetailLoadSequence && get().selectedRunId === runId) {
        set({ loading: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  refreshSelectedRun: async () => {
    const runId = get().selectedRunId;
    if (!runId) return;
    const sequence = ++runDetailLoadSequence;
    try {
      const selectedNodeId = get().selectedNodeId;
      const selected = await runDetail(runId, selectedNodeId);
      const releases = selected.detail.summary.status !== get().detail?.summary.status
        && ['succeeded', 'failed', 'canceled', 'state_unknown'].includes(selected.detail.summary.status)
        ? await invokeListDeploymentReleases(selected.detail.summary.workflowId) : get().releases;
      if (sequence !== runDetailLoadSequence || get().selectedRunId !== runId) return;
      const previous = get().events;
      const seen = new Set(previous.map((event) => event.sequence));
      const events = [...selected.events.filter((event) => !seen.has(event.sequence)), ...previous];
      const nodeIds = new Set(selected.nodes.map((node) => node.nodeId));
      const nextSelectedNodeId = selectedNodeId && nodeIds.has(selectedNodeId)
        ? selectedNodeId
        : selected.nodes[0]?.nodeId ?? null;
      set({
        detail: selected.detail,
        runs: get().runs.map((run) => run.runId === runId ? selected.detail.summary : run),
        releases,
        nodes: selected.nodes,
        events,
        nextEventSequence: get().nextEventSequence ?? selected.nextEventSequence,
        attempts: selected.attempts,
        nextAttempt: selected.nextAttempt,
        selectedNodeId: nextSelectedNodeId,
        error: null,
        errorContext: null,
      });
    } catch (error) {
      if (sequence !== runDetailLoadSequence || get().selectedRunId !== runId) return;
      const message = getErrorMessage(error);
      if (get().error === message) return;
      set({ error: message, errorContext: 'operation' });
    }
  },
  selectNode: async (nodeId) => {
    const runId = get().selectedRunId;
    const sequence = ++attemptLoadSequence;
    set({ selectedNodeId: nodeId, attempts: [], nextAttempt: null });
    if (!runId) return;
    set({ loadingAttempts: true });
    try {
      const page = await invokeListDeploymentNodeAttempts(runId, nodeId, null, 20);
      if (sequence !== attemptLoadSequence
        || get().selectedRunId !== runId
        || get().selectedNodeId !== nodeId) return;
      set({ attempts: [...page.items], nextAttempt: page.nextBeforeAttempt, loadingAttempts: false, errorContext: null });
    } catch (error) {
      if (sequence === attemptLoadSequence
        && get().selectedRunId === runId
        && get().selectedNodeId === nodeId) {
        set({ loadingAttempts: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
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
      if (get().selectedRunId !== selectedRunId
        || get().selectedNodeId !== selectedNodeId
        || get().nextAttempt !== nextAttempt) return;
      set({
        attempts: [...get().attempts, ...page.items],
        nextAttempt: page.nextBeforeAttempt,
        loadingAttempts: false,
      });
    } catch (error) {
      if (get().selectedRunId === selectedRunId && get().selectedNodeId === selectedNodeId) {
        set({ loadingAttempts: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  loadMoreEvents: async () => {
    const { selectedRunId, nextEventSequence, loadingMoreEvents } = get();
    if (!selectedRunId || !nextEventSequence || loadingMoreEvents) return;
    set({ loadingMoreEvents: true });
    try {
      const page = await invokeListDeploymentRunEvents(selectedRunId, nextEventSequence, 50);
      if (get().selectedRunId !== selectedRunId || get().nextEventSequence !== nextEventSequence) return;
      set({
        events: [...get().events, ...page.items],
        nextEventSequence: page.nextBeforeSequence,
        loadingMoreEvents: false,
      });
    } catch (error) {
      if (get().selectedRunId === selectedRunId) {
        set({ loadingMoreEvents: false, error: getErrorMessage(error), errorContext: 'operation' });
      }
      throw error;
    }
  },
  prepare: async (workflow, rollbackReleaseId) => {
    if (get().preparing || get().loading || get().action) return;
    const sequence = ++workflowLoadSequence;
    const preApprovalNodes = preparationNodes(workflow);
    set({
      preparing: true,
      preparationNodes: preApprovalNodes,
      preparationCompleted: 0,
      preparationTotal: preApprovalNodes.length,
      error: null,
      errorContext: null,
      workflowId: workflow.id,
    });
    let unlisten: (() => void) | null = null;
    try {
      let lastSequence = 0;
      let preparedRunId: string | null = null;
      unlisten = await listenToDeploymentNodeProgress((event) => {
        const progress = event.payload;
        if (sequence !== workflowLoadSequence || get().workflowId !== workflow.id) return;
        if (progress.workflowId && progress.workflowId !== workflow.id) return;
        if (!preparedRunId && progress.workflowId === workflow.id) {
          preparedRunId = progress.runId;
          set({ preparationRunId: progress.runId });
        }
        if (preparedRunId && progress.runId !== preparedRunId) return;
        if (progress.sequence <= lastSequence) return;
        lastSequence = progress.sequence;
        set((current) => {
          if (!current.preparationNodes.some((node) => node.nodeId === progress.nodeId)) return {};
          return {
            preparationNodes: current.preparationNodes.map((node) => node.nodeId === progress.nodeId
              ? { ...node, status: progress.phase }
              : node),
            preparationCompleted: progress.completed,
            preparationTotal: progress.total,
          };
        });
      });
      const prepared = await invokePrepareDeploymentRun({
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        operationKind: rollbackReleaseId ? 'rollback' : 'deploy',
        triggerKind: 'manual',
        parameters: {},
        ...(rollbackReleaseId ? { rollbackReleaseId } : {}),
      });
      preparedRunId = prepared.runId;
      const [page, releases, selected] = await Promise.all([
        invokeListDeploymentRuns(workflow.id, null, 20),
        invokeListDeploymentReleases(workflow.id),
        runDetail(prepared.runId),
      ]);
      if (sequence !== workflowLoadSequence || get().workflowId !== workflow.id) return;
      runDetailLoadSequence += 1;
      attemptLoadSequence += 1;
      set({
        workflowId: workflow.id,
        loading: false,
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
        errorContext: null,
      });
    } catch (error) {
      if (sequence === workflowLoadSequence && get().workflowId === workflow.id) {
        set({
          preparing: false,
          preparationNodes: [],
          preparationCompleted: 0,
          preparationTotal: 0,
          error: getErrorMessage(error),
          errorContext: 'prepare',
        });
      }
      throw error;
    } finally {
      unlisten?.();
      set({ preparationRunId: null });
      if (get().preparing) {
        set({ preparing: false, preparationNodes: [], preparationCompleted: 0, preparationTotal: 0 });
      }
    }
  },
  cancelPreparation: async () => {
    const runId = get().preparationRunId;
    if (runId) await invokeCancelDeploymentRun({ runId });
  },
  approveAndStart: async () => {
    const summary = get().detail?.summary;
    if (!summary || get().action) return;
    const sequence = ++actionSequence;
    set({ action: 'approve', error: null });
    try {
      const binding = { runId: summary.runId, planDigest: summary.planDigest };
      if (summary.status === 'awaiting_approval') {
        await invokeApproveDeploymentRun(binding);
      } else if (summary.status !== 'approved') {
        throw new Error('DEPLOYMENT_WORKFLOW_RUN_NOT_STARTABLE');
      }
      await invokeStartDeploymentRun(binding);
      const selected = await runDetail(summary.runId, get().selectedNodeId);
      if (sequence !== actionSequence || get().selectedRunId !== summary.runId) return;
      set({ ...selected, action: null, notice: nextNotice('started'), errorContext: null });
    } catch (error) {
      const latest = await runDetail(summary.runId, get().selectedNodeId).catch(() => null);
      if (sequence !== actionSequence || get().selectedRunId !== summary.runId) throw error;
      set({
        ...(latest ?? {}),
        action: null,
        error: getErrorMessage(error),
        errorContext: 'operation',
      });
      throw error;
    }
  },
  cancel: async () => {
    const runId = get().selectedRunId;
    if (!runId || get().action) return;
    const sequence = ++actionSequence;
    set({ action: 'cancel', error: null });
    try {
      await invokeCancelDeploymentRun({ runId });
      const selected = await runDetail(runId, get().selectedNodeId);
      if (sequence !== actionSequence || get().selectedRunId !== runId) return;
      set({ ...selected, action: null, notice: nextNotice('canceled'), errorContext: null });
    } catch (error) {
      if (sequence !== actionSequence || get().selectedRunId !== runId) throw error;
      set({ action: null, error: getErrorMessage(error), errorContext: 'operation' });
      throw error;
    }
  },
  reconcile: async () => {
    const runId = get().selectedRunId;
    if (!runId || get().action) return;
    const sequence = ++actionSequence;
    set({ action: 'reconcile', error: null });
    try {
      await invokeReconcileDeploymentRun({ runId });
      const selected = await runDetail(runId, get().selectedNodeId);
      if (sequence !== actionSequence || get().selectedRunId !== runId) return;
      set({ ...selected, action: null, notice: nextNotice('reconciled'), errorContext: null });
    } catch (error) {
      if (sequence !== actionSequence || get().selectedRunId !== runId) throw error;
      set({ action: null, error: getErrorMessage(error), errorContext: 'operation' });
      throw error;
    }
  },
  inspectArtifact: async (artifactReference) => {
    if (get().action) return;
    const sequence = ++actionSequence;
    set({ action: 'artifact', error: null });
    try {
      const artifact = await invokeInspectDeploymentArtifact(artifactReference);
      if (sequence !== actionSequence) return;
      set({ artifact, action: null, errorContext: null });
    } catch (error) {
      if (sequence !== actionSequence) throw error;
      set({ action: null, error: getErrorMessage(error), errorContext: 'operation' });
      throw error;
    }
  },
  clearArtifact: () => set({ artifact: null }),
  clearError: () => set({ error: null, errorContext: null }),
  clearNotice: () => set({ notice: null }),
  reset: () => {
    workflowLoadSequence += 1;
    runDetailLoadSequence += 1;
    attemptLoadSequence += 1;
    actionSequence += 1;
    set(initialState);
  },
}));
