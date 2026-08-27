import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlertIcon, LockKeyholeIcon, ScanSearchIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { parseAgentCommandErrorV1 } from '@/lib/agent-protocol';
import { isAgentRunTerminalStateV1 } from '@/lib/agent-state';
import {
  invokeAgentGetSnapshot,
  invokeAgentPause,
  invokeAgentResume,
  invokeAgentSendMessage,
  invokeAgentStart,
  invokeAgentStop,
  isTauriRuntime,
  listenToAgentEvents,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentAcceptedMessageV1 } from '@/stores/agentStore';
import type {
  AgentActionRequestV1,
  AgentActionResultV1,
  AgentGetSnapshotRequestV1,
  AgentRunSnapshotV1,
  AgentSendMessageRequestV1,
  AgentStartRequestV1,
  AgentStartResultV1,
  AgentTerminalContextV1,
} from '@/types/agent';
import { agentEvidenceElementId } from './agent-evidence';
import { AgentComposer } from './agent-composer';
import { AgentRunHeader, type AgentPendingAction } from './agent-run-header';
import { AgentTimeline } from './agent-timeline';

export interface AgentWorkspaceTransport {
  listen: (onEvent: (value: unknown) => void) => Promise<() => void>;
  getSnapshot: (request: AgentGetSnapshotRequestV1) => Promise<AgentRunSnapshotV1>;
  start: (request: AgentStartRequestV1) => Promise<AgentStartResultV1>;
  pause: (request: AgentActionRequestV1) => Promise<AgentActionResultV1>;
  resume: (request: AgentActionRequestV1) => Promise<AgentActionResultV1>;
  stop: (request: AgentActionRequestV1) => Promise<AgentActionResultV1>;
  sendMessage: (request: AgentSendMessageRequestV1) => Promise<AgentActionResultV1>;
}

const defaultTransport: AgentWorkspaceTransport = {
  listen: listenToAgentEvents,
  getSnapshot: invokeAgentGetSnapshot,
  start: invokeAgentStart,
  pause: invokeAgentPause,
  resume: invokeAgentResume,
  stop: invokeAgentStop,
  sendMessage: invokeAgentSendMessage,
};

const EMPTY_ACCEPTED_MESSAGES: AgentAcceptedMessageV1[] = [];

export function AgentWorkspace({
  profileId,
  providerId,
  providerCompatible,
  currentProfileId,
  terminalContext,
  draft,
  onDraftChange,
  staticFallback,
  staticFallbackActive = false,
  staticFallbackBusy = false,
  canUseStaticFallback = false,
  onStaticFallback,
  onClearStaticFallback,
  modeControl,
  footerAction,
  contextHint,
  transport: providedTransport,
}: {
  profileId?: string;
  providerId?: string;
  providerCompatible: boolean;
  currentProfileId?: string;
  terminalContext?: AgentTerminalContextV1;
  draft: string;
  onDraftChange: (value: string) => void;
  staticFallback?: React.ReactNode;
  staticFallbackActive?: boolean;
  staticFallbackBusy?: boolean;
  canUseStaticFallback?: boolean;
  onStaticFallback: (goal: string) => void;
  onClearStaticFallback: () => void;
  modeControl?: React.ReactNode;
  footerAction?: React.ReactNode;
  contextHint?: string;
  transport?: AgentWorkspaceTransport;
}): React.JSX.Element {
  const { t } = useI18n();
  const transport = providedTransport ?? defaultTransport;
  const enabled = Boolean(providedTransport) || isTauriRuntime();
  const projectionFailureMessage = t('ai.dynamicAgent.projectionFailed');
  const snapshot = useAgentStore((state) => state.activeRunId
    ? state.runsById[state.activeRunId]
    : undefined);
  const snapshotReceivedAt = useAgentStore((state) => state.activeRunId
    ? state.snapshotReceivedAtByRunId[state.activeRunId]
    : undefined);
  const acceptedMessages = useAgentStore((state) => state.activeRunId
    ? state.acceptedMessagesByRunId[state.activeRunId] ?? EMPTY_ACCEPTED_MESSAGES
    : EMPTY_ACCEPTED_MESSAGES);
  const resyncing = useAgentStore((state) => Boolean(
    state.activeRunId && state.resyncingRunIds[state.activeRunId],
  ));
  const lastEventType = useAgentStore((state) => state.activeRunId
    ? state.lastEventTypeByRunId[state.activeRunId]
    : undefined);
  const projectionError = useAgentStore((state) => state.activeRunId
    ? state.projectionErrorByRunId[state.activeRunId]
    : undefined);
  const startPending = useAgentStore((state) => state.startPending);
  const startError = useAgentStore((state) => state.startError);
  const attemptedGoal = useAgentStore((state) => state.attemptedGoal);
  const [mounting, setMounting] = useState(enabled);
  const [transportError, setTransportError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<AgentPendingAction>();
  const pendingSnapshotsRef = useRef(new Map<string, Promise<void>>());
  const mountedRef = useRef(true);

  const resync = useCallback((runId?: string): Promise<void> => {
    const key = runId ?? 'active';
    const pending = pendingSnapshotsRef.current.get(key);
    if (pending) return pending;
    if (runId) useAgentStore.getState().markResyncing(runId, true);
    const task = transport.getSnapshot({ schemaVersion: 1, ...(runId ? { runId } : {}) })
      .then((nextSnapshot) => {
        if (!mountedRef.current) return;
        const installed = useAgentStore.getState().installSnapshot(nextSnapshot);
        if (!installed) setTransportError(projectionFailureMessage);
        else setTransportError(undefined);
      })
      .catch((reason) => {
        if (!mountedRef.current) return;
        const error = parseAgentCommandErrorV1(reason);
        if (error.category !== 'runNotFound') setTransportError(error.message);
        if (runId) useAgentStore.getState().markResyncing(runId, false);
      })
      .finally(() => {
        pendingSnapshotsRef.current.delete(key);
      });
    pendingSnapshotsRef.current.set(key, task);
    return task;
  }, [projectionFailureMessage, transport]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setMounting(false);
      return () => {
        mountedRef.current = false;
      };
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    setMounting(true);
    void transport.listen((value) => {
      const result = useAgentStore.getState().acceptEvent(value);
      if (result.resyncRequired && result.runId) void resync(result.runId);
    }).then(async (stop) => {
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const knownRunId = useAgentStore.getState().activeRunId;
      await resync(knownRunId);
    }).catch((reason) => {
      if (!disposed) setTransportError(parseAgentCommandErrorV1(reason).message);
    }).finally(() => {
      if (!disposed) setMounting(false);
    });
    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, [enabled, resync, transport]);

  const runAction = useCallback(async (
    action: Exclude<AgentPendingAction, 'sendMessage' | undefined>,
    invokeAction: (request: AgentActionRequestV1) => Promise<AgentActionResultV1>,
  ): Promise<void> => {
    const runId = useAgentStore.getState().activeRunId;
    if (!runId || pendingAction) return;
    setPendingAction(action);
    setTransportError(undefined);
    try {
      await invokeAction({ schemaVersion: 1, runId, clientActionId: generateId() });
      await resync(runId);
    } catch (reason) {
      const error = parseAgentCommandErrorV1(reason);
      setTransportError(error.message);
      toast.error(error.message);
    } finally {
      if (mountedRef.current) setPendingAction(undefined);
    }
  }, [pendingAction, resync]);

  const start = useCallback(async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal || !profileId || !providerId || !providerCompatible || startPending) return;
    onClearStaticFallback();
    useAgentStore.getState().setStartPending(true, goal);
    setTransportError(undefined);
    try {
      const result = await transport.start({
        schemaVersion: 1,
        clientRequestId: generateId(),
        goal,
        profileId,
        providerId,
        ...(terminalContext ? { terminalContext } : {}),
      });
      onDraftChange('');
      await resync(result.runId);
    } catch (reason) {
      const error = parseAgentCommandErrorV1(reason);
      useAgentStore.getState().setStartError(error, goal);
      if (error.category !== 'p1Blocked') toast.error(error.message);
    }
  }, [
    draft,
    onClearStaticFallback,
    onDraftChange,
    profileId,
    providerCompatible,
    providerId,
    resync,
    startPending,
    terminalContext,
    transport,
  ]);

  const sendMessage = useCallback(async (): Promise<void> => {
    const message = draft.trim();
    const current = useAgentStore.getState();
    const runId = current.activeRunId;
    const run = runId ? current.runsById[runId] : undefined;
    if (!message || !run || isAgentRunTerminalStateV1(run.state) || pendingAction) return;
    const clientActionId = generateId();
    const kind = run.state === 'awaitingUser' ? 'answer' : 'steering';
    setPendingAction('sendMessage');
    setTransportError(undefined);
    try {
      const result = await transport.sendMessage({
        schemaVersion: 1,
        runId: run.runId,
        clientActionId,
        message,
      });
      useAgentStore.getState().recordAcceptedMessage(run.runId, {
        id: clientActionId,
        text: message,
        acceptedAt: result.acceptedAt,
        kind,
      });
      onDraftChange('');
      toast.success(t(kind === 'answer'
        ? 'ai.dynamicAgent.message.answer'
        : 'ai.dynamicAgent.message.steering'));
      await resync(run.runId);
    } catch (reason) {
      const error = parseAgentCommandErrorV1(reason);
      setTransportError(error.message);
      toast.error(error.message);
    } finally {
      if (mountedRef.current) setPendingAction(undefined);
    }
  }, [draft, onDraftChange, pendingAction, resync, t, transport]);

  const navigateToEvidence = useCallback((evidenceId: string): void => {
    if (!snapshot) return;
    const target = document.getElementById(agentEvidenceElementId(snapshot.runId, evidenceId));
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView?.({ block: 'center' });
    target.focus({ preventScroll: true });
  }, [snapshot]);

  const newDiagnosis = useCallback((): void => {
    useAgentStore.getState().dismissActiveRun();
    onClearStaticFallback();
    onDraftChange('');
    setTransportError(undefined);
  }, [onClearStaticFallback, onDraftChange]);

  const fallbackGoal = attemptedGoal ?? snapshot?.goal ?? draft.trim();
  const showBlocked = startError?.category === 'p1Blocked';
  const providerBlocked = !providerCompatible
    || snapshot?.error?.category === 'providerIncompatible';
  const fallbackEnabled = canUseStaticFallback && Boolean(fallbackGoal) && !staticFallbackBusy;
  const liveAnnouncement = useMemo(() => snapshot
    ? t(`ai.dynamicAgent.state.${snapshot.state}` as Parameters<typeof t>[0])
    : '', [snapshot, t]);

  if (staticFallbackActive && staticFallback) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Alert className="mx-3 mt-3 w-auto">
          <LockKeyholeIcon />
          <AlertTitle>{t('ai.dynamicAgent.staticFallbackTitle')}</AlertTitle>
          <AlertDescription>{t('ai.dynamicAgent.staticFallbackDescription')}</AlertDescription>
        </Alert>
        {staticFallback}
        <AgentComposer
          value={draft}
          onChange={onDraftChange}
          onSubmit={() => void start()}
          onNewDiagnosis={newDiagnosis}
          disabled={staticFallbackBusy || !profileId || !providerId || !providerCompatible}
          pending={startPending}
          modeControl={modeControl}
          footerAction={footerAction}
          contextHint={contextHint}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {snapshot ? (
        <>
          <AgentRunHeader
            snapshot={snapshot}
            snapshotReceivedAt={snapshotReceivedAt}
            currentProfileId={currentProfileId}
            resyncing={resyncing}
            pendingAction={pendingAction}
            onPause={() => void runAction('pause', transport.pause)}
            onResume={() => void runAction('resume', transport.resume)}
            onStop={() => void runAction('stop', transport.stop)}
          />
          {transportError && (
            <Alert variant="destructive" className="mx-3 mt-3 w-auto">
              <CircleAlertIcon />
              <AlertTitle>{t('ai.dynamicAgent.projectionFailed')}</AlertTitle>
              <AlertDescription>{transportError}</AlertDescription>
            </Alert>
          )}
          <AgentTimeline
            snapshot={snapshot}
            acceptedMessages={acceptedMessages}
            currentProfileId={currentProfileId}
            projectionError={projectionError}
            lastEventType={lastEventType}
            onEvidenceNavigate={navigateToEvidence}
          />
          {providerBlocked && (
            <Alert variant="destructive" className="mx-3 mb-2 w-auto">
              <CircleAlertIcon />
              <AlertTitle>{t('ai.dynamicAgent.providerIncompatibleTitle')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <p>{t('ai.dynamicAgent.providerIncompatibleDescription')}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onStaticFallback(fallbackGoal)}
                  disabled={!fallbackEnabled}
                >
                  {t('ai.dynamicAgent.staticFallback')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : mounting ? (
        <PanelLoadingState label={t('ai.dynamicAgent.snapshotLoading')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <EmptyState
            className="min-h-full justify-start px-4 py-5"
            icon={<ScanSearchIcon />}
            title={t('ai.dynamicAgent.emptyTitle')}
            description={t('ai.dynamicAgent.emptyDescription')}
            action={(
              <div className="flex w-full max-w-md flex-col gap-2 text-left">
                {!profileId && (
                  <Alert variant="destructive">
                    <CircleAlertIcon />
                    <AlertTitle>{t('ai.dynamicAgent.targetUnavailable')}</AlertTitle>
                  </Alert>
                )}
                <Alert variant={providerBlocked || showBlocked ? 'destructive' : 'default'}>
                  <LockKeyholeIcon />
                  <AlertTitle>
                    {providerBlocked
                      ? t('ai.dynamicAgent.providerIncompatibleTitle')
                      : t('ai.dynamicAgent.blockedTitle')}
                  </AlertTitle>
                  <AlertDescription className="flex flex-col gap-2">
                    <p>
                      {providerBlocked
                        ? t('ai.dynamicAgent.providerIncompatibleDescription')
                        : startError?.message ?? t('ai.dynamicAgent.blockedDescription')}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onStaticFallback(fallbackGoal)}
                      disabled={!fallbackEnabled}
                    >
                      {t('ai.dynamicAgent.staticFallback')}
                    </Button>
                  </AlertDescription>
                </Alert>
                {transportError && (
                  <Alert variant="destructive">
                    <CircleAlertIcon />
                    <AlertTitle>{t('ai.dynamicAgent.projectionFailed')}</AlertTitle>
                    <AlertDescription>{transportError}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          />
        </div>
      )}

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </span>

      <AgentComposer
        snapshot={snapshot}
        value={draft}
        onChange={onDraftChange}
        onSubmit={() => snapshot ? void sendMessage() : void start()}
        onNewDiagnosis={newDiagnosis}
        disabled={
          mounting
          || !profileId
          || !providerId
          || (!snapshot && !providerCompatible)
          || staticFallbackBusy
        }
        pending={startPending || pendingAction === 'sendMessage'}
        modeControl={modeControl}
        footerAction={footerAction}
        contextHint={contextHint}
      />
    </div>
  );
}
