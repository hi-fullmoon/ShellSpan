import type { AppSection } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AiWorkspaceRoot } from './ai-workspace-root';
import {
  useAiSessionController,
  type AiSessionControllerAdapters,
} from './use-ai-session-controller';

export interface AiWorkspaceControllerProps {
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly adapters?: AiSessionControllerAdapters;
  readonly onClose?: () => void;
}

export function AiWorkspaceController({
  scope,
  adapters,
  onClose,
}: AiWorkspaceControllerProps): React.ReactNode {
  const controller = useAiSessionController({ scope, adapters });
  const activeTerminalId = useTerminalStore((state) => state.activeSessionId);
  const openAiSettings = (): void => useAppStore.getState().openSettings('ai');
  return (
    <AiWorkspaceRoot
      view={controller.view}
      pendingNodes={controller.pendingNodes}
      scope={scope}
      initialPreset={controller.preset}
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
      providerLabel={controller.providerLabel}
      modelLabel={controller.modelLabel}
      permissionControl={scope === 'terminal' && activeTerminalId
        ? <AgentPermissionSelector sessionId={activeTerminalId} variant="composer" />
        : undefined}
      onDraftChange={controller.setDraft}
      onSubmitGesture={controller.submit}
      onStop={controller.stop}
      onSelectPreset={controller.setPreset}
      onBusyPreferenceChange={controller.setBusyPreference}
      onRetryFailedDraft={controller.retryFailedDraft}
      onDismissError={controller.dismissError}
      onOpenProvider={openAiSettings}
      onOpenModel={openAiSettings}
      onHistory={controller.openSessions}
      onNewSession={controller.newSession}
      onOpenSession={controller.openSession}
      onArchiveSession={controller.archiveSession}
      onUpdateQueueItem={controller.updateQueueItem}
      onRemoveQueueItem={controller.removeQueueItem}
      onReorderQueueLane={controller.reorderQueueLane}
      onRetryQueueMutation={controller.retryQueueMutation}
      onRenameSession={controller.renameSession}
      onBack={controller.back}
      onOpenTool={controller.openToolDetails}
      onOpenArtifact={controller.openArtifactDetails}
      onSelectedTabChange={controller.selectTab}
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
