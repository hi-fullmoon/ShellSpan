import { create } from 'zustand';
import type {
  DeploymentArtifactBuildProgress,
  DeploymentArtifactBuildResult,
  DeploymentArtifactTransferProgress,
  DeploymentArtifactTransferResult,
  DeploymentPreflightRequest,
  DeploymentPreflightResult,
  DeploymentNotificationReceipt,
  DeploymentReconciliationResult,
  DeploymentRemoteRunnerProgress,
  DeploymentRemoteRunnerResult,
  DeploymentRuntimeCapabilities,
  DeploymentRunDetail,
  DeploymentRunRecord,
  DeploymentStoredPlanRecord,
  DeploymentStartupRecoveryCandidate,
  DeploymentWorkflowCreate,
  DeploymentWorkflowRecord,
  DeploymentWorkflowUpdate,
} from '@/lib/deployment/types';
import {
  invokeBuildDeploymentArtifact,
  invokeApproveDeploymentPlan,
  invokeCancelDeploymentArtifactBuild,
  invokeCancelDeploymentArtifactTransfer,
  invokeCancelDeploymentPreflight,
  invokeCancelDeploymentRemoteRunner,
  invokeCancelDeploymentReconciliationObservation,
  invokeClaimDeploymentNotifications,
  invokeCreateDeploymentPlan,
  invokeCreateDeploymentWorkflow,
  invokeDeleteDeploymentWorkflow,
  invokeDeploymentPreflight,
  invokeDeploymentArtifactSourceSnapshot,
  invokeDeploymentReconcile,
  invokeDeploymentReconciliationBinding,
  invokeDeploymentRuntimeCapabilities,
  invokeDeploymentStartupRecovery,
  invokeGetDeploymentPlan,
  invokeGetDeploymentRunDetail,
  invokeRejectDeploymentPlan,
  invokeRequestDeploymentApproval,
  invokeRunDeploymentRemote,
  invokeTransferDeploymentArtifact,
  invokeListDeploymentWorkflows,
  invokeListDeploymentRunEventsBefore,
  invokeListDeploymentRunPage,
  invokeUpdateDeploymentWorkflow,
  listenToDeploymentArtifactBuildProgress,
  listenToDeploymentArtifactTransferProgress,
  listenToDeploymentRemoteRunnerProgress,
} from '@/lib/ipc/tauri';
import { getErrorMessage } from '@/lib/error';
import { generateId } from '@/lib/utils';

export type DeploymentPreflightPhase = 'idle' | 'running' | 'cancelling';
export type DeploymentArtifactBuildPhase = 'idle' | 'snapshotting' | 'running' | 'cancelling';
export type DeploymentArtifactTransferPhase = 'idle' | 'running' | 'cancelling';
export type DeploymentApprovalPhase = 'idle' | 'requesting' | 'deciding';
export type DeploymentRemoteRunnerPhase = 'idle' | 'running' | 'cancelling';
export type DeploymentReconciliationPhase = 'idle' | 'running' | 'stopping';

interface RecoveredApprovedBinding {
  planId: string;
  artifactTransferOperationId: string;
  remoteStagingIdentity: string;
}

interface DeploymentStoreState {
  runtimeCapabilities: DeploymentRuntimeCapabilities | null;
  workflows: DeploymentWorkflowRecord[];
  selectedWorkflowId: string | null;
  profileFilterId: string | null;
  initialized: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  runs: DeploymentRunRecord[];
  runsLoading: boolean;
  runsLoadingMore: boolean;
  runsError: string | null;
  runsNextCursor: string | null;
  selectedRunId: string | null;
  runDetail: DeploymentRunDetail | null;
  runDetailLoading: boolean;
  notificationReceipts: DeploymentNotificationReceipt[];
  navigationTarget: 'history' | 'newRelease' | null;
  recoveryCandidates: DeploymentStartupRecoveryCandidate[];
  recoveryDiscoveryFailed: boolean;
  reconciliationPhase: DeploymentReconciliationPhase;
  reconciliationOperationId: string | null;
  reconciliationRunId: string | null;
  reconciliationResults: Readonly<Record<string, DeploymentReconciliationResult>>;
  recoveredApprovedBinding: RecoveredApprovedBinding | null;
  artifactBuildPhase: DeploymentArtifactBuildPhase;
  artifactBuildOperationId: string | null;
  artifactWorkflowId: string | null;
  artifactBuildProgress: DeploymentArtifactBuildProgress | null;
  artifactBuildResult: DeploymentArtifactBuildResult | null;
  preflightPhase: DeploymentPreflightPhase;
  preflightOperationId: string | null;
  preflightWorkflowId: string | null;
  preflightResult: DeploymentPreflightResult | null;
  plan: DeploymentStoredPlanRecord | null;
  approvalPhase: DeploymentApprovalPhase;
  artifactTransferPhase: DeploymentArtifactTransferPhase;
  artifactTransferOperationId: string | null;
  artifactTransferWorkflowId: string | null;
  artifactTransferProgress: DeploymentArtifactTransferProgress | null;
  artifactTransferResult: DeploymentArtifactTransferResult | null;
  remoteRunnerPhase: DeploymentRemoteRunnerPhase;
  remoteRunnerOperationId: string | null;
  remoteRunnerWorkflowId: string | null;
  remoteRunnerProgress: DeploymentRemoteRunnerProgress | null;
  remoteRunnerLog: DeploymentRemoteRunnerProgress[];
  remoteRunnerResult: DeploymentRemoteRunnerResult | null;
  loadWorkflows: () => Promise<void>;
  loadRunHistory: (reset?: boolean) => Promise<void>;
  selectRun: (runId: string | null) => Promise<void>;
  loadEarlierRunEvents: () => Promise<void>;
  claimNotifications: () => Promise<DeploymentNotificationReceipt[]>;
  prepareNewPlan: (workflowId: string) => void;
  requestNewRelease: (workflowId: string) => void;
  selectWorkflow: (workflowId: string | null) => void;
  setProfileFilter: (profileId: string | null) => void;
  createWorkflow: (input: DeploymentWorkflowCreate) => Promise<DeploymentWorkflowRecord>;
  updateWorkflow: (
    id: string,
    input: DeploymentWorkflowUpdate,
  ) => Promise<DeploymentWorkflowRecord>;
  deleteWorkflow: (id: string, expectedRevision: number) => Promise<void>;
  buildArtifact: (
    workflowId: string,
    expectedRevision: number,
  ) => Promise<DeploymentArtifactBuildResult>;
  cancelArtifactBuild: () => Promise<void>;
  runPreflight: (
    input: Omit<DeploymentPreflightRequest, 'operationId' | 'artifactReference'>,
  ) => Promise<DeploymentPreflightResult>;
  cancelPreflight: () => Promise<void>;
  createPlan: () => Promise<DeploymentStoredPlanRecord>;
  requestApproval: () => Promise<DeploymentStoredPlanRecord>;
  approvePlan: () => Promise<DeploymentStoredPlanRecord>;
  rejectPlan: () => Promise<DeploymentStoredPlanRecord>;
  transferArtifact: () => Promise<DeploymentArtifactTransferResult>;
  cancelArtifactTransfer: () => Promise<void>;
  runRemote: () => Promise<DeploymentRemoteRunnerResult>;
  cancelRemoteRunner: () => Promise<void>;
  reconcileRun: (runId: string) => Promise<DeploymentReconciliationResult>;
  stopReconciliationObservation: () => Promise<void>;
  clearError: () => void;
  clearPreflight: () => void;
}

function isRevisionConflict(error: unknown): boolean {
  return getErrorMessage(error).includes('REVISION_CONFLICT');
}

function assertRecoveryGateClear(state: DeploymentStoreState): void {
  if (state.runtimeCapabilities?.admissionsEnabled === false) {
    throw new Error('DEPLOYMENT_ADMISSIONS_DISABLED');
  }
  if (
    state.recoveryDiscoveryFailed
    || state.recoveryCandidates.length > 0
    || state.reconciliationPhase !== 'idle'
  ) {
    throw new Error('DEPLOYMENT_RECONCILIATION_REQUIRED');
  }
}

function replaceWorkflow(
  workflows: DeploymentWorkflowRecord[],
  next: DeploymentWorkflowRecord,
): DeploymentWorkflowRecord[] {
  const exists = workflows.some((workflow) => workflow.id === next.id);
  const updated = exists
    ? workflows.map((workflow) => (workflow.id === next.id ? next : workflow))
    : [...workflows, next];
  return updated.sort((left, right) => left.name.localeCompare(right.name));
}

function artifactMatchesWorkflow(
  artifact: DeploymentArtifactBuildResult | null,
  workflow: DeploymentWorkflowRecord | undefined,
): boolean {
  return Boolean(
    artifact?.status === 'succeeded'
    && artifact.artifactReference
    && artifact.manifest
    && workflow
    && artifact.workflowId === workflow.id
    && artifact.workflowRevision === workflow.revision
    && artifact.manifest.workflowId === workflow.id
    && artifact.manifest.workflowRevision === workflow.revision,
  );
}

function transferInputsMatch(
  transfer: DeploymentArtifactTransferResult | null,
  workflowId: string | null,
  artifact: DeploymentArtifactBuildResult | null,
  plan: DeploymentStoredPlanRecord | null,
  workflows: DeploymentWorkflowRecord[],
): boolean {
  const workflow = workflows.find((item) => item.id === workflowId);
  return Boolean(
    transfer?.status === 'succeeded'
    && transfer.remoteStagingIdentity
    && workflow
    && artifactMatchesWorkflow(artifact, workflow)
    && plan
    && plan.status === 'approved'
    && Date.now() < plan.expiresAt
    && transfer.planId === plan.planId
    && transfer.releaseId === artifact?.releaseId
    && transfer.remoteDigestSha256 === artifact?.artifactDigestSha256
    && plan.approvalSummary.workflowId === workflow.id
    && plan.approvalSummary.workflowRevision === workflow.revision
    && plan.approvalSummary.frozen.targetRelease.releaseId === artifact?.releaseId
    && plan.approvalSummary.frozen.targetRelease.artifactDigestSha256
      === artifact?.artifactDigestSha256,
  );
}

function approvalRequest(plan: DeploymentStoredPlanRecord) {
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    runId: plan.runId,
    runRevision: plan.runRevision,
    expiresAt: plan.expiresAt,
  };
}

export const useDeploymentStore = create<DeploymentStoreState>()((set, get) => ({
  runtimeCapabilities: null,
  workflows: [],
  selectedWorkflowId: null,
  profileFilterId: null,
  initialized: false,
  loading: false,
  saving: false,
  error: null,
  runs: [],
  runsLoading: false,
  runsLoadingMore: false,
  runsError: null,
  runsNextCursor: null,
  selectedRunId: null,
  runDetail: null,
  runDetailLoading: false,
  notificationReceipts: [],
  navigationTarget: null,
  recoveryCandidates: [],
  recoveryDiscoveryFailed: false,
  reconciliationPhase: 'idle',
  reconciliationOperationId: null,
  reconciliationRunId: null,
  reconciliationResults: {},
  recoveredApprovedBinding: null,
  artifactBuildPhase: 'idle',
  artifactBuildOperationId: null,
  artifactWorkflowId: null,
  artifactBuildProgress: null,
  artifactBuildResult: null,
  preflightPhase: 'idle',
  preflightOperationId: null,
  preflightWorkflowId: null,
  preflightResult: null,
  plan: null,
  approvalPhase: 'idle',
  artifactTransferPhase: 'idle',
  artifactTransferOperationId: null,
  artifactTransferWorkflowId: null,
  artifactTransferProgress: null,
  artifactTransferResult: null,
  remoteRunnerPhase: 'idle',
  remoteRunnerOperationId: null,
  remoteRunnerWorkflowId: null,
  remoteRunnerProgress: null,
  remoteRunnerLog: [],
  remoteRunnerResult: null,

  loadWorkflows: async () => {
    set({ loading: true, error: null });
    try {
      const [capabilities, workflows, recovery] = await Promise.all([
        invokeDeploymentRuntimeCapabilities(),
        invokeListDeploymentWorkflows(),
        invokeDeploymentStartupRecovery(),
      ]);
      let runPage: Awaited<ReturnType<typeof invokeListDeploymentRunPage>> | null = null;
      let runsError: string | null = null;
      try {
        runPage = await invokeListDeploymentRunPage(null, null, 50);
      } catch (historyError) {
        runsError = getErrorMessage(historyError);
      }
      set((state) => {
        const selectedWorkflowId = state.selectedWorkflowId
          && workflows.some((workflow) => workflow.id === state.selectedWorkflowId)
          ? state.selectedWorkflowId
          : workflows[0]?.id ?? null;
        const artifactWorkflow = workflows.find((workflow) => workflow.id === state.artifactWorkflowId);
        const keepArtifact = artifactMatchesWorkflow(state.artifactBuildResult, artifactWorkflow);
        const transferWorkflow = workflows.find(
          (workflow) => workflow.id === state.artifactTransferWorkflowId,
        );
        const transferContextMatches = !state.artifactTransferWorkflowId || Boolean(
          transferWorkflow
          && artifactMatchesWorkflow(state.artifactBuildResult, transferWorkflow)
          && state.plan
          && state.plan.approvalSummary.workflowId === transferWorkflow.id
          && state.plan.approvalSummary.workflowRevision === transferWorkflow.revision,
        );
        const keepTransfer = transferContextMatches && (
          !state.artifactTransferResult
          || transferInputsMatch(
            state.artifactTransferResult,
            state.artifactTransferWorkflowId,
            state.artifactBuildResult,
            state.plan,
            workflows,
          )
        );
        return {
          runtimeCapabilities: capabilities,
          workflows,
          runs: runPage?.items ?? state.runs,
          runsNextCursor: runPage?.nextCursor ?? state.runsNextCursor,
          runsError,
          recoveryCandidates: recovery.candidates,
          recoveryDiscoveryFailed: false,
          initialized: true,
          loading: false,
          selectedWorkflowId,
          ...(!keepArtifact && state.artifactBuildResult ? {
            artifactWorkflowId: null,
            artifactBuildResult: null,
            artifactBuildProgress: null,
            preflightResult: null,
            preflightWorkflowId: null,
            plan: null,
            approvalPhase: 'idle' as const,
            remoteRunnerPhase: 'idle' as const,
            remoteRunnerOperationId: null,
            remoteRunnerWorkflowId: null,
            remoteRunnerProgress: null,
            remoteRunnerLog: [],
            remoteRunnerResult: null,
          } : {}),
          ...(!keepTransfer && state.artifactTransferWorkflowId ? {
            artifactTransferWorkflowId: null,
            artifactTransferResult: null,
            artifactTransferProgress: null,
            artifactTransferPhase: 'idle' as const,
            artifactTransferOperationId: null,
          } : {}),
        };
      });
    } catch (error) {
      set({
        initialized: true,
        loading: false,
        recoveryDiscoveryFailed: true,
        error: getErrorMessage(error),
      });
      throw error;
    }
  },

  loadRunHistory: async (reset = true) => {
    const state = get();
    if (state.runsLoading || state.runsLoadingMore) return;
    if (!reset && !state.runsNextCursor) return;
    set(reset
      ? { runsLoading: true, runsError: null }
      : { runsLoadingMore: true, runsError: null });
    try {
      const page = await invokeListDeploymentRunPage(
        null,
        reset ? null : state.runsNextCursor,
        50,
      );
      set((current) => ({
        runs: reset
          ? page.items
          : [...current.runs, ...page.items.filter(
              (item) => !current.runs.some((existing) => existing.id === item.id),
            )],
        runsNextCursor: page.nextCursor,
        runsLoading: false,
        runsLoadingMore: false,
        runsError: null,
      }));
    } catch (error) {
      set({
        runsLoading: false,
        runsLoadingMore: false,
        runsError: getErrorMessage(error),
      });
      throw error;
    }
  },

  selectRun: async (runId) => {
    if (!runId) {
      set({ selectedRunId: null, runDetail: null, runDetailLoading: false });
      return;
    }
    set({ selectedRunId: runId, runDetail: null, runDetailLoading: true, navigationTarget: 'history' });
    try {
      const detail = await invokeGetDeploymentRunDetail(runId, 100);
      if (!detail) throw new Error('DEPLOYMENT_RUN_NOT_FOUND');
      set((state) => state.selectedRunId === runId ? {
        runDetail: detail,
        runDetailLoading: false,
        selectedWorkflowId: detail.run.workflowId,
      } : {});
    } catch (error) {
      set((state) => state.selectedRunId === runId ? {
        runDetailLoading: false,
        error: getErrorMessage(error),
      } : {});
      throw error;
    }
  },

  loadEarlierRunEvents: async () => {
    const detail = get().runDetail;
    const before = detail?.nextBeforeSequence;
    if (!detail || !before) return;
    const page = await invokeListDeploymentRunEventsBefore(detail.run.id, before, 100);
    set((state) => state.runDetail?.run.id === detail.run.id ? {
      runDetail: {
        ...state.runDetail,
        events: [...page.items, ...state.runDetail.events],
        nextBeforeSequence: page.nextBeforeSequence,
      },
    } : {});
  },

  claimNotifications: async () => {
    const receipts = await invokeClaimDeploymentNotifications(50);
    if (receipts.length > 0) {
      set((state) => ({
        notificationReceipts: [
          ...state.notificationReceipts,
          ...receipts.filter((receipt) => !state.notificationReceipts.some(
            (existing) => existing.runId === receipt.runId
              && existing.eventSequence === receipt.eventSequence
              && existing.kind === receipt.kind,
          )),
        ],
      }));
    }
    return receipts;
  },

  prepareNewPlan: (workflowId) => {
    get().selectWorkflow(workflowId);
    get().clearPreflight();
    set({ selectedRunId: null, runDetail: null, navigationTarget: 'newRelease' });
  },

  requestNewRelease: (workflowId) => {
    get().selectWorkflow(workflowId);
    set({ selectedRunId: null, runDetail: null, navigationTarget: 'newRelease' });
  },

  selectWorkflow: (selectedWorkflowId) => set((state) => ({
    selectedWorkflowId,
    artifactBuildResult: state.artifactWorkflowId === selectedWorkflowId
      ? state.artifactBuildResult
      : null,
    artifactBuildProgress: state.artifactWorkflowId === selectedWorkflowId
      ? state.artifactBuildProgress
      : null,
    artifactWorkflowId: state.artifactWorkflowId === selectedWorkflowId
      ? state.artifactWorkflowId
      : null,
    preflightResult: state.preflightWorkflowId === selectedWorkflowId
      ? state.preflightResult
      : null,
    plan: state.preflightWorkflowId === selectedWorkflowId ? state.plan : null,
    artifactTransferResult: state.artifactTransferWorkflowId === selectedWorkflowId
      ? state.artifactTransferResult
      : null,
    artifactTransferProgress: state.artifactTransferWorkflowId === selectedWorkflowId
      ? state.artifactTransferProgress
      : null,
    artifactTransferWorkflowId: state.artifactTransferWorkflowId === selectedWorkflowId
      ? state.artifactTransferWorkflowId
      : null,
    artifactTransferPhase: state.artifactTransferWorkflowId === selectedWorkflowId
      ? state.artifactTransferPhase
      : 'idle',
    artifactTransferOperationId: state.artifactTransferWorkflowId === selectedWorkflowId
      ? state.artifactTransferOperationId
      : null,
    remoteRunnerResult: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerResult
      : null,
    remoteRunnerProgress: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerProgress
      : null,
    remoteRunnerLog: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerLog
      : [],
    remoteRunnerWorkflowId: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerWorkflowId
      : null,
    remoteRunnerPhase: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerPhase
      : 'idle',
    remoteRunnerOperationId: state.remoteRunnerWorkflowId === selectedWorkflowId
      ? state.remoteRunnerOperationId
      : null,
  })),

  setProfileFilter: (profileFilterId) => set({ profileFilterId }),

  createWorkflow: async (input) => {
    if (get().runtimeCapabilities?.admissionsEnabled === false) {
      throw new Error('DEPLOYMENT_ADMISSIONS_DISABLED');
    }
    set({ saving: true, error: null });
    try {
      const created = await invokeCreateDeploymentWorkflow(input);
      set((state) => ({
        workflows: replaceWorkflow(state.workflows, created),
        selectedWorkflowId: created.id,
        saving: false,
        preflightResult: null,
        preflightWorkflowId: null,
        plan: null,
        approvalPhase: 'idle',
        artifactBuildResult: null,
        artifactBuildProgress: null,
        artifactWorkflowId: null,
        artifactTransferWorkflowId: null,
        artifactTransferResult: null,
        artifactTransferProgress: null,
        artifactTransferPhase: 'idle',
        artifactTransferOperationId: null,
        remoteRunnerPhase: 'idle',
        remoteRunnerOperationId: null,
        remoteRunnerWorkflowId: null,
        remoteRunnerProgress: null,
        remoteRunnerLog: [],
        remoteRunnerResult: null,
      }));
      return created;
    } catch (error) {
      set({ saving: false, error: getErrorMessage(error) });
      throw error;
    }
  },

  updateWorkflow: async (id, input) => {
    if (get().runtimeCapabilities?.admissionsEnabled === false) {
      throw new Error('DEPLOYMENT_ADMISSIONS_DISABLED');
    }
    set({ saving: true, error: null });
    try {
      const updated = await invokeUpdateDeploymentWorkflow(id, input);
      set((state) => ({
        workflows: replaceWorkflow(state.workflows, updated),
        saving: false,
        artifactBuildResult: state.artifactWorkflowId === id ? null : state.artifactBuildResult,
        artifactBuildProgress: state.artifactWorkflowId === id ? null : state.artifactBuildProgress,
        artifactWorkflowId: state.artifactWorkflowId === id ? null : state.artifactWorkflowId,
        preflightResult: state.preflightWorkflowId === id ? null : state.preflightResult,
        preflightWorkflowId: state.preflightWorkflowId === id ? null : state.preflightWorkflowId,
        plan: state.preflightWorkflowId === id ? null : state.plan,
        approvalPhase: state.preflightWorkflowId === id ? 'idle' : state.approvalPhase,
        artifactTransferResult: state.artifactTransferWorkflowId === id
          ? null
          : state.artifactTransferResult,
        artifactTransferProgress: state.artifactTransferWorkflowId === id
          ? null
          : state.artifactTransferProgress,
        artifactTransferWorkflowId: state.artifactTransferWorkflowId === id
          ? null
          : state.artifactTransferWorkflowId,
        artifactTransferPhase: state.artifactTransferWorkflowId === id
          ? 'idle'
          : state.artifactTransferPhase,
        artifactTransferOperationId: state.artifactTransferWorkflowId === id
          ? null
          : state.artifactTransferOperationId,
        remoteRunnerResult: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerResult,
        remoteRunnerProgress: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerProgress,
        remoteRunnerLog: state.remoteRunnerWorkflowId === id ? [] : state.remoteRunnerLog,
        remoteRunnerWorkflowId: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerWorkflowId,
        remoteRunnerPhase: state.remoteRunnerWorkflowId === id ? 'idle' : state.remoteRunnerPhase,
        remoteRunnerOperationId: state.remoteRunnerWorkflowId === id
          ? null
          : state.remoteRunnerOperationId,
      }));
      return updated;
    } catch (error) {
      set({ saving: false, error: getErrorMessage(error) });
      if (isRevisionConflict(error)) {
        try {
          await get().loadWorkflows();
        } catch {
          // Keep the original compare-and-swap failure visible to the caller.
        }
      }
      throw error;
    }
  },

  deleteWorkflow: async (id, expectedRevision) => {
    if (get().runtimeCapabilities?.admissionsEnabled === false) {
      throw new Error('DEPLOYMENT_ADMISSIONS_DISABLED');
    }
    set({ saving: true, error: null });
    try {
      await invokeDeleteDeploymentWorkflow(id, expectedRevision);
      set((state) => {
        const workflows = state.workflows.filter((workflow) => workflow.id !== id);
        return {
          workflows,
          saving: false,
          selectedWorkflowId: state.selectedWorkflowId === id
            ? workflows[0]?.id ?? null
            : state.selectedWorkflowId,
          artifactBuildResult: state.artifactWorkflowId === id ? null : state.artifactBuildResult,
          artifactBuildProgress: state.artifactWorkflowId === id ? null : state.artifactBuildProgress,
          artifactWorkflowId: state.artifactWorkflowId === id ? null : state.artifactWorkflowId,
          preflightResult: state.preflightWorkflowId === id ? null : state.preflightResult,
          preflightWorkflowId: state.preflightWorkflowId === id ? null : state.preflightWorkflowId,
          plan: state.preflightWorkflowId === id ? null : state.plan,
          approvalPhase: state.preflightWorkflowId === id ? 'idle' : state.approvalPhase,
          artifactTransferResult: state.artifactTransferWorkflowId === id
            ? null
            : state.artifactTransferResult,
          artifactTransferProgress: state.artifactTransferWorkflowId === id
            ? null
            : state.artifactTransferProgress,
          artifactTransferWorkflowId: state.artifactTransferWorkflowId === id
            ? null
            : state.artifactTransferWorkflowId,
          artifactTransferPhase: state.artifactTransferWorkflowId === id
            ? 'idle'
            : state.artifactTransferPhase,
          artifactTransferOperationId: state.artifactTransferWorkflowId === id
            ? null
            : state.artifactTransferOperationId,
          remoteRunnerResult: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerResult,
          remoteRunnerProgress: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerProgress,
          remoteRunnerLog: state.remoteRunnerWorkflowId === id ? [] : state.remoteRunnerLog,
          remoteRunnerWorkflowId: state.remoteRunnerWorkflowId === id ? null : state.remoteRunnerWorkflowId,
          remoteRunnerPhase: state.remoteRunnerWorkflowId === id ? 'idle' : state.remoteRunnerPhase,
          remoteRunnerOperationId: state.remoteRunnerWorkflowId === id
            ? null
            : state.remoteRunnerOperationId,
        };
      });
    } catch (error) {
      set({ saving: false, error: getErrorMessage(error) });
      if (isRevisionConflict(error)) {
        try {
          await get().loadWorkflows();
        } catch {
          // Keep the original compare-and-swap failure visible to the caller.
        }
      }
      throw error;
    }
  },

  buildArtifact: async (workflowId, expectedRevision) => {
    assertRecoveryGateClear(get());
    const operationId = `deployment-artifact-build:${generateId()}`;
    set({
      error: null,
      artifactBuildPhase: 'snapshotting',
      artifactBuildOperationId: operationId,
      artifactWorkflowId: workflowId,
      artifactBuildProgress: null,
      artifactBuildResult: null,
      preflightWorkflowId: null,
      preflightResult: null,
      plan: null,
      approvalPhase: 'idle',
      artifactTransferWorkflowId: null,
      artifactTransferResult: null,
      artifactTransferProgress: null,
      artifactTransferPhase: 'idle',
      artifactTransferOperationId: null,
      remoteRunnerPhase: 'idle',
      remoteRunnerOperationId: null,
      remoteRunnerWorkflowId: null,
      remoteRunnerProgress: null,
      remoteRunnerLog: [],
      remoteRunnerResult: null,
    });
    let unlisten: (() => void) | null = null;
    try {
      const sourceRevision = await invokeDeploymentArtifactSourceSnapshot({
        workflowId,
        expectedRevision,
      });
      if (get().artifactBuildOperationId !== operationId) {
        throw new Error('DEPLOYMENT_ARTIFACT_BUILD_SUPERSEDED');
      }
      unlisten = await listenToDeploymentArtifactBuildProgress((event) => {
        const progress = event.payload;
        set((state) => (
          state.artifactBuildOperationId === operationId
          && progress.operationId === operationId
          && (state.artifactBuildProgress?.sequence ?? 0) < progress.sequence
            ? { artifactBuildProgress: progress }
            : {}
        ));
      });
      set({ artifactBuildPhase: 'running' });
      const result = await invokeBuildDeploymentArtifact({
        operationId,
        workflowId,
        expectedRevision,
        sourceRevision,
        builderKind: 'dockerBuildx',
        timeoutMs: 30 * 60 * 1_000,
      });
      set((state) => state.artifactBuildOperationId === operationId ? {
        artifactBuildPhase: 'idle',
        artifactBuildOperationId: null,
        artifactBuildResult: result,
      } : {});
      return result;
    } catch (error) {
      set((state) => state.artifactBuildOperationId === operationId ? {
        artifactBuildPhase: 'idle',
        artifactBuildOperationId: null,
        error: getErrorMessage(error),
      } : {});
      throw error;
    } finally {
      unlisten?.();
    }
  },

  cancelArtifactBuild: async () => {
    const operationId = get().artifactBuildOperationId;
    if (!operationId || get().artifactBuildPhase !== 'running') return;
    set({ artifactBuildPhase: 'cancelling' });
    try {
      await invokeCancelDeploymentArtifactBuild(operationId);
    } catch (error) {
      if (get().artifactBuildOperationId === operationId) {
        set({ error: getErrorMessage(error), artifactBuildPhase: 'running' });
      }
      throw error;
    }
  },

  runPreflight: async (input) => {
    assertRecoveryGateClear(get());
    const artifact = get().artifactBuildResult;
    const workflow = get().workflows.find((item) => item.id === input.workflowId);
    if (!artifactMatchesWorkflow(artifact, workflow) || !artifact?.artifactReference) {
      throw new Error('DEPLOYMENT_ARTIFACT_REQUIRED');
    }
    const currentSource = await invokeDeploymentArtifactSourceSnapshot({
      workflowId: input.workflowId,
      expectedRevision: input.expectedRevision,
    });
    if (
      !artifact.sourceRevision
      || currentSource.revision !== artifact.sourceRevision.revision
      || currentSource.dirty !== artifact.sourceRevision.dirty
    ) {
      set({
        artifactBuildResult: null,
        artifactBuildProgress: null,
        artifactWorkflowId: null,
        preflightResult: null,
        preflightWorkflowId: null,
        plan: null,
        artifactTransferPhase: 'idle',
        artifactTransferOperationId: null,
        artifactTransferWorkflowId: null,
        artifactTransferResult: null,
        artifactTransferProgress: null,
        remoteRunnerPhase: 'idle',
        remoteRunnerOperationId: null,
        remoteRunnerWorkflowId: null,
        remoteRunnerProgress: null,
        remoteRunnerLog: [],
        remoteRunnerResult: null,
        error: 'DEPLOYMENT_ARTIFACT_STALE_SOURCE',
      });
      throw new Error('DEPLOYMENT_ARTIFACT_STALE_SOURCE');
    }
    const operationId = `deployment-preflight:${generateId()}`;
    set({
      error: null,
      preflightPhase: 'running',
      preflightOperationId: operationId,
      preflightWorkflowId: input.workflowId,
      preflightResult: null,
      plan: null,
      approvalPhase: 'idle',
      artifactTransferWorkflowId: null,
      artifactTransferResult: null,
      artifactTransferProgress: null,
      artifactTransferPhase: 'idle',
      artifactTransferOperationId: null,
      remoteRunnerPhase: 'idle',
      remoteRunnerOperationId: null,
      remoteRunnerWorkflowId: null,
      remoteRunnerProgress: null,
      remoteRunnerLog: [],
      remoteRunnerResult: null,
    });
    try {
      const result = await invokeDeploymentPreflight({
        ...input,
        operationId,
        artifactReference: artifact.artifactReference,
      });
      set((state) => state.preflightOperationId === operationId ? {
        preflightPhase: 'idle',
        preflightOperationId: null,
        preflightResult: result,
        ...(result.failure?.category === 'artifactInvalid' || result.failure?.category === 'sourceChanged'
          ? {
              artifactBuildResult: null,
              artifactBuildProgress: null,
              artifactWorkflowId: null,
              plan: null,
            }
          : {}),
      } : {});
      return result;
    } catch (error) {
      set((state) => state.preflightOperationId === operationId ? {
        preflightPhase: 'idle',
        preflightOperationId: null,
        error: getErrorMessage(error),
      } : {});
      throw error;
    }
  },

  cancelPreflight: async () => {
    const operationId = get().preflightOperationId;
    if (!operationId || get().preflightPhase === 'idle') return;
    set({ preflightPhase: 'cancelling' });
    try {
      await invokeCancelDeploymentPreflight(operationId);
    } catch (error) {
      if (get().preflightOperationId === operationId) {
        set({ error: getErrorMessage(error), preflightPhase: 'running' });
      }
      throw error;
    }
  },

  createPlan: async () => {
    assertRecoveryGateClear(get());
    const result = get().preflightResult;
    const artifact = get().artifactBuildResult;
    const workflow = get().workflows.find((item) => item.id === result?.workflowId);
    if (
      !result?.planInput
      || result.status !== 'passed'
      || !artifactMatchesWorkflow(artifact, workflow)
      || result.artifactReference !== artifact?.artifactReference
    ) {
      throw new Error('DEPLOYMENT_PREFLIGHT_REQUIRED');
    }
    set({ saving: true, error: null });
    try {
      const plan = await invokeCreateDeploymentPlan(result.planInput);
      set({
        plan,
        saving: false,
        approvalPhase: 'idle',
        artifactTransferWorkflowId: null,
        artifactTransferResult: null,
        artifactTransferProgress: null,
        artifactTransferPhase: 'idle',
        artifactTransferOperationId: null,
        remoteRunnerPhase: 'idle',
        remoteRunnerOperationId: null,
        remoteRunnerWorkflowId: null,
        remoteRunnerProgress: null,
        remoteRunnerLog: [],
        remoteRunnerResult: null,
      });
      await get().loadRunHistory(true).catch(() => undefined);
      return plan;
    } catch (error) {
      set({ saving: false, error: getErrorMessage(error) });
      if (isRevisionConflict(error)) {
        try {
          await get().loadWorkflows();
        } catch {
          // The backend remains authoritative; leave the plan unset.
        }
      }
      throw error;
    }
  },

  requestApproval: async () => {
    assertRecoveryGateClear(get());
    const plan = get().plan;
    if (!plan || plan.status !== 'planned' || Date.now() >= plan.expiresAt) {
      throw new Error('DEPLOYMENT_PLAN_REQUIRED');
    }
    set({ approvalPhase: 'requesting', error: null });
    try {
      const updated = await invokeRequestDeploymentApproval(approvalRequest(plan));
      set({ plan: updated, approvalPhase: 'idle' });
      await get().loadRunHistory(true).catch(() => undefined);
      await get().claimNotifications().catch(() => []);
      return updated;
    } catch (error) {
      set({ approvalPhase: 'idle', error: getErrorMessage(error) });
      throw error;
    }
  },

  approvePlan: async () => {
    assertRecoveryGateClear(get());
    const plan = get().plan;
    if (!plan || plan.status !== 'awaiting_approval' || Date.now() >= plan.expiresAt) {
      throw new Error('DEPLOYMENT_AWAITING_APPROVAL_REQUIRED');
    }
    set({ approvalPhase: 'deciding', error: null });
    try {
      const updated = await invokeApproveDeploymentPlan(approvalRequest(plan));
      set({ plan: updated, approvalPhase: 'idle' });
      await get().loadRunHistory(true).catch(() => undefined);
      return updated;
    } catch (error) {
      set({ approvalPhase: 'idle', error: getErrorMessage(error) });
      throw error;
    }
  },

  rejectPlan: async () => {
    const plan = get().plan;
    if (!plan || plan.status !== 'awaiting_approval') {
      throw new Error('DEPLOYMENT_AWAITING_APPROVAL_REQUIRED');
    }
    set({ approvalPhase: 'deciding', error: null });
    try {
      const updated = await invokeRejectDeploymentPlan(approvalRequest(plan));
      set({
        plan: updated,
        approvalPhase: 'idle',
        artifactTransferWorkflowId: null,
        artifactTransferResult: null,
        artifactTransferProgress: null,
      });
      return updated;
    } catch (error) {
      set({ approvalPhase: 'idle', error: getErrorMessage(error) });
      throw error;
    }
  },

  transferArtifact: async () => {
    assertRecoveryGateClear(get());
    const state = get();
    const artifact = state.artifactBuildResult;
    const plan = state.plan;
    const workflow = state.workflows.find((item) => item.id === state.preflightWorkflowId);
    if (
      !workflow
      || !artifactMatchesWorkflow(artifact, workflow)
      || !artifact?.artifactReference
      || !artifact.sourceRevision
      || !artifact.releaseId
      || !artifact.artifactDigestSha256
      || !plan
      || plan.status !== 'approved'
      || Date.now() >= plan.expiresAt
      || plan.approvalSummary.workflowId !== workflow.id
      || plan.approvalSummary.workflowRevision !== workflow.revision
      || plan.approvalSummary.frozen.sourceRevision.revision !== artifact.sourceRevision.revision
      || plan.approvalSummary.frozen.sourceRevision.dirty !== artifact.sourceRevision.dirty
      || plan.approvalSummary.frozen.targetRelease.releaseId !== artifact.releaseId
      || plan.approvalSummary.frozen.targetRelease.artifactDigestSha256
        !== artifact.artifactDigestSha256
    ) {
      throw new Error('DEPLOYMENT_APPROVED_PLAN_REQUIRED');
    }
    const operationId = `deployment-artifact-transfer:${generateId()}`;
    set({
      error: null,
      artifactTransferPhase: 'running',
      artifactTransferOperationId: operationId,
      artifactTransferWorkflowId: workflow.id,
      artifactTransferProgress: null,
      artifactTransferResult: null,
      remoteRunnerPhase: 'idle',
      remoteRunnerOperationId: null,
      remoteRunnerWorkflowId: null,
      remoteRunnerProgress: null,
      remoteRunnerLog: [],
      remoteRunnerResult: null,
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listenToDeploymentArtifactTransferProgress((event) => {
        const progress = event.payload;
        set((current) => (
          current.artifactTransferOperationId === operationId
          && progress.operationId === operationId
          && (current.artifactTransferProgress?.sequence ?? 0) < progress.sequence
            ? { artifactTransferProgress: progress }
            : {}
        ));
      });
      const result = await invokeTransferDeploymentArtifact({
        operationId,
        planId: plan.planId,
        planDigest: plan.planDigest,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        artifactReference: artifact.artifactReference,
        sourceRevision: artifact.sourceRevision,
        target: plan.approvalSummary.frozen.target,
        remoteRoot: plan.approvalSummary.remoteRoot,
        releaseId: artifact.releaseId,
        releaseDigestSha256: artifact.artifactDigestSha256,
        timeoutMs: 2 * 60 * 60 * 1_000,
      });
      set((current) => current.artifactTransferOperationId === operationId ? {
        artifactTransferPhase: 'idle',
        artifactTransferOperationId: null,
        artifactTransferResult: result,
      } : {});
      return result;
    } catch (error) {
      set((current) => current.artifactTransferOperationId === operationId ? {
        artifactTransferPhase: 'idle',
        artifactTransferOperationId: null,
        error: getErrorMessage(error),
      } : {});
      throw error;
    } finally {
      unlisten?.();
    }
  },

  cancelArtifactTransfer: async () => {
    const operationId = get().artifactTransferOperationId;
    if (!operationId || get().artifactTransferPhase !== 'running') return;
    set({ artifactTransferPhase: 'cancelling' });
    try {
      await invokeCancelDeploymentArtifactTransfer(operationId);
    } catch (error) {
      if (get().artifactTransferOperationId === operationId) {
        set({ error: getErrorMessage(error), artifactTransferPhase: 'running' });
      }
      throw error;
    }
  },

  runRemote: async () => {
    const state = get();
    assertRecoveryGateClear(state);
    const recovered = state.recoveredApprovedBinding;
    const workflowId = recovered
      ? state.plan?.approvalSummary.workflowId ?? null
      : state.artifactTransferWorkflowId;
    const workflow = state.workflows.find((item) => item.id === workflowId);
    const artifact = state.artifactBuildResult;
    const transfer = state.artifactTransferResult;
    const plan = state.plan;
    const recoveredReady = Boolean(
      recovered
      && workflow
      && plan
      && plan.planId === recovered.planId
      && plan.status === 'approved'
      && Date.now() < plan.expiresAt
      && plan.approvalSummary.workflowId === workflow.id
      && plan.approvalSummary.workflowRevision === workflow.revision
      && plan.approvalSummary.artifactReference,
    );
    if (!recoveredReady && (
      !workflow
      || !artifact?.artifactReference
      || !artifact.sourceRevision
      || !artifact.releaseId
      || !artifact.artifactDigestSha256
      || !plan
      || plan.status !== 'approved'
      || !transferInputsMatch(transfer, workflow.id, artifact, plan, state.workflows)
      || !transfer?.remoteStagingIdentity
    )) {
      throw new Error('DEPLOYMENT_TRANSFER_REQUIRED');
    }
    if (!workflow || !plan) throw new Error('DEPLOYMENT_TRANSFER_REQUIRED');
    const operationId = `deployment-remote-runner:${generateId()}`;
    set({
      error: null,
      remoteRunnerPhase: 'running',
      remoteRunnerOperationId: operationId,
      remoteRunnerWorkflowId: workflow.id,
      remoteRunnerProgress: null,
      remoteRunnerLog: [],
      remoteRunnerResult: null,
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listenToDeploymentRemoteRunnerProgress((event) => {
        const progress = event.payload;
        set((current) => {
          if (
            current.remoteRunnerOperationId !== operationId
            || progress.operationId !== operationId
            || (current.remoteRunnerProgress?.sequence ?? 0) >= progress.sequence
          ) {
            return {};
          }
          return {
            remoteRunnerProgress: progress,
            remoteRunnerLog: [...current.remoteRunnerLog, progress].slice(-50),
          };
        });
      });
      const result = await invokeRunDeploymentRemote({
        operationId,
        planId: plan.planId,
        planDigest: plan.planDigest,
        runId: plan.runId,
        runRevision: plan.runRevision,
        planExpiresAt: plan.expiresAt,
        workflowId: workflow.id,
        workflowRevision: workflow.revision,
        artifactReference: recovered
          ? plan.approvalSummary.artifactReference!
          : artifact!.artifactReference!,
        artifactTransferOperationId: recovered
          ? recovered.artifactTransferOperationId
          : transfer!.operationId,
        sourceRevision: recovered
          ? plan.approvalSummary.frozen.sourceRevision
          : artifact!.sourceRevision!,
        target: plan.approvalSummary.frozen.target,
        remoteRoot: plan.approvalSummary.remoteRoot,
        releaseId: recovered
          ? plan.approvalSummary.frozen.targetRelease.releaseId
          : artifact!.releaseId!,
        releaseDigestSha256: recovered
          ? plan.approvalSummary.frozen.targetRelease.artifactDigestSha256
          : artifact!.artifactDigestSha256!,
        remoteStagingIdentity: recovered
          ? recovered.remoteStagingIdentity
          : transfer!.remoteStagingIdentity!,
        timeoutMs: 30 * 60 * 1_000,
      });
      let refreshedPlan = plan;
      try {
        refreshedPlan = await invokeGetDeploymentPlan(plan.planId);
      } catch {
        // The result remains visible; a later refresh can reload the durable run.
      }
      set((current) => current.remoteRunnerOperationId === operationId ? {
        remoteRunnerPhase: 'idle',
        remoteRunnerOperationId: null,
        remoteRunnerResult: result,
        plan: refreshedPlan,
        recoveredApprovedBinding: null,
      } : {});
      await get().loadRunHistory(true).catch(() => undefined);
      await get().claimNotifications().catch(() => []);
      return result;
    } catch (error) {
      set((current) => current.remoteRunnerOperationId === operationId ? {
        remoteRunnerPhase: 'idle',
        remoteRunnerOperationId: null,
        error: getErrorMessage(error),
      } : {});
      throw error;
    } finally {
      unlisten?.();
    }
  },

  cancelRemoteRunner: async () => {
    const state = get();
    const operationId = state.remoteRunnerOperationId;
    const plan = state.plan;
    if (!operationId || !plan || state.remoteRunnerPhase !== 'running') return;
    set({ remoteRunnerPhase: 'cancelling' });
    try {
      await invokeCancelDeploymentRemoteRunner({
        operationId,
        planId: plan.planId,
        planDigest: plan.planDigest,
        runId: plan.runId,
      });
    } catch (error) {
      if (get().remoteRunnerOperationId === operationId) {
        set({ error: getErrorMessage(error), remoteRunnerPhase: 'running' });
      }
      throw error;
    }
  },

  reconcileRun: async (runId) => {
    const state = get();
    const candidate = state.recoveryCandidates.find((item) => item.runId === runId);
    if (!candidate || state.reconciliationPhase !== 'idle') {
      throw new Error('DEPLOYMENT_RECONCILIATION_REQUIRED');
    }
    const binding = await invokeDeploymentReconciliationBinding(runId);
    const operationId = binding.reconciliationOperationId
      ?? `deployment-reconciliation:${generateId()}`;
    set({
      error: null,
      reconciliationPhase: 'running',
      reconciliationOperationId: operationId,
      reconciliationRunId: runId,
    });
    try {
      const result = await invokeDeploymentReconcile({
        operationId,
        planId: binding.candidate.planId,
        planDigest: binding.candidate.planDigest,
        runId: binding.candidate.runId,
        expectedRunRevision: binding.candidate.lastEventSequence,
        artifactTransferOperationId: binding.artifactTransferOperationId,
        remoteStagingIdentity: binding.remoteStagingIdentity,
      });
      const recovery = await invokeDeploymentStartupRecovery();
      let recoveredPlan: DeploymentStoredPlanRecord | null = null;
      if (result.status === 'approved' && result.evidence.approvalReusable) {
        try {
          recoveredPlan = await invokeGetDeploymentPlan(result.planId);
        } catch {
          // Inputs can drift immediately after reconciliation. The durable result
          // remains visible, but the old approval is not exposed for execution.
        }
      }
      set((current) => ({
        recoveryCandidates: recovery.candidates,
        reconciliationPhase: 'idle',
        reconciliationOperationId: null,
        reconciliationRunId: null,
        reconciliationResults: {
          ...current.reconciliationResults,
          [runId]: result,
        },
        ...(recoveredPlan ? {
          plan: recoveredPlan,
          preflightWorkflowId: recoveredPlan.approvalSummary.workflowId,
          recoveredApprovedBinding: {
            planId: recoveredPlan.planId,
            artifactTransferOperationId: binding.artifactTransferOperationId,
            remoteStagingIdentity: binding.remoteStagingIdentity,
          },
        } : {}),
      }));
      await get().loadRunHistory(true).catch(() => undefined);
      await get().claimNotifications().catch(() => []);
      return result;
    } catch (error) {
      let recoveryCandidates = get().recoveryCandidates;
      try {
        recoveryCandidates = (await invokeDeploymentStartupRecovery()).candidates;
      } catch {
        // Keep the last durable startup projection if its refresh also fails.
      }
      set({
        recoveryCandidates,
        reconciliationPhase: 'idle',
        reconciliationOperationId: null,
        reconciliationRunId: null,
        error: getErrorMessage(error),
      });
      throw error;
    }
  },

  stopReconciliationObservation: async () => {
    const state = get();
    if (!state.reconciliationOperationId || state.reconciliationPhase !== 'running') return;
    set({ reconciliationPhase: 'stopping' });
    try {
      await invokeCancelDeploymentReconciliationObservation(state.reconciliationOperationId);
    } catch (error) {
      if (get().reconciliationOperationId === state.reconciliationOperationId) {
        set({ error: getErrorMessage(error), reconciliationPhase: 'running' });
      }
      throw error;
    }
  },

  clearError: () => set({ error: null }),
  clearPreflight: () => set({
    preflightPhase: 'idle',
    preflightOperationId: null,
    preflightWorkflowId: null,
    preflightResult: null,
    plan: null,
    approvalPhase: 'idle',
    artifactTransferWorkflowId: null,
    artifactTransferResult: null,
    artifactTransferProgress: null,
    artifactTransferPhase: 'idle',
    artifactTransferOperationId: null,
    remoteRunnerPhase: 'idle',
    remoteRunnerOperationId: null,
    remoteRunnerWorkflowId: null,
    remoteRunnerProgress: null,
    remoteRunnerLog: [],
    remoteRunnerResult: null,
    recoveredApprovedBinding: null,
  }),
}));
