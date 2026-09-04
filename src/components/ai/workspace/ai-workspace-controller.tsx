import type { AppSection } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AgentPermissionSelector } from '../agent-permission-selector';
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
  const session = controller.view?.snapshot.value;
  const settingsLocked = controller.settingsBusy || !controller.canStartAgent
    || Boolean(session?.ended || session?.archived || session?.header.subagent)
    || ['completed', 'cancelled', 'failed'].includes(controller.view?.status ?? 'idle');
  const openAiSettings = (): void => useAppStore.getState().openSettings('ai');
  return (
    <AiWorkspaceRoot
      view={controller.view}
      imageControls={controller.imageDraft.draft?.images.length || controller.imageDraft.busy || controller.imageDraft.locked || controller.imageDraft.error ? <AiImageDraftControls state={controller.imageDraft} /> : null}
      onPasteImages={controller.canStartAgent ? controller.imageDraft.add : undefined}
      hasImages={Boolean(controller.imageDraft.draft?.images.length)}
      imageBusy={controller.imageDraft.busy}
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
      approvalDecision={controller.approvalDecision}
      approvalError={controller.approvalError}
      loadingOlder={controller.loadingOlder}
      queueMutation={controller.queueMutation}
      renamingSessionId={controller.renamingSessionId}
      renameError={controller.renameError}
      canStartAgent={controller.canStartAgent}
      agentUnavailableReason={controller.agentUnavailableReason}
      providerLabel={controller.providerLabel}
      modelLabel={controller.modelLabel}
      modelControl={(
        <AiComposerModelSelector
          disabled={settingsLocked}
          selection={controller.selectedProvider}
          onSelect={controller.view ? controller.selectModel : undefined}
        />
      )}
      permissionControl={scope === 'terminal' && activeTerminalId
        ? (
            <AgentPermissionSelector
              sessionId={activeTerminalId}
              variant="composer"
              disabled={settingsLocked}
              mode={controller.selectedPermission}
              onModeChange={controller.view ? controller.selectPermission : undefined}
            />
          )
        : undefined}
      onDraftChange={controller.setDraft}
      onSubmitGesture={controller.submit}
      onStop={controller.stop}
      onBusyPreferenceChange={controller.setBusyPreference}
      onRetryFailedDraft={controller.retryFailedDraft}
      onDismissError={controller.dismissError}
      onOpenModel={openAiSettings}
      onHistory={controller.openSessions}
      onRefreshSessions={controller.refreshSessions}
      onNewSession={controller.newSession}
      onOpenSession={controller.openSession}
      onArchiveSession={controller.archiveSession}
      onUpdateQueueItem={controller.updateQueueItem}
      onRemoveQueueItem={controller.removeQueueItem}
      onSteerQueueItem={controller.steerQueueItem}
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
