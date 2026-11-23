import { useLayoutEffect } from 'react';
import type { AppSection } from '@/types';
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
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
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
  const activeTerminalStatus = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  )?.status);
  const nativeStartupTimedOut = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  )?.integrationReason === 'nativeStartupTimedOut');
  const terminalReconnecting = useTerminalStore((state) => state.sessions.find(
    candidate => candidate.sessionId === activeTerminalId,
  )?.reconnecting ?? false);
  const activeTerminalNativeRecoveryRequired = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  )?.nativeRecoveryRequired ?? false);
  const terminalRecovery = !controller.readOnlySession && terminalExecutionRecovery(controller.view);
  const terminalGeneration = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  )?.terminalGeneration);
  const terminalSessionId = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === activeTerminalId,
  )?.terminalSessionId);
  const session = controller.view?.snapshot.value;
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
  const noticeState = terminalNeedsRecovery && !controller.glibcMismatch
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
  return (
    <AiWorkspaceRoot
      headerActions={focusMode && !terminalOpen ? <FocusControls /> : undefined}
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
              localDirectSandboxEnabled={controller.sandboxDirectOnly === 'local' && sandboxEnabled && controller.selectedExecutionSurface === 'direct'}
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
              sandboxDirectOnly={controller.sandboxDirectOnly}
              disabled={executionSurfaceLocked}
              onSurfaceChange={controller.selectExecutionSurface}
            />
          )
        : undefined}
      executionSurfaceNotice={session?.header.subagent ? undefined : <>
        {focusMode && activeTerminalStatus !== 'connected' ? <FocusNoTarget /> : scope === 'terminal' && activeTerminalStatus === 'connected' && noticeState !== null
        && !(terminalNeedsRecovery && terminalRecovery)
        && (controller.selectedExecutionSurface === 'boundTerminal' || controller.glibcMismatch)
        && (!controller.readOnlySession || (focusMode && controller.historicalContinuationAvailable))
        ? <AgentTerminalBusyNotice
            key={JSON.stringify([activeTerminalId, terminalSessionId, terminalGeneration])}
            context={controller.submissionContext}
            disabled={executionSurfaceLocked}
            state={noticeState}
            glibcMismatch={controller.glibcMismatch}
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
