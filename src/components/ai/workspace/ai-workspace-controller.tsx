import type { AppSection } from '@/types';
import {
  terminalConnectionPresentationState,
} from '@/lib/terminal/terminal-surface-semantics';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';
import { AiComposerModelSelector } from './ai-composer-model-selector';
import { AiWorkspaceRoot } from './ai-workspace-root';
import { AiImageDraftControls } from './ai-image-attachments';
import {
  useAiSessionController,
  type AiSessionControllerAdapter,
} from './use-ai-session-controller';

export interface AiWorkspaceControllerProps {
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly adapter?: AiSessionControllerAdapter;
  readonly onClose?: () => void;
}

export function AiWorkspaceController({
  scope,
  adapter,
  onClose,
}: AiWorkspaceControllerProps): React.ReactNode {
  const controller = useAiSessionController({ scope, adapter });
  const activeTerminalId = useTerminalStore((state) => state.activeSessionId);
  const activeTerminalStatus = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === state.activeSessionId,
  )?.status);
  const activeTerminalIntegrationState = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === state.activeSessionId,
  )?.integrationState);
  const activeTerminalPromptReady = useTerminalStore((state) => state.sessions.find(
    (candidate) => candidate.sessionId === state.activeSessionId,
  )?.promptReady);
  const session = controller.view?.snapshot.value;
  const configuringContinuation = controller.historicalContinuationAvailable;
  const existingSessionLocked = !configuringContinuation
    && Boolean(session?.archived || session?.header.subagent);
  const modelSettingsLocked = controller.settingsBusy || !controller.canStartAgent
    || controller.historicalContinuationBusy
    || (controller.readOnlySession && !configuringContinuation)
    || existingSessionLocked;
  const runtimeSettingsLocked = modelSettingsLocked;
  const executionSurfaceLocked = modelSettingsLocked
    || (!configuringContinuation && (
      controller.composer.phase === 'submitting'
      || controller.composer.phase === 'stopping'
      || (controller.view
        ? controller.view.status === 'running'
          || controller.view.status === 'waiting'
          || Boolean(controller.view.snapshot.value.uncertainNativeEffects)
          || Boolean(controller.view.pendingApproval || controller.view.pendingQuestion)
        : Boolean(controller.composer.sessionId))
    ));
  const realTerminalState = activeTerminalStatus === 'connected'
    ? activeTerminalIntegrationState === 'ready'
      ? activeTerminalPromptReady
        ? 'ready'
        : 'busy'
      : activeTerminalIntegrationState === 'initializing'
        ? 'initializing'
      : activeTerminalIntegrationState === 'unavailable'
          || activeTerminalIntegrationState === 'invalidated'
          ? 'unavailable'
          : 'unavailable'
    : terminalConnectionPresentationState(activeTerminalStatus);
  const imageDraftVisible = Boolean(
    controller.imageDraft.draft?.images.length || controller.imageDraft.pendingFiles.length,
  );
  const openAiSettings = (): void => useAppStore.getState().openSettings('ai');
  return (
    <AiWorkspaceRoot
      mode={scope === 'workbench' ? 'ask' : 'agent'}
      view={controller.view}
      imageControls={imageDraftVisible
        ? <AiImageDraftControls state={controller.imageDraft} selection={controller.selectedProvider} />
        : null}
      onPasteImages={controller.canStartAgent ? controller.imageDraft.add : undefined}
      hasImages={Boolean(controller.imageDraft.draft?.images.length)}
      imageBusy={controller.imageDraft.busy}
      imageSubmissionId={controller.imageDraft.submittedOperationId}
      imageLocked={controller.imageDraft.locked}
      onAnswerQuestion={controller.answerQuestion}
      onListFileReferences={controller.listFileReferences}
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
      renamingSessionId={controller.renamingSessionId}
      renameError={controller.renameError}
      canStartAgent={controller.canStartAgent}
      agentUnavailableReason={controller.agentUnavailableReason}
      historyScopeLabel={controller.historyScopeLabel}
      readOnlySession={controller.readOnlySession}
      providerLabel={controller.providerLabel}
      modelLabel={controller.modelLabel}
      modelControl={(
        <AiComposerModelSelector
          disabled={modelSettingsLocked}
          selection={controller.selectedProvider}
          onSelect={controller.view && !configuringContinuation ? controller.selectModel : undefined}
        />
      )}
      permissionControl={scope === 'terminal' && activeTerminalId
        ? (
            <AgentPermissionSelector
              sessionId={activeTerminalId}
              variant="composer"
              disabled={runtimeSettingsLocked}
              mode={controller.selectedPermission}
              onModeChange={controller.view && !configuringContinuation ? controller.selectPermission : undefined}
            />
        )
        : undefined}
      executionSurfaceControl={scope === 'terminal' && activeTerminalId
        ? (
            <AgentExecutionSurfaceSelector
              surface={controller.selectedExecutionSurface}
              realTerminalState={realTerminalState}
              disabled={executionSurfaceLocked}
              onSurfaceChange={controller.selectExecutionSurface}
            />
          )
        : undefined}
      onDraftChange={controller.setDraft}
      onSubmitGesture={controller.submit}
      onStop={controller.stop}
      onContinueBudgetedTurn={controller.continueBudgetedTurn}
      onContinueOnReconnectedTerminal={controller.continueOnReconnectedTerminal ?? undefined}
      historicalContinuationAvailable={controller.historicalContinuationAvailable}
      historicalContinuationBusy={controller.historicalContinuationBusy}
      historicalContinuationError={controller.historicalContinuationError}
      onBusyPreferenceChange={controller.setBusyPreference}
      onRetryFailedDraft={controller.retryFailedDraft}
      onDismissError={controller.dismissError}
      onOpenModel={openAiSettings}
      onHistory={controller.openSessions}
      onRefreshSessions={controller.refreshSessions}
      onNewSession={controller.newSession}
      onOpenSession={controller.openSession}
      onArchiveSession={controller.archiveSession}
      onDeleteSession={controller.deleteSession}
      onUpdateQueueItem={controller.updateQueueItem}
      onRemoveQueueItem={controller.removeQueueItem}
      onSteerQueueItem={controller.steerQueueItem}
      onResumeQueueItem={controller.resumeQueueItem}
      onReorderQueueLane={controller.reorderQueueLane}
      onRetryQueueMutation={controller.retryQueueMutation}
      onRenameSession={controller.renameSession}
      onBack={controller.back}
      onOpenTool={controller.openToolDetails}
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
