import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ShieldCheckIcon, ShieldOffIcon } from 'lucide-react';
import type { AppSection } from '@/types';
import { Button } from '@/components/ui/button';
import { AiControlTooltip } from '../ai-control-tooltip';
import { useTerminalTaskNavigation } from '@/components/terminal/agent-terminal-task-navigation';
import { latestTerminalBusyAttempt } from '@/lib/ai/terminal-busy-feedback';
import { terminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';
import { useResolvedModel } from '@/lib/ai/provider-contract';
import { useFocusStore } from '@/stores/focusStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { FocusNoTarget } from '@/components/focus/focus-no-target';
import { FocusControls } from '@/components/focus/focus-controls';
import { useAppStore } from '@/stores/appStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { ensureManagedSandboxTerminal } from '@/lib/terminal/sandbox-terminal';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { SandboxStatusBadge } from './sandbox-status-badge';
import { SandboxSyncDialog } from './sandbox-sync-dialog';
import { FileCheckpointRollbackDialog, type FileCheckpointOpenRequest } from './file-checkpoint-rollback-dialog';
import { AgentTerminalBusyNotice } from '../agent-terminal-busy-notice';
import { AiComposerModelSelector } from './ai-composer-model-selector';
import { AiWorkspaceRoot } from './ai-workspace-root';
import { AiImageDraftControls } from './ai-image-attachments';
import {
  useAiSessionController,
  type AiSessionControllerAdapter,
} from './use-ai-session-controller';

export interface AiWorkspaceControllerProps {
  readonly focusMode?: boolean;
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly adapter?: AiSessionControllerAdapter;
  readonly onClose?: () => void;
}

export function AiWorkspaceController({
  scope,
  focusMode = false,
  adapter,
  onClose,
}: AiWorkspaceControllerProps): React.ReactNode {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const controller = useAiSessionController({ scope, adapter, focusMode });
  const sandboxEnabled = useAiSettingsStore((state) => state.agentSandboxEnabled);
  const displayedSessionId = controller.view?.summary.id ?? null;
  useLayoutEffect(() => {
    if (scope !== 'terminal') return;
    const workspace = focusMode ? 'focus' : 'terminal';
    const { setDisplayedSession } = useTerminalTaskNavigation.getState();
    setDisplayedSession(workspace, displayedSessionId);
    return () => setDisplayedSession(workspace, null);
  }, [scope, focusMode, displayedSessionId]);
  const modelResolution = useResolvedModel(controller.selectedProvider);
  const sessionModel = controller.view?.snapshot.value.header.modelSelection;
  // Display the current route capacity even when its revision has changed and
  // the session must explicitly reselect the model before another request.
  const routeModel = useLlmRoutesStore(state => sessionModel
    ? state.modelsByRoute[sessionModel.routeId]?.find(model => model.modelId === sessionModel.modelId)
    : undefined);
  const activeModel = routeModel ?? (modelResolution.status === 'ready' ? modelResolution.model : undefined);
  const reconnectSession = useReconnectSession();
  const focusTargetId = useFocusStore(state => state.targetSessionId);
  const terminalOpen = useFocusStore(state => state.terminalOpen);
  const activeTerminalId = useTerminalStore((state) => focusMode ? focusTargetId : state.activeSessionId);
  const activeTerminal = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  ));
  const activeTerminalTargetIds = useMemo(() => {
    if (scope !== 'terminal' || focusMode) return undefined;
    if (!activeTerminal) return [];
    const ids = new Set<string>([`terminal-${activeTerminal.sessionId}`]);
    if (activeTerminal.replacesSessionId) ids.add(`terminal-${activeTerminal.replacesSessionId}`);
    for (const previous of activeTerminal.replacedSessionIds ?? []) {
      ids.add(`terminal-${previous}`);
    }
    return [...ids];
  }, [activeTerminal, focusMode, scope]);
  const activeTerminalStatus = activeTerminal?.status;
  const nativeStartupTimedOut = activeTerminal?.integrationReason === 'nativeStartupTimedOut';
  const terminalReconnecting = activeTerminal?.reconnecting ?? false;
  const activeTerminalNativeRecoveryRequired = activeTerminal?.nativeRecoveryRequired ?? false;
  const terminalRecovery = !controller.readOnlySession && terminalExecutionRecovery(controller.view);
  const terminalGeneration = activeTerminal?.terminalGeneration;
  const terminalSessionId = activeTerminal?.terminalSessionId;
  const activeSandboxAgentId = activeTerminal?.ptyInfo?.sandboxBinding?.agentSessionId;
  const session = controller.view?.snapshot.value;
  const boundSandbox = useTerminalStore((state) => {
    const id = session?.header.sessionId;
    if (!id) return null;
    const match = state.sessions.find(
      (candidate) => candidate.ptyInfo?.sandboxBinding?.agentSessionId === id
        && candidate.status !== 'disconnected'
        && candidate.status !== 'error',
    );
    return match?.ptyInfo?.sandboxBinding ?? null;
  });
  const blockedAttempt = latestTerminalBusyAttempt(controller.view?.nodes ?? [], activeTerminalId);
  const configuringContinuation = controller.historicalContinuationAvailable;
  const existingSessionLocked = !configuringContinuation
    && Boolean(session?.archived || session?.header.subagent);
  const modelSettingsLocked = controller.settingsBusy || !controller.canStartAgent
    || controller.historicalContinuationBusy
    || (controller.readOnlySession && !configuringContinuation)
    || existingSessionLocked;
  const runtimeSettingsLocked = modelSettingsLocked;
  const uncertainNativeEffects = Boolean(controller.view?.snapshot.value.uncertainNativeEffects);
  const executionSurfaceLocked = modelSettingsLocked
    || (!configuringContinuation && (
      controller.composer.phase === 'submitting'
      || controller.composer.phase === 'stopping'
      || (controller.view
        ? controller.view.status === 'running'
          || controller.view.status === 'waiting'
          || uncertainNativeEffects
          || Boolean(controller.view.pendingApproval || controller.view.pendingQuestion || controller.view.pendingSkillProposal)
        : Boolean(controller.composer.sessionId))
    ));
  const realTerminalState = controller.realTerminalState;
  const terminalNeedsRecovery = activeTerminalStatus === 'connected' && activeTerminalNativeRecoveryRequired;
  const noticeState = terminalNeedsRecovery && !controller.glibcMismatch && !controller.windowsPowerShell7Fallback
    ? 'recoveryRequired'
    : realTerminalState !== 'ready'
      ? realTerminalState
      : null;
  const reconnectActionDisabled = terminalReconnecting
    || controller.composer.phase === 'stopping'
    || Boolean(terminalRecovery && terminalRecovery.needsStop)
    || controller.view?.status === 'running'
    || controller.view?.status === 'waiting';
  const handleReconnectTerminal = activeTerminalId
    ? () => {
      // Stopping must settle first; reconnect must never bypass an active recovery gate.
      if (reconnectActionDisabled) return;
      void reconnectSession(activeTerminalId);
    }
    : undefined;
  const imageDraftVisible = Boolean(
    controller.imageDraft.draft?.images.length || controller.imageDraft.pendingFiles.length,
  );
  const openAiSettings = (): void => useAppStore.getState().openSettings('ai');
  const activeSessionId = session?.header.sessionId ?? null;
  const [checkpointCount, setCheckpointCount] = useState(0);
  const [rollbackRequest, setRollbackRequest] = useState<FileCheckpointOpenRequest | null>(null);
  useEffect(() => {
    setCheckpointCount(0);
    setRollbackRequest(null);
  }, [activeSessionId]);
  const handleOpenRollback = useCallback((focusPaths: readonly string[]) => {
    setRollbackRequest((current) => ({ nonce: (current?.nonce ?? 0) + 1, focusPaths }));
  }, []);
  const canRollbackCheckpoints = Boolean(
    session?.header.target
    && !session.header.target.localSandboxRequired
    && !controller.readOnlySession
    && checkpointCount > 0,
  );
  const sandboxSyncAction = session?.header.target?.localSandboxRequired
    ? (
        <SandboxSyncDialog
          key={session.header.sessionId}
          sessionId={session.header.sessionId}
          refreshEnabled={controller.view?.status === 'idle'}
          refreshSignal={controller.view?.nodes.length ?? 0}
        />
      )
    : session?.header.target
      ? (
          <FileCheckpointRollbackDialog
            key={session.header.sessionId}
            sessionId={session.header.sessionId}
            refreshEnabled={controller.view?.status === 'idle'}
            refreshSignal={controller.view?.nodes.length ?? 0}
            openRequest={rollbackRequest}
            onCheckpointsCountChange={setCheckpointCount}
          />
        )
      : undefined;
  const headerActions = focusMode && !terminalOpen ? <FocusControls /> : undefined;
  const canOpenSandboxTerminal = scope === 'terminal'
    && !focusMode
    && controller.sandboxVisiblePty
    && session?.header.target?.localSandboxRequired === 'macNono'
    && !controller.readOnlySession
    && activeSandboxAgentId !== session.header.sessionId;
  const openSandboxTerminalDisabled = controller.selectedExecutionSurface === 'direct'
    ? executionSurfaceLocked
    : false;
  const handleOpenSandboxTerminal = canOpenSandboxTerminal && session
    ? () => {
      if (controller.selectedExecutionSurface === 'direct') {
        controller.selectExecutionSurface('boundTerminal');
        return;
      }
      void ensureManagedSandboxTerminal(session.header.sessionId, {
        insertAfterId: activeTerminalId ?? undefined,
        formatTitle: (shell) => t('terminal.sandbox.tabTitle', { shell }),
      }).catch(() => showError(t('terminal.sandbox.restartFailed')));
    }
    : undefined;
  return (
    <AiWorkspaceRoot
      headerSessionActions={sandboxSyncAction}
      headerActions={headerActions}
      headerBadge={session?.header.target ? (
        <SandboxStatusBadge
          sessionId={session.header.sessionId}
          target={session.header.target}
          boundSandbox={boundSandbox}
          onOpenSandboxTerminal={handleOpenSandboxTerminal}
          openSandboxTerminalDisabled={openSandboxTerminalDisabled}
        />
      ) : undefined}
      mode={scope === 'workbench' ? 'ask' : 'agent'}
      view={controller.view}
      contextWindow={activeModel?.contextWindow}
      maxOutputTokens={activeModel?.maxOutputTokens}
      requestOutputTokens={activeModel?.requestOutputTokens}
      restoringSession={controller.restoringSession}
      imageControls={imageDraftVisible
        ? <AiImageDraftControls state={controller.imageDraft} selection={controller.selectedProvider} />
        : null}
      onPasteImages={controller.canStartAgent ? controller.imageDraft.add : undefined}
      hasImages={Boolean(controller.imageDraft.draft?.images.length)}
      imageBusy={controller.imageDraft.busy}
      imageSubmissionId={controller.imageDraft.submittedOperationId}
      imageLocked={controller.imageDraft.locked}
      submissionContext={controller.submissionContext}
      onAnswerQuestion={controller.answerQuestion}
      onRefreshQuestionAnswer={controller.refreshQuestionAnswer}
      onResolveSkillProposal={controller.resolveSkillProposal}
      onInspectSkillTarget={controller.inspectSkillTarget}
      onListFileReferences={controller.listFileReferences}
      onListProjectDirectories={controller.listProjectDirectories}
      onListSkills={controller.listSkills}
      skillsScopeKey={controller.skillsScopeKey}
      skillsNeedsRoot={controller.skillsNeedsRoot}
      projectTargetLabel={controller.projectTargetLabel}
      pendingNodes={controller.pendingNodes}
      scope={scope}
      composerState={controller.composer}
      announcement={controller.announcement}
      navigation={controller.navigation}
      sessions={controller.sessions}
      activeTerminalTargetIds={activeTerminalTargetIds}
      sandboxAgentSessionId={activeSandboxAgentId}
      sessionsLoading={controller.sessionsLoading}
      sessionsError={controller.sessionsError}
      archivingSessionId={controller.archivingSessionId}
      deletingSessionId={controller.deletingSessionId}
      approvalDecision={controller.approvalDecision}
      approvalError={controller.approvalError}
      approvalArguments={controller.approvalArguments}
      approvalArgumentsLoading={controller.approvalArgumentsLoading}
      approvalArgumentsError={controller.approvalArgumentsError}
      loadingOlder={controller.loadingOlder}
      queueMutation={controller.queueMutation}
      onRetryQueueMutation={controller.retryQueueMutation}
      renamingSessionId={controller.renamingSessionId}
      renameError={controller.renameError}
      canStartAgent={controller.canStartAgent}
      submissionDisabled={!controller.canSubmitAgent}
      agentUnavailableReason={controller.agentUnavailableReason}
      terminalConflict={controller.terminalConflict}
      historyScopeLabel={controller.historyScopeLabel}
      terminalConnected={activeTerminalStatus === 'connected'}
      terminalReconnecting={terminalReconnecting}
      readOnlySession={controller.readOnlySession}
      historicalTargetUnavailable={controller.historicalTargetUnavailable}
      providerLabel={controller.providerLabel}
      modelLabel={controller.modelLabel}
      modelControl={(
        <AiComposerModelSelector
          disabled={modelSettingsLocked}
          selection={controller.selectedProvider}
          onSelect={controller.view && !configuringContinuation ? controller.selectModel : undefined}
          onConfigureModel={scope === 'workbench' ? openAiSettings : undefined}
        />
      )}
      permissionControl={scope === 'terminal' && activeTerminalId
        ? (
            <AgentPermissionSelector
              sessionId={activeTerminalId}
              variant="composer"
              disabled={runtimeSettingsLocked}
              mode={controller.selectedPermission}
              localDirectSandboxEnabled={controller.localSandbox && sandboxEnabled && controller.selectedExecutionSurface === 'direct'}
              onModeChange={controller.view && !configuringContinuation ? controller.selectPermission : undefined}
            />
        )
        : undefined}
      executionSurfaceControl={!focusMode && scope === 'terminal' && activeTerminalId
        ? (
            <AgentExecutionSurfaceSelector
              surface={controller.selectedExecutionSurface}
              realTerminalState={realTerminalState}
              nativeStartupTimedOut={activeTerminalStatus === 'connected' && nativeStartupTimedOut}
              glibcMismatch={controller.glibcMismatch}
              windowsPowerShell7Fallback={controller.windowsPowerShell7Fallback}
              sandboxDirectOnly={controller.sandboxDirectOnly}
              sandboxVisiblePty={controller.sandboxVisiblePty}
              disabled={executionSurfaceLocked}
              onSurfaceChange={controller.selectExecutionSurface}
            />
          )
        : undefined}
      sandboxToggleControl={controller.canToggleLocalSandbox
        ? (
            <AiControlTooltip
              controlDisabled={executionSurfaceLocked}
              label={t(controller.localSandboxOptOut ? 'ai.composer.sandbox.offTooltip' : 'ai.composer.sandbox.onTooltip')}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-7 shrink-0 gap-1 px-[7px]"
                disabled={executionSurfaceLocked}
                aria-pressed={!controller.localSandboxOptOut}
                aria-label={t(controller.localSandboxOptOut ? 'ai.composer.sandbox.off' : 'ai.composer.sandbox.on')}
                data-slot="ai-composer-sandbox-toggle"
                onClick={() => controller.setLocalSandboxOptOut(!controller.localSandboxOptOut)}
              >
                {controller.localSandboxOptOut
                  ? <ShieldOffIcon data-icon="inline-start" className="text-muted-foreground" strokeWidth={1.75} />
                  : <ShieldCheckIcon data-icon="inline-start" className="text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />}
                <span className="truncate">
                  {t(controller.localSandboxOptOut ? 'ai.composer.sandbox.off' : 'ai.composer.sandbox.on')}
                </span>
              </Button>
            </AiControlTooltip>
          )
        : undefined}
      executionSurfaceNotice={session?.header.subagent ? undefined : <>
        {focusMode && activeTerminalStatus !== 'connected' ? <FocusNoTarget /> : scope === 'terminal' && activeTerminalStatus === 'connected' && noticeState !== null
        && !(controller.sandboxVisiblePty && !activeSandboxAgentId)
        && !(terminalNeedsRecovery && terminalRecovery)
        && (controller.selectedExecutionSurface === 'boundTerminal' || controller.glibcMismatch || controller.windowsPowerShell7Fallback)
        && (!controller.readOnlySession || (focusMode && controller.historicalContinuationAvailable))
        ? <AgentTerminalBusyNotice
            key={JSON.stringify([activeTerminalId, terminalSessionId, terminalGeneration])}
            context={controller.submissionContext}
            disabled={executionSurfaceLocked}
            state={noticeState}
            glibcMismatch={controller.glibcMismatch}
            windowsPowerShell7Fallback={controller.windowsPowerShell7Fallback}
            focusMode={focusMode}
            blockedAttempt={blockedAttempt}
            switchDirectLockedByUncertain={!configuringContinuation && uncertainNativeEffects}
            reconnectDisabled={reconnectActionDisabled}
            onReconnectTerminal={handleReconnectTerminal}
            onSwitchDirect={focusMode || controller.selectedExecutionSurface === 'direct'
              ? undefined : () => controller.selectExecutionSurface('direct')} />
        : undefined}
      </>}
      onDraftChange={controller.setDraft}
      onSubmitGesture={controller.submit}
      onStop={controller.stop}
      onContinueOnReconnectedTerminal={controller.continueOnReconnectedTerminal ?? undefined}
      terminalReconnectBusy={controller.terminalReconnectBusy}
      onReconnectTerminal={scope === 'terminal' && activeTerminalId
        && (terminalRecovery || terminalNeedsRecovery || activeTerminalStatus === 'disconnected' || activeTerminalStatus === 'error')
        ? handleReconnectTerminal : undefined}
      historicalContinuationAvailable={controller.historicalContinuationAvailable}
      historicalContinuationBusy={controller.historicalContinuationBusy}
      historicalContinuationError={controller.historicalContinuationError}
      onBusyPreferenceChange={controller.setBusyPreference}
      onDismissError={controller.dismissError}
      onRetryFailedDraft={controller.retryFailedDraft}
      failedDraftRetryBlockedReason={controller.failedDraftRetryBlockedReason}
      onRetrySync={controller.retrySync}
      onRetryModel={controller.canSubmitAgent ? controller.retryModel : undefined}
      retryingModel={controller.retryingModel}
      onOpenModel={openAiSettings}
      onHistory={controller.openSessions}
      onRefreshSessions={controller.refreshSessions}
      onReadSession={controller.readSessionReference}
      onNewSession={controller.newSession}
      onOpenSession={controller.openSession}
      onArchiveSession={controller.archiveSession}
      onDeleteSession={controller.deleteSession}
      onEditQueueItem={controller.editQueueItem}
      onUpdateQueueItem={controller.updateQueueItem}
      onDiscardQueueEdit={controller.discardQueueEdit}
      onRemoveQueueItem={controller.removeQueueItem}
      onSteerQueueItem={controller.steerQueueItem}
      onResumeQueueItem={controller.resumeQueueItem}
      onReorderQueueLane={controller.reorderQueueLane}
      onRenameSession={controller.renameSession}
      onBack={controller.back}
      onOpenStoredOutput={controller.openStoredToolOutput}
      onOpenArtifact={controller.openArtifactDetails}
      onScrollAnchorChange={controller.saveScrollAnchor}
      onRouteReturnComplete={controller.completeRouteReturn}
      onApprove={controller.approve}
      onReject={controller.reject}
      onOpenRollback={canRollbackCheckpoints ? handleOpenRollback : undefined}
      onLoadOlder={controller.loadOlder}
      loadArtifact={controller.loadArtifact}
      onClose={onClose}
    />
  );
}

type AiScopedControllerProps = Omit<AiWorkspaceControllerProps, 'scope'>;

/** Lightweight, terminal-free question and answer surface. */
export function WorkbenchAskController(props: AiScopedControllerProps): React.ReactNode {
  return <AiWorkspaceController {...props} scope="workbench" />;
}

/** Full Agent surface bound to the active terminal session. */
export function TerminalAgentController(props: AiScopedControllerProps): React.ReactNode {
  return <AiWorkspaceController {...props} scope="terminal" />;
}
