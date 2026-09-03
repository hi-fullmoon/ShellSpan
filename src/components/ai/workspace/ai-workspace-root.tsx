import { useEffect, useRef, useState } from 'react';

import { useI18n } from '@/hooks/useI18n';
import type { AiSessionKind } from '@/lib/ai/conversation-node';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiComposerState } from '@/lib/ai/composer-machine';
import type { AiInboxItem, AiSessionView } from '@/lib/ai/session-adapter';
import type { AiSessionSummary } from '@/lib/ai/session-adapter';
import {
  createAiWorkspaceNavigationState,
  sessionRouteKey,
  type AiScrollAnchor,
  type AiWorkspaceNavigationState,
} from '@/lib/ai/panel-route';
import type { AgentArtifactResponse } from '@/types/agent-session';
import type { AppSection } from '@/types';
import { cn } from '@/lib/utils';
import { AiComposerSeat } from './ai-composer-seat';
import { AiEmptyHero } from './ai-empty-hero';
import { AiConversation } from './ai-conversation';
import { AiSessionHeader } from './ai-session-header';
import { AiSessionTabs, type AiWorkspaceTab } from './ai-session-tabs';
import { AiSessionBrowser } from './ai-session-browser';
import { AiToolDetails } from './ai-tool-details';
import { AiArtifactDetails } from './ai-artifact-details';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiWorkspaceSubmitInput {
  readonly content: string;
  readonly kind: AiSessionKind;
}

export interface AiWorkspaceRootProps {
  readonly view: AiSessionView | null;
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly initialPreset?: AiSessionKind;
  readonly title?: string;
  readonly draft?: string;
  readonly defaultDraft?: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  readonly contextLabel?: string;
  readonly permissionControl?: React.ReactNode;
  readonly selectedTab?: AiWorkspaceTab;
  readonly activityContent?: React.ReactNode;
  readonly composerState?: AiComposerState;
  readonly pendingNodes?: readonly AiConversationNode[];
  readonly announcement?: string | null;
  readonly navigation?: AiWorkspaceNavigationState;
  readonly sessions?: readonly AiSessionSummary[];
  readonly sessionsLoading?: boolean;
  readonly sessionsError?: string | null;
  readonly archivingSessionId?: string | null;
  readonly approvalDecision?: 'approve' | 'reject' | null;
  readonly approvalError?: string | null;
  readonly loadingOlder?: boolean;
  readonly queueMutation?: AiQueueMutationState | null;
  readonly renamingSessionId?: string | null;
  readonly renameError?: string | null;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (input: AiWorkspaceSubmitInput) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onRetryFailedDraft?: (failedDraftId: string) => void;
  readonly onDismissError?: () => void;
  readonly onSelectPreset?: (kind: AiSessionKind) => void;
  readonly onSelectedTabChange?: (tab: AiWorkspaceTab) => void;
  readonly onOpenProvider?: () => void;
  readonly onOpenModel?: () => void;
  readonly onOpenContext?: () => void;
  readonly onNewSession?: () => void;
  readonly onHistory?: () => void;
  readonly onClose?: () => void;
  readonly onOpenSession?: (summary: AiSessionSummary) => void;
  readonly onArchiveSession?: (summary: AiSessionSummary) => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onReorderQueueLane?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onRetryQueueMutation?: () => void;
  readonly onRenameSession?: (summary: AiSessionSummary, title: string) => void;
  readonly onBack?: () => void;
  readonly onOpenTool?: (node: import('@/lib/ai/conversation-node').AiConversationNodeOf<'tool'>) => void;
  readonly onOpenArtifact?: (node: import('@/lib/ai/conversation-node').AiConversationNodeOf<'artifact'>) => void;
  readonly onScrollAnchorChange?: (anchor: AiScrollAnchor) => void;
  readonly onRouteReturnComplete?: () => void;
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly onLoadOlder?: () => void;
  readonly loadArtifact?: (sessionId: string, artifactId: string, maxBytes: number) => Promise<AgentArtifactResponse>;
}

export function AiWorkspaceRoot({
  view,
  scope,
  initialPreset = 'ask',
  title,
  draft,
  defaultDraft,
  providerLabel,
  modelLabel,
  contextLabel,
  permissionControl,
  selectedTab,
  activityContent,
  composerState,
  pendingNodes = [],
  announcement,
  navigation = createAiWorkspaceNavigationState(view?.summary.id ?? null),
  sessions = [],
  sessionsLoading = false,
  sessionsError = null,
  archivingSessionId = null,
  approvalDecision = null,
  approvalError = null,
  loadingOlder = false,
  queueMutation = null,
  renamingSessionId = null,
  renameError = null,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onBusyPreferenceChange,
  onRetryFailedDraft,
  onDismissError,
  onSelectPreset,
  onSelectedTabChange,
  onOpenProvider,
  onOpenModel,
  onOpenContext,
  onNewSession,
  onHistory,
  onClose,
  onOpenSession,
  onArchiveSession,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onReorderQueueLane,
  onRetryQueueMutation,
  onRenameSession,
  onBack,
  onOpenTool,
  onOpenArtifact,
  onScrollAnchorChange,
  onRouteReturnComplete,
  onApprove,
  onReject,
  onLoadOlder,
  loadArtifact,
}: AiWorkspaceRootProps): React.ReactNode {
  const { t } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const [preset, setPreset] = useState<AiSessionKind>(initialPreset);
  const sessionKind = view?.summary.kind ?? preset;
  const status = view?.status ?? composerState?.runtimeStatus ?? 'idle';
  const visibleNodes = view?.nodes ?? pendingNodes;
  const hero = visibleNodes.length === 0 && status === 'idle' && composerState?.phase !== 'submitting';
  const resolvedTitle = title ?? view?.summary.title ?? t('ai.newConversation');
  const heroTitle = sessionKind === 'agent'
    ? t('agent.emptyTitle')
    : scope === 'terminal'
      ? t('ai.terminal.emptyTitle')
      : t('ai.workbench.emptyTitle');
  const heroDescription = sessionKind === 'agent'
    ? t('agent.emptyDescription')
    : scope === 'terminal'
      ? t('ai.terminal.empty')
      : t('ai.workbench.empty');
  const route = navigation.route;
  const sessionLedgerKey = view ? sessionRouteKey(view.summary.kind, view.summary.id) : null;
  const resolvedTab = selectedTab
    ?? (sessionLedgerKey ? navigation.selectedTabBySession[sessionLedgerKey] : undefined);
  const scrollAnchor = sessionLedgerKey
    ? navigation.scrollAnchorBySession[sessionLedgerKey]
    : undefined;
  const toolDetailsNode = route.kind === 'toolDetails'
    ? view?.nodes.find((node) => node.kind === 'tool' && node.key === route.nodeKey)
    : undefined;
  const artifactDetailsNode = route.kind === 'artifactDetails'
    ? view?.nodes.find((node) => node.kind === 'artifact' && node.artifactId === route.artifactId)
    : undefined;

  useEffect(() => {
    const target = navigation.returnFocus;
    if (route.kind !== 'conversation' || !target) return;
    const frame = requestAnimationFrame(() => {
      const node = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-ai-node-key]') ?? [])]
        .find((candidate) => candidate.dataset.aiNodeKey === target.nodeKey);
      node?.querySelector<HTMLElement>('[data-ai-node-action]')?.focus({ preventScroll: true });
      onRouteReturnComplete?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation.returnFocus, onRouteReturnComplete, route.kind]);

  const selectPreset = (kind: AiSessionKind): void => {
    if (view) return;
    setPreset(kind);
    onSelectPreset?.(kind);
  };

  return (
    <section
      ref={rootRef}
      data-slot="ai-workspace-root"
      data-phase={hero ? 'hero' : 'active'}
      data-session-kind={sessionKind}
      className="@container/ai-workspace flex size-full min-h-0 min-w-0 flex-col overflow-x-hidden bg-background text-foreground"
      aria-label={t('ai.workspace')}
    >
      {route.kind === 'sessions' ? (
        <AiSessionBrowser
          sessions={sessions}
          loading={sessionsLoading}
          error={sessionsError}
          archivingId={archivingSessionId}
          renamingId={renamingSessionId}
          renameError={renameError}
          onBack={() => onBack?.()}
          onNew={() => onNewSession?.()}
          onOpen={(summary) => onOpenSession?.(summary)}
          onArchive={(summary) => onArchiveSession?.(summary)}
          onRename={(summary, nextTitle) => onRenameSession?.(summary, nextTitle)}
        />
      ) : route.kind === 'toolDetails' ? (
        <AiToolDetails
          node={toolDetailsNode?.kind === 'tool' ? toolDetailsNode : null}
          onBack={() => onBack?.()}
        />
      ) : route.kind === 'artifactDetails' ? (
        <AiArtifactDetails
          sessionId={route.sessionId}
          node={artifactDetailsNode?.kind === 'artifact' ? artifactDetailsNode : null}
          load={loadArtifact ?? (() => Promise.reject(new Error(t('ai.workspace.details.artifactUnavailable'))))}
          onBack={() => onBack?.()}
        />
      ) : (
      <>
      <AiSessionHeader
        title={resolvedTitle}
        status={status}
        onClose={onClose}
        onHistory={onHistory}
        onNewSession={onNewSession}
      />

      <div
        data-slot="ai-workspace-body"
        className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col',
          hero && 'justify-center',
        )}
      >
        <div
          data-slot="ai-workspace-content"
          className={cn(
            'flex min-h-0 min-w-0 flex-col',
            hero ? 'shrink justify-end' : 'flex-1',
          )}
        >
          {hero ? (
            <AiEmptyHero
              title={heroTitle}
              description={heroDescription}
              contextLabel={contextLabel}
              presetLabel={sessionKind === 'agent' ? t('ai.mode.agent') : t('ai.mode.ask')}
            />
          ) : view?.summary.kind === 'agent' ? (
            <AiSessionTabs
              view={view}
              selectedTab={resolvedTab}
              onSelectedTabChange={onSelectedTabChange}
              activityContent={activityContent}
              conversationProps={{
                initialAnchor: scrollAnchor,
                onAnchorChange: onScrollAnchorChange,
                onOpenTool,
                onOpenArtifact,
                canLoadOlder: view.canLoadOlder,
                loadingOlder,
                onLoadOlder,
              }}
            />
          ) : visibleNodes.length > 0 ? (
            <AiConversation
              nodes={visibleNodes}
              status={status}
              throughSeq={view?.throughSeq ?? null}
              initialAnchor={scrollAnchor}
              onAnchorChange={onScrollAnchorChange}
              onOpenTool={onOpenTool}
              onOpenArtifact={onOpenArtifact}
              canLoadOlder={view?.canLoadOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={onLoadOlder}
            />
          ) : null}
        </div>

        <AiComposerSeat
          phase={hero ? 'hero' : 'active'}
          sessionKind={sessionKind}
          status={status}
          presetLocked={view !== null}
          draft={draft}
          defaultDraft={defaultDraft}
          providerLabel={providerLabel}
          modelLabel={modelLabel}
          contextLabel={contextLabel}
          permissionControl={permissionControl}
          composerState={composerState}
          inbox={view?.inbox}
          queueMutation={queueMutation}
          announcement={announcement}
          pendingApproval={view?.pendingApproval}
          approvalDecision={approvalDecision}
          approvalError={approvalError}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit ? (content) => onSubmit({ content, kind: sessionKind }) : undefined}
          onSubmitGesture={onSubmitGesture}
          onStop={onStop}
          onBusyPreferenceChange={onBusyPreferenceChange}
          onUpdateQueueItem={onUpdateQueueItem}
          onRemoveQueueItem={onRemoveQueueItem}
          onReorderQueueLane={onReorderQueueLane}
          onRetryQueueMutation={onRetryQueueMutation}
          onRetryFailedDraft={onRetryFailedDraft}
          onDismissError={onDismissError}
          onSelectPreset={selectPreset}
          onOpenProvider={onOpenProvider}
          onOpenModel={onOpenModel}
          onOpenContext={onOpenContext}
          onApprove={onApprove}
          onReject={onReject}
          onOpenApprovalDetails={() => {
            const approval = view?.pendingApproval;
            const tool = view?.nodes.find((node) => node.kind === 'tool' && node.callId === approval?.callId);
            if (tool?.kind === 'tool') onOpenTool?.(tool);
          }}
        />
      </div>
      </>
      )}
    </section>
  );
}
