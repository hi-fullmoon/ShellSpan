import { useEffect, useRef } from 'react';

import { useI18n } from '@/hooks/useI18n';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { findConversationTool } from '@/lib/ai/conversation-tool';
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
import { AiComposerSeat } from './ai-composer-seat';
import { AiEmptyHero } from './ai-empty-hero';
import { AiConversation } from './ai-conversation';
import { AiSessionHeader } from './ai-session-header';
import { AiSessionBrowser } from './ai-session-browser';
import { AiToolDetails } from './ai-tool-details';
import { AiArtifactDetails } from './ai-artifact-details';
import type { AiQueueMutationState } from './use-ai-session-controller';

export interface AiWorkspaceSubmitInput {
  readonly content: string;
}

export interface AiWorkspaceRootProps {
  readonly imageControls?: React.ReactNode;
  readonly onPasteImages?: (files: File[]) => void | Promise<void>;
  readonly hasImages?: boolean;
  readonly imageBusy?: boolean;
  readonly imageLocked?: boolean;
  readonly view: AiSessionView | null;
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly title?: string;
  readonly draft?: string;
  readonly defaultDraft?: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  readonly modelControl?: React.ReactNode;
  readonly permissionControl?: React.ReactNode;
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
  readonly onListFileReferences?: import('@/types/agent-file-reference').ListFileReferences;
  readonly onListSkills?: (root?: string) => Promise<import('@/types/agent-skill').SkillUserList>;
  readonly skillsScopeKey?: string;
  readonly skillsNeedsRoot?: boolean;
  readonly projectTargetLabel?: string;
  readonly onAnswerQuestion?: (input: import('@/types/agent-question').AnswerQuestionInput) => Promise<void>;
  readonly loadingOlder?: boolean;
  readonly queueMutation?: AiQueueMutationState | null;
  readonly renamingSessionId?: string | null;
  readonly renameError?: string | null;
  readonly canStartAgent?: boolean;
  readonly agentUnavailableReason?: string | null;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (input: AiWorkspaceSubmitInput) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onRetryTurn?: () => void;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onRetryFailedDraft?: (failedDraftId: string) => void;
  readonly onDismissError?: () => void;
  readonly onOpenModel?: () => void;
  readonly onNewSession?: () => void;
  readonly onHistory?: () => void;
  readonly onRefreshSessions?: () => void;
  readonly onClose?: () => void;
  readonly onOpenSession?: (summary: AiSessionSummary) => void;
  readonly onArchiveSession?: (summary: AiSessionSummary) => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
  readonly onResumeQueueItem?: (item: AiInboxItem) => void;
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
  imageControls, onPasteImages, hasImages, imageBusy, imageLocked,
  view,
  scope,
  title,
  draft,
  defaultDraft,
  providerLabel,
  modelLabel,
  modelControl,
  permissionControl,
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
  onAnswerQuestion,
  onListFileReferences,
  onListSkills,
  skillsScopeKey,
  skillsNeedsRoot,
  projectTargetLabel,
  loadingOlder = false,
  queueMutation = null,
  renamingSessionId = null,
  renameError = null,
  canStartAgent = false,
  agentUnavailableReason = null,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onRetryTurn,
  onBusyPreferenceChange,
  onRetryFailedDraft,
  onDismissError,
  onOpenModel,
  onNewSession,
  onHistory,
  onRefreshSessions,
  onClose,
  onOpenSession,
  onArchiveSession,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onSteerQueueItem,
  onResumeQueueItem,
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
  const route = navigation.route;
  const sessionKind = view?.summary.kind ?? 'agent';
  const status = view?.status ?? composerState?.runtimeStatus ?? 'idle';
  const visibleNodes = view?.nodes ?? pendingNodes;
  const selectedSessionId = view?.summary.id ?? composerState?.sessionId
    ?? (route.kind === 'conversation' ? route.sessionId : null);
  const sessionLoading = !view && selectedSessionId !== null && visibleNodes.length === 0;
  const taskSteps = view?.snapshot.kind === 'agent'
    ? view.snapshot.value.task.plan?.steps ?? []
    : [];
  const hero = !sessionLoading && visibleNodes.length === 0 && status === 'idle' && composerState?.phase !== 'submitting';
  const resolvedTitle = title ?? view?.summary.title
    ?? sessions.find((summary) => summary.id === selectedSessionId)?.title
    ?? t('ai.newConversation');
  const heroTitle = scope === 'terminal'
    ? t('agent.emptyTitle')
    : t('ai.workbench.emptyTitle');
  const heroDescription = scope === 'terminal'
    ? t('agent.emptyDescription')
    : t('ai.workbench.empty');
  const sessionLedgerKey = view ? sessionRouteKey(view.summary.kind, view.summary.id) : null;
  const scrollAnchor = sessionLedgerKey
    ? navigation.scrollAnchorBySession[sessionLedgerKey]
    : undefined;
  const toolDetailsNode = route.kind === 'toolDetails' && view
    ? findConversationTool(view.nodes, route)
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

  return (
    <section
      ref={rootRef}
      data-slot="ai-workspace-root"
      data-phase={hero ? 'hero' : 'active'}
      data-session-kind={sessionKind}
      className="ai-workspace-root"
      aria-label={t('ai.workspace')}
    >
      {route.kind === 'toolDetails' ? (
        <AiToolDetails
          node={toolDetailsNode ?? null}
          onBack={() => onBack?.()}
          onClose={onClose}
        />
      ) : route.kind === 'artifactDetails' ? (
        <AiArtifactDetails
          sessionId={route.sessionId}
          node={artifactDetailsNode?.kind === 'artifact' ? artifactDetailsNode : null}
          load={loadArtifact ?? (() => Promise.reject(new Error(t('ai.workspace.details.artifactUnavailable'))))}
          onBack={() => onBack?.()}
          onClose={onClose}
        />
      ) : (
      <>
      <AiSessionHeader
        title={resolvedTitle}
        context={t(scope === 'terminal' ? 'section.terminal' : 'section.workbench')}
        status={status}
        onClose={onClose}
        onHistory={onHistory}
        historyOpen={route.kind === 'sessions'}
        onHistoryClose={onBack}
        historyContent={(
          <AiSessionBrowser
            compact
            sessions={sessions}
            activeSessionKey={sessionLedgerKey}
            loading={sessionsLoading}
            error={sessionsError}
            archivingId={archivingSessionId}
            renamingId={renamingSessionId}
            renameError={renameError}
            canStartAgent={canStartAgent}
            agentUnavailableReason={agentUnavailableReason}
            onBack={() => onBack?.()}
            onNew={() => onNewSession?.()}
            onRefresh={() => onRefreshSessions?.()}
            onOpen={(summary) => onOpenSession?.(summary)}
            onArchive={(summary) => onArchiveSession?.(summary)}
            onRename={(summary, nextTitle) => onRenameSession?.(summary, nextTitle)}
          />
        )}
        onNewSession={onNewSession && canStartAgent ? onNewSession : undefined}
      />

      <div
        data-slot="ai-workspace-body"
        className="ai-workspace-body"
      >
        <div
          data-slot="ai-workspace-content"
          className="ai-workspace-content"
          aria-busy={sessionLoading || undefined}
        >
          {sessionLoading ? null : hero ? (
            <AiEmptyHero
              title={heroTitle}
              description={heroDescription}
            />
          ) : (
            <AiConversation
              key={sessionLedgerKey ?? 'pending'}
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
          )}
        </div>

        <AiComposerSeat
          imageControls={imageControls} onPasteImages={onPasteImages} hasImages={hasImages} imageBusy={imageBusy} imageLocked={imageLocked}
          phase={hero ? 'hero' : 'active'}
          status={status}
          draft={draft}
          defaultDraft={defaultDraft}
          providerLabel={providerLabel}
          modelLabel={modelLabel}
          modelControl={modelControl}
          contextUsage={view?.contextUsage}
          permissionControl={permissionControl}
          composerState={composerState}
          inbox={view?.inbox}
          taskSteps={taskSteps}
          queueMutation={queueMutation}
          queueMutable={Boolean(view && !view.summary.archived && !view.snapshot.value.ended)}
          announcement={announcement}
          pendingApproval={view?.pendingApproval}
          pendingQuestion={view?.pendingQuestion}
          onAnswerQuestion={onAnswerQuestion}
          onListFileReferences={onListFileReferences}
          onListSkills={onListSkills}
          skillsScopeKey={skillsScopeKey}
          skillsNeedsRoot={skillsNeedsRoot}
          projectTargetLabel={projectTargetLabel}
          approvalDecision={approvalDecision}
          approvalError={approvalError}
          unavailableReason={agentUnavailableReason}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit ? (content) => onSubmit({ content }) : undefined}
          onSubmitGesture={onSubmitGesture}
          onStop={onStop}
          onRetryTurn={onRetryTurn}
          onBusyPreferenceChange={onBusyPreferenceChange}
          onUpdateQueueItem={onUpdateQueueItem}
          onRemoveQueueItem={onRemoveQueueItem}
          onSteerQueueItem={onSteerQueueItem}
          onResumeQueueItem={onResumeQueueItem}
          onReorderQueueLane={onReorderQueueLane}
          onRetryQueueMutation={onRetryQueueMutation}
          onRetryFailedDraft={onRetryFailedDraft}
          onDismissError={onDismissError}
          onOpenModel={onOpenModel}
          onApprove={onApprove}
          onReject={onReject}
          onOpenApprovalDetails={() => {
            const approval = view?.pendingApproval;
            if (!view || !approval) return;
            const tool = findConversationTool(view.nodes, approval);
            if (tool) onOpenTool?.(tool);
          }}
        />
      </div>
      </>
      )}
    </section>
  );
}
