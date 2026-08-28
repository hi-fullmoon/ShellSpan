import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAgentTerminalSnapshotV1,
  parseTerminalCoordinatorErrorV1,
  pauseAgentTerminalV1,
  resolveAgentTerminalApprovalV1,
  returnAgentTerminalControlV1,
  stopAgentTerminalV1,
  takeoverAgentTerminalAndWriteV1,
  type AgentTerminalSnapshotV1,
  type TerminalCoordinatorErrorV1,
  type TerminalPromptClassV1,
  type TerminalPromptSurfaceV1,
  type TerminalResolveApprovalRequestV1,
  type TerminalRunControlRequestV1,
  type TerminalTakeoverAndWriteRequestV1,
} from '@/lib/agent-terminal-control';
import { generateId } from '@/lib/utils';
import { useAgentTerminalStore } from '@/stores/agentTerminalStore';

export interface AgentTerminalTransportV1 {
  getSnapshot: (runId: string) => Promise<AgentTerminalSnapshotV1>;
  resolveApproval: (
    request: TerminalResolveApprovalRequestV1,
  ) => Promise<AgentTerminalSnapshotV1>;
  takeoverAndWrite: (
    request: TerminalTakeoverAndWriteRequestV1,
  ) => Promise<AgentTerminalSnapshotV1>;
  returnControl: (request: TerminalRunControlRequestV1) => Promise<AgentTerminalSnapshotV1>;
  pause: (request: TerminalRunControlRequestV1) => Promise<AgentTerminalSnapshotV1>;
  stop: (request: TerminalRunControlRequestV1) => Promise<AgentTerminalSnapshotV1>;
}

export const defaultAgentTerminalTransportV1: AgentTerminalTransportV1 = {
  getSnapshot: getAgentTerminalSnapshotV1,
  resolveApproval: resolveAgentTerminalApprovalV1,
  takeoverAndWrite: takeoverAgentTerminalAndWriteV1,
  returnControl: returnAgentTerminalControlV1,
  pause: pauseAgentTerminalV1,
  stop: stopAgentTerminalV1,
};

export type AgentTerminalPendingActionV1 =
  | 'approval'
  | 'returnControl'
  | 'pause'
  | 'stop';

const SENSITIVE_PROMPTS: readonly TerminalPromptClassV1[] = [
  'password', 'passphrase', 'mfa', 'otp', 'token', 'credential', 'unknownSensitive',
];
const UNSUPPORTED_SURFACES: readonly TerminalPromptSurfaceV1[] = [
  'fullScreen', 'editor', 'installer', 'unknown',
];

export function requiresUserHandoffV1(snapshot: AgentTerminalSnapshotV1): boolean {
  const observation = snapshot.currentObservation;
  return snapshot.controlState === 'handoffRequired'
    || Boolean(observation && (
      SENSITIVE_PROMPTS.includes(observation.promptClass)
      || UNSUPPORTED_SURFACES.includes(observation.surface)
    ));
}

export function canDisplayPendingApprovalV1(
  snapshot: AgentTerminalSnapshotV1,
  nowMs: number,
): boolean {
  const approval = snapshot.pendingApproval;
  const observation = snapshot.currentObservation;
  if (
    !approval
    || approval.state !== 'pending'
    || nowMs >= approval.expiresAtMs
    || snapshot.controlState !== 'agent'
    || snapshot.leaseOwner !== 'agent'
    || snapshot.leaseState !== 'active'
    || approval.runId !== snapshot.runId
    || approval.targetDigest !== snapshot.targetDigest
    || approval.sessionId !== snapshot.sessionId
    || approval.leaseEpoch !== snapshot.leaseEpoch
    || approval.leaseRevision !== snapshot.leaseRevision
    || !observation
    || approval.observationId !== observation.observationId
    || approval.observationDigest !== observation.transcriptDigest
    || observation.surface !== 'linePrompt'
    || SENSITIVE_PROMPTS.includes(observation.promptClass)
    || observation.promptClass === 'unknown'
  ) {
    return false;
  }
  const action = snapshot.actions.find((candidate) => candidate.actionId === approval.actionId);
  return Boolean(
    action
    && action.state === 'awaitingApproval'
    && action.approvalId === approval.approvalId
    && action.actionDigest === approval.actionDigest,
  );
}

export function canReturnAgentTerminalControlV1(snapshot: AgentTerminalSnapshotV1): boolean {
  return snapshot.controlState === 'user'
    && snapshot.leaseOwner === 'user'
    && snapshot.leaseState === 'active';
}

function isInputAllowed(snapshot: AgentTerminalSnapshotV1): boolean {
  return !['stopped', 'disconnected', 'paused'].includes(snapshot.controlState);
}

async function invokeWithOneIdempotentRetry<T>(
  invokeAction: () => Promise<T>,
): Promise<T> {
  try {
    return await invokeAction();
  } catch (reason) {
    if (parseTerminalCoordinatorErrorV1(reason).code !== 'unknown') throw reason;
    return invokeAction();
  }
}

export function useAgentTerminalV1({
  runId,
  transport: providedTransport,
  onControlError,
}: {
  runId?: string;
  transport?: AgentTerminalTransportV1;
  onControlError?: (error: TerminalCoordinatorErrorV1) => void;
}): {
  snapshot?: AgentTerminalSnapshotV1;
  status: ReturnType<typeof useAgentTerminalStore.getState>['statusByRunId'][string] | 'idle';
  projectionError?: TerminalCoordinatorErrorV1;
  refreshHint?: string;
  pendingAction?: AgentTerminalPendingActionV1;
  inputPending: boolean;
  resync: (hint?: string) => Promise<void>;
  sendUserInput: (data: string) => void;
  resolveApproval: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  returnControl: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const transport = providedTransport ?? defaultAgentTerminalTransportV1;
  const snapshot = useAgentTerminalStore((state) => (
    runId ? state.snapshotsByRunId[runId] : undefined
  ));
  const status = useAgentTerminalStore((state) => (
    runId ? state.statusByRunId[runId] ?? 'idle' : 'idle'
  ));
  const projectionError = useAgentTerminalStore((state) => (
    runId ? state.errorByRunId[runId] : undefined
  ));
  const refreshHint = useAgentTerminalStore((state) => (
    runId ? state.refreshHintByRunId[runId] : undefined
  ));
  const [pendingAction, setPendingAction] = useState<AgentTerminalPendingActionV1>();
  const [inputPending, setInputPending] = useState(false);
  const mountedRef = useRef(false);
  const snapshotRequestGenerationRef = useRef(0);
  const takeoverPendingRef = useRef(false);
  const inputPendingCountRef = useRef(0);

  const reportControlError = useCallback((reason: unknown): void => {
    const error = parseTerminalCoordinatorErrorV1(reason);
    onControlError?.(error);
  }, [onControlError]);

  const installCommandSnapshot = useCallback((nextSnapshot: AgentTerminalSnapshotV1): void => {
    const result = useAgentTerminalStore.getState().installSnapshot(nextSnapshot);
    if (result === 'invalid' || result === 'bindingMismatch') {
      const error: TerminalCoordinatorErrorV1 = {
        code: 'invalidContract',
        message: 'Agent terminal snapshot failed frontend validation.',
      };
      if (runId) useAgentTerminalStore.getState().markFailed(runId, error);
      onControlError?.(error);
    }
  }, [onControlError, runId]);

  const resync = useCallback(async (hint?: string): Promise<void> => {
    if (!runId) return;
    const generation = snapshotRequestGenerationRef.current + 1;
    snapshotRequestGenerationRef.current = generation;
    if (hint) useAgentTerminalStore.getState().noteRefreshHint(runId, hint);
    useAgentTerminalStore.getState().markLoading(runId);
    try {
      const nextSnapshot = await transport.getSnapshot(runId);
      if (!mountedRef.current || generation !== snapshotRequestGenerationRef.current) return;
      const result = useAgentTerminalStore.getState().installSnapshot(nextSnapshot);
      if (result === 'invalid' || result === 'bindingMismatch') {
        useAgentTerminalStore.getState().markFailed(runId, {
          code: 'invalidContract',
          message: 'Agent terminal snapshot failed frontend validation.',
        });
      }
    } catch (reason) {
      if (!mountedRef.current || generation !== snapshotRequestGenerationRef.current) return;
      const error = parseTerminalCoordinatorErrorV1(reason);
      if (error.code === 'runNotFound' || error.code === 'admissionBlocked') {
        useAgentTerminalStore.getState().markUnavailable(runId, error);
      } else {
        useAgentTerminalStore.getState().markFailed(runId, error);
      }
    }
  }, [runId, transport]);

  useEffect(() => {
    mountedRef.current = true;
    if (runId) void resync('mount');
    return () => {
      mountedRef.current = false;
      snapshotRequestGenerationRef.current += 1;
      takeoverPendingRef.current = false;
      inputPendingCountRef.current = 0;
    };
  }, [resync, runId]);

  const runControl = useCallback(async (
    action: AgentTerminalPendingActionV1,
    invokeAction: (request: TerminalRunControlRequestV1) => Promise<AgentTerminalSnapshotV1>,
  ): Promise<void> => {
    if (!runId || pendingAction) return;
    const request: TerminalRunControlRequestV1 = {
      schemaVersion: 1,
      runId,
      clientActionId: generateId(),
    };
    setPendingAction(action);
    try {
      const nextSnapshot = await invokeWithOneIdempotentRetry(() => invokeAction(request));
      if (mountedRef.current) installCommandSnapshot(nextSnapshot);
    } catch (reason) {
      reportControlError(reason);
      await resync(`${action}Failed`);
    } finally {
      if (mountedRef.current) setPendingAction(undefined);
    }
  }, [installCommandSnapshot, pendingAction, reportControlError, resync, runId]);

  const resolveApproval = useCallback(async (
    approvalId: string,
    decision: 'approve' | 'reject',
  ): Promise<void> => {
    if (!runId || pendingAction) return;
    const request: TerminalResolveApprovalRequestV1 = {
      schemaVersion: 1,
      runId,
      approvalId,
      decision,
      clientActionId: generateId(),
    };
    setPendingAction('approval');
    try {
      const nextSnapshot = await invokeWithOneIdempotentRetry(
        () => transport.resolveApproval(request),
      );
      if (mountedRef.current) installCommandSnapshot(nextSnapshot);
    } catch (reason) {
      reportControlError(reason);
      await resync('approvalFailed');
    } finally {
      if (mountedRef.current) setPendingAction(undefined);
    }
  }, [installCommandSnapshot, pendingAction, reportControlError, resync, runId, transport]);

  const sendUserInput = useCallback((data: string): void => {
    if (!runId) return;
    if (data.length === 0 || data.length > 16 * 1024 || data.includes('\0')) {
      onControlError?.({
        code: 'invalidContract',
        message: 'Agent terminal user input is empty, oversized, or contains NUL.',
      });
      void resync('inputRejected');
      return;
    }
    const current = useAgentTerminalStore.getState().snapshotsByRunId[runId];
    if (!current || !isInputAllowed(current)) return;
    const needsTakeover = current.leaseOwner !== 'user';
    if (needsTakeover && takeoverPendingRef.current) return;
    if (needsTakeover) takeoverPendingRef.current = true;
    inputPendingCountRef.current += 1;
    setInputPending(true);
    const request: TerminalTakeoverAndWriteRequestV1 = {
      schemaVersion: 1,
      runId,
      clientActionId: generateId(),
      data,
    };
    void invokeWithOneIdempotentRetry(() => transport.takeoverAndWrite(request))
      .then((nextSnapshot) => {
        if (mountedRef.current) installCommandSnapshot(nextSnapshot);
      })
      .catch(async (reason: unknown) => {
        reportControlError(reason);
        await resync('inputFailed');
      })
      .finally(() => {
        takeoverPendingRef.current = false;
        inputPendingCountRef.current = Math.max(0, inputPendingCountRef.current - 1);
        if (mountedRef.current) setInputPending(inputPendingCountRef.current > 0);
      });
  }, [installCommandSnapshot, onControlError, reportControlError, resync, runId, transport]);

  return {
    snapshot,
    status,
    projectionError,
    refreshHint,
    pendingAction,
    inputPending,
    resync,
    sendUserInput,
    resolveApproval,
    returnControl: () => runControl('returnControl', transport.returnControl),
    pause: () => runControl('pause', transport.pause),
    stop: () => runControl('stop', transport.stop),
  };
}
