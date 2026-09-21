import { useEffect, useId, useMemo, useRef } from 'react';
import { CircleAlertIcon, InfoIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { ShellSpanGlyph } from '@/components/brand/shellspan-mark';
import { Spinner } from '@/components/ui/spinner';

import { useI18n } from '@/hooks/useI18n';
import { aiErrorMessage } from '@/lib/ai/error-message';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { canResumeTokenBudgetedTask, hasTokenBudgetCheckpoint, taskBudgetArtifactTitleKey } from '@/lib/ai/task-token-budget';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { useFirstSubmitTransition } from './use-first-submit-transition';
import { AiEmptyHero } from './ai-empty-hero';
import { AiConversation } from './ai-conversation';
import { aiAskConversationNodeRenderers } from './ai-conversation-node-seat';
import { AiSessionHeader } from './ai-session-header';
import { AiSessionBrowser } from './ai-session-browser';
import {
  AiSubagentCatalog,
  type AiSubagentCatalogEntry,
} from './ai-subagent-catalog';
import { AiToolDetails } from './ai-tool-details';
import { AiArtifactDetails } from './ai-artifact-details';
import type { AiQueueMutationState } from './use-ai-session-controller';
import { AiWorkspaceErrorNotices } from './ai-workspace-error-notices';

export interface AiWorkspaceSubmitInput {
  readonly content: string;
}

function askConversationNodes(nodes: readonly AiConversationNode[]): readonly AiConversationNode[] {
  return nodes.flatMap((node): readonly AiConversationNode[] => {
    if (
      node.kind === 'userMessage'
      || node.kind === 'assistantMessage'
      || node.kind === 'question'
      || node.kind === 'error'
      || node.kind === 'reasoning'
      || node.kind === 'turnTail'
      || (node.kind === 'artifact' && taskBudgetArtifactTitleKey(node.artifactKind) !== null)
    ) return [node];
    if (node.kind !== 'turnProcess') return [];
    const questionsAndErrors = node.children.filter((child) => child.kind === 'question' || child.kind === 'error');
    const reasoning = node.children.filter((child) => child.kind === 'reasoning');
    const first = reasoning[0];
    const visible: AiConversationNode[] = [...questionsAndErrors];
    if (first) visible.push({
      ...first,
      key: `ask-reasoning:${node.key}`,
      stepId: null,
      firstSeq: node.firstSeq,
      lastSeq: node.lastSeq,
      content: reasoning.map((child) => child.content).filter(Boolean).join('\n\n'),
      summary: first.summary,
      state: reasoning.some((child) => child.state === 'streaming')
        ? 'streaming'
        : reasoning.some((child) => child.state === 'interrupted')
          ? 'interrupted'
          : reasoning.some((child) => child.state === 'settled')
            ? 'settled'
            : 'completed',
    });
    return visible.sort((left, right) => left.firstSeq - right.firstSeq);
  });
}

function omitApprovedMarkers(nodes: readonly AiConversationNode[]): readonly AiConversationNode[] {
  return nodes.flatMap((node): readonly AiConversationNode[] => {
    if (node.kind === 'approvalMarker' && node.status === 'approved') return [];
    if (node.kind !== 'turnProcess') return [node];
    const children = node.children.filter((child) => (
      child.kind !== 'approvalMarker' || child.status !== 'approved'
    ));
    return children.length === node.children.length ? [node] : [{
      ...node,
      childKeys: children.map((child) => child.key),
      children,
    }];
  });
}

function omitSystemPrompts(nodes: readonly AiConversationNode[]): readonly AiConversationNode[] {
  return nodes.filter((node) => node.kind !== 'systemPrompt');
}

function historicalOutput<Node extends AiConversationNode>(node: Node): Node {
  if (node.kind === 'turnProcess') {
    return {
      ...node,
      status: node.status === 'running' ? 'incomplete' : node.status,
      children: node.children.map(historicalOutput),
    };
  }
  if ((node.kind === 'reasoning' && (node.state === 'streaming' || node.state === 'settled'))
    || (node.kind === 'assistantMessage' && node.state === 'streaming')) {
    return { ...node, state: 'interrupted' };
  }
  return node;
}

interface AiSubagentLineage {
  readonly root: AiSessionSummary;
  readonly current: AiSessionSummary;
  readonly entries: readonly AiSubagentCatalogEntry[];
}

function subagentLineage(
  view: AiSessionView | null,
  sessions: readonly AiSessionSummary[],
): AiSubagentLineage | null {
  if (!view) return null;
  const byId = new Map(sessions.map((summary) => [summary.id, summary]));
  byId.set(view.summary.id, { ...view.summary, status: view.status });
  const projected = new Map(
    (view.subagents ?? []).map((subagent) => [subagent.sessionId, subagent]),
  );
  for (const activity of projected.values()) {
    const existing = byId.get(activity.sessionId);
    byId.set(activity.sessionId, existing
      ? {
          ...existing,
          status: activity.status,
          parentSessionId: activity.parentSessionId ?? existing.parentSessionId,
          subagent: {
            descriptorId: activity.descriptorId ?? existing.subagent?.descriptorId ?? activity.sessionId,
            role: activity.role,
            continuable: activity.continuable,
            depth: activity.depth,
          },
        }
      : {
          id: activity.sessionId,
          kind: 'agent',
          title: activity.sessionId,
          updatedAt: view.summary.updatedAt,
          status: activity.status,
          scopeKey: view.summary.scopeKey,
          targetId: view.summary.targetId,
          parentSessionId: activity.parentSessionId ?? view.summary.id,
          subagent: {
            descriptorId: activity.descriptorId ?? activity.sessionId,
            role: activity.role,
            continuable: activity.continuable,
            depth: activity.depth,
          },
          archived: false,
        });
  }

  const current = byId.get(view.summary.id) ?? view.summary;
  let root = current;
  const ancestorIds = new Set([current.id]);
  while (root.subagent && root.parentSessionId) {
    const parent = byId.get(root.parentSessionId);
    if (!parent || ancestorIds.has(parent.id)) break;
    ancestorIds.add(parent.id);
    root = parent;
  }

  const children = new Map<string, AiSessionSummary[]>();
  for (const summary of byId.values()) {
    if (!summary.subagent || !summary.parentSessionId) continue;
    const siblings = children.get(summary.parentSessionId);
    if (siblings) siblings.push(summary);
    else children.set(summary.parentSessionId, [summary]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    ));
  }

  const entries: AiSubagentCatalogEntry[] = [];
  const visited = new Set<string>();
  const appendChildren = (parentSessionId: string, depth: number): void => {
    for (const summary of children.get(parentSessionId) ?? []) {
      if (visited.has(summary.id)) continue;
      visited.add(summary.id);
      const activity = projected.get(summary.id);
      const status = summary.status === 'running' || summary.status === 'waiting'
        ? summary.status
        : activity?.status === 'running' || activity?.status === 'waiting'
          ? activity.status
          : summary.status;
      entries.push({
        summary,
        role: activity?.role ?? summary.subagent!.role,
        continuable: activity?.continuable ?? summary.subagent!.continuable,
        status,
        depth,
        detail: activity?.summary,
      });
      appendChildren(summary.id, depth + 1);
    }
  };
  appendChildren(root.id, 1);
  return { root, current, entries };
}

export interface AiWorkspaceRootProps {
  readonly mode?: 'ask' | 'agent';
  readonly imageControls?: React.ReactNode;
  readonly onPasteImages?: (files: File[]) => void | Promise<void>;
  readonly hasImages?: boolean;
  readonly imageBusy?: boolean;
  readonly imageSubmissionId?: string;
  readonly imageLocked?: boolean;
  readonly submissionContext?: object;
  readonly view: AiSessionView | null;
  readonly restoringSession?: boolean;
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly title?: string;
  readonly draft?: string;
  readonly defaultDraft?: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  readonly modelControl?: React.ReactNode;
  readonly permissionControl?: React.ReactNode;
  readonly executionSurfaceControl?: React.ReactNode;
  readonly composerState?: AiComposerState;
  readonly pendingNodes?: readonly AiConversationNode[];
  readonly announcement?: string | null;
  readonly navigation?: AiWorkspaceNavigationState;
  readonly sessions?: readonly AiSessionSummary[];
  readonly sessionsLoading?: boolean;
  readonly sessionsError?: string | null;
  readonly archivingSessionId?: string | null;
  readonly deletingSessionId?: string | null;
  readonly approvalDecision?: 'approve' | 'reject' | null;
  readonly approvalError?: string | null;
  readonly approvalArguments?: unknown | null;
  readonly approvalArgumentsLoading?: boolean;
  readonly approvalArgumentsError?: string | null;
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
  readonly historyScopeLabel?: string | null;
  readonly readOnlySession?: boolean;
  readonly historicalTargetUnavailable?: boolean;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (input: AiWorkspaceSubmitInput) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onContinueOnReconnectedTerminal?: () => void;
  readonly historicalContinuationAvailable?: boolean;
  readonly historicalContinuationBusy?: boolean;
  readonly historicalContinuationError?: string | null;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onDismissError?: () => void;
  readonly onOpenModel?: () => void;
  readonly onNewSession?: () => void;
  readonly onHistory?: () => void;
  readonly onRefreshSessions?: () => void;
  readonly onReadSession?: (summary: AiSessionSummary, signal: AbortSignal) => Promise<File>;
  readonly onClose?: () => void;
  readonly onOpenSession?: (summary: AiSessionSummary) => void;
  readonly onArchiveSession?: (summary: AiSessionSummary) => void;
  readonly onDeleteSession?: (summary: AiSessionSummary) => void;
  readonly onUpdateQueueItem?: (item: AiInboxItem, content: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
  readonly onResumeQueueItem?: (item: AiInboxItem) => void;
  readonly onReorderQueueLane?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
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
  mode,
  imageControls, onPasteImages, hasImages, imageBusy, imageSubmissionId, imageLocked,
  submissionContext,
  view,
  restoringSession = false,
  scope,
  title,
  draft,
  defaultDraft,
  providerLabel,
  modelLabel,
  modelControl,
  permissionControl,
  executionSurfaceControl,
  composerState,
  pendingNodes = [],
  announcement,
  navigation = createAiWorkspaceNavigationState(view?.summary.id ?? null),
  sessions = [],
  sessionsLoading = false,
  sessionsError = null,
  archivingSessionId = null,
  deletingSessionId = null,
  approvalDecision = null,
  approvalError = null,
  approvalArguments = null,
  approvalArgumentsLoading = false,
  approvalArgumentsError = null,
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
  agentUnavailableReason: rawAgentUnavailableReason = null,
  historyScopeLabel = null,
  readOnlySession = false,
  historicalTargetUnavailable = false,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onContinueOnReconnectedTerminal,
  historicalContinuationAvailable = false,
  historicalContinuationBusy = false,
  historicalContinuationError = null,
  onBusyPreferenceChange,
  onDismissError,
  onOpenModel,
  onNewSession,
  onHistory,
  onRefreshSessions,
  onReadSession,
  onClose,
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onUpdateQueueItem,
  onRemoveQueueItem,
  onSteerQueueItem,
  onResumeQueueItem,
  onReorderQueueLane,
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
  const agentUnavailableReason = rawAgentUnavailableReason === null
    ? null : aiErrorMessage(rawAgentUnavailableReason, t);
  const rootRef = useRef<HTMLElement>(null);
  const route = navigation.route;
  const sessionKind = view?.summary.kind ?? 'agent';
  const status = view?.status ?? composerState?.runtimeStatus ?? 'idle';
  const visibleNodes = view?.nodes ?? pendingNodes;
  const selectedSessionId = view?.summary.id ?? composerState?.sessionId
    ?? (route.kind === 'conversation' ? route.sessionId : null);
  const sessionLoading = !view && (restoringSession || selectedSessionId !== null) && visibleNodes.length === 0;
  const taskSteps = view?.snapshot.kind === 'agent'
    ? view.snapshot.value.task.plan?.steps ?? []
    : [];
  const resolvedTitle = title ?? view?.summary.title
    ?? sessions.find((summary) => summary.id === selectedSessionId)?.title
    ?? t(scope === 'workbench' ? 'ai.workbench.conversationTitle' : 'ai.newConversation');
  const heroTitle = scope === 'terminal'
    ? t('agent.emptyTitle')
    : t('ai.workbench.emptyTitle');
  const heroDescription = scope === 'terminal'
    ? t('agent.emptyDescription')
    : t('ai.workbench.empty');
  const surfaceMode = mode ?? 'agent';
  const availabilityHintId = useId();
  const historicalComposerEnabled = readOnlySession && historicalContinuationAvailable;
  const historicalComposerDisplay = readOnlySession
    && (historicalComposerEnabled || !onContinueOnReconnectedTerminal);
  const activeComposerState = historicalComposerDisplay && composerState ? {
    ...composerState,
    phase: historicalContinuationBusy ? 'submitting' as const : 'idle' as const,
    runtimeStatus: 'idle' as const,
    sessionId: historicalComposerEnabled ? null : composerState.sessionId,
    terminal: !historicalComposerEnabled,
    waitingApproval: false,
    waitingQuestion: false,
    detached: null,
    pendingSubmissions: [],
    failedDrafts: [],
  } : composerState;
  const pendingSubmissions = activeComposerState?.pendingSubmissions;
  const submittedOperationId = pendingSubmissions?.[pendingSubmissions.length - 1]?.clientOperationId;
  const conversationNodes = useMemo(() => {
    // A detached historical session may have no final event (for example after
    // process exit). Preserve its output without presenting it as still live.
    // One-shot subagents are read-only even while their output is still live.
    const nodes = historicalTargetUnavailable ? visibleNodes.map(historicalOutput) : visibleNodes;
    return (
      surfaceMode === 'ask'
        ? askConversationNodes(nodes)
        : omitSystemPrompts(
          view?.snapshot.kind === 'agent' && view.snapshot.value.header.permissionMode === 'operator'
            ? omitApprovedMarkers(nodes)
            : nodes,
        )
    );
  }, [historicalTargetUnavailable, surfaceMode, view?.snapshot, visibleNodes]);
  const hero = !sessionLoading && conversationNodes.length === 0
    && status === 'idle' && composerState?.phase !== 'submitting';
  const firstSubmitTransition = useFirstSubmitTransition(hero, imageBusy, submissionContext);
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
  const lineage = useMemo(
    () => subagentLineage(view, sessions),
    [sessions, view],
  );

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
      data-ai-mode={surfaceMode}
      className="ai-workspace-root @container/ai-workspace flex size-full min-h-0 min-w-0 flex-col overflow-x-hidden"
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
        context={mode
          ? t(surfaceMode === 'agent' ? 'ai.terminal.scopeDescription' : 'ai.workbench.scopeDescription')
          : t(scope === 'terminal' ? 'section.terminal' : 'section.workbench')}
        status={status}
        mode={surfaceMode}
        lineage={onOpenSession && lineage
          ? (
              <AiSubagentCatalog
                {...lineage}
                onOpen={onOpenSession}
                onRefresh={onRefreshSessions}
              />
            )
          : undefined}
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
            deletingId={deletingSessionId}
            renamingId={renamingSessionId}
            renameError={renameError}
            canStartAgent={canStartAgent}
            agentUnavailableReason={agentUnavailableReason}
            scopeLabel={historyScopeLabel}
            onBack={() => onBack?.()}
            onNew={() => onNewSession?.()}
            onRefresh={() => onRefreshSessions?.()}
            onOpen={(summary) => onOpenSession?.(summary)}
            onArchive={(summary) => onArchiveSession?.(summary)}
            onDelete={(summary) => onDeleteSession?.(summary)}
            onRename={(summary, nextTitle) => onRenameSession?.(summary, nextTitle)}
          />
        )}
        onNewSession={onNewSession && canStartAgent ? onNewSession : undefined}
      />

      <AiWorkspaceErrorNotices
        composerState={activeComposerState}
        onDismissError={onDismissError}
      />

      <div
        data-slot="ai-workspace-status-notices"
        className="mx-auto flex w-full min-w-0 max-w-[calc(var(--ai-composer-card-max-width)+var(--ai-shell-clearance)+var(--ai-shell-clearance))] shrink-0 flex-col gap-1.5 px-[var(--ai-shell-clearance)] py-2 empty:hidden"
      >
        {historicalContinuationAvailable && (
          <Alert variant="info" size="sm" role="status">
            <InfoIcon aria-hidden="true" />
            <AlertDescription>{t(historicalContinuationBusy
              ? 'ai.workspace.sessions.continuePreparing'
              : 'ai.workspace.sessions.continueComposerHint')}</AlertDescription>
          </Alert>
        )}
        {historicalContinuationError && (
          <Alert variant="destructiveSubtle" size="sm" className="items-center">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{historicalContinuationError}</AlertDescription>
          </Alert>
        )}
        {!readOnlySession && canResumeTokenBudgetedTask(view) && (
          <Alert variant="info" size="sm" role="status" data-token-budget-notice="">
            <InfoIcon aria-hidden="true" />
            <AlertDescription>{t(view && hasTokenBudgetCheckpoint(view)
              ? 'ai.workspace.tokenBudget.checkpointSaved'
              : 'ai.workspace.tokenBudget.description')}</AlertDescription>
          </Alert>
        )}
        {activeComposerState?.phase === 'stopping' && (
          <Alert variant="info" size="sm" role="status">
            <InfoIcon aria-hidden="true" />
            <AlertDescription>{t('ai.workspace.stopping')}</AlertDescription>
          </Alert>
        )}
        {surfaceMode === 'agent' && activeComposerState?.phase === 'waitingApproval' && !view?.pendingApproval && (
          <Alert variant="info" size="sm">
            <InfoIcon aria-hidden="true" />
            <AlertTitle>{t('ai.workspace.approvalWaiting')}</AlertTitle>
            <AlertDescription>{t('ai.workspace.approvalPhase5')}</AlertDescription>
          </Alert>
        )}
        {activeComposerState?.phase === 'waitingQuestion' && !view?.pendingQuestion && (
          <Alert variant="info" size="sm">
            <InfoIcon aria-hidden="true" />
            <AlertTitle>{t('ai.workspace.question.pending')}</AlertTitle>
            <AlertDescription>{t('ai.workspace.announce.waitingQuestion')}</AlertDescription>
          </Alert>
        )}
        {agentUnavailableReason && (
          <Alert id={availabilityHintId} variant="info" size="sm" role="status" aria-label={t('agent.availability.title')}>
            <InfoIcon aria-hidden="true" />
            <AlertDescription className="min-w-0 break-words">{agentUnavailableReason}</AlertDescription>
          </Alert>
        )}
      </div>

      <div
        ref={firstSubmitTransition.bodyRef}
        data-slot="ai-workspace-body"
        className="ai-workspace-body relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div
          data-slot="ai-workspace-content"
          className="ai-workspace-content flex min-h-0 min-w-0 flex-1 flex-col"
          aria-busy={sessionLoading || undefined}
        >
          {sessionLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex min-h-0 flex-1 items-center justify-center gap-1 p-4 text-sm text-muted-foreground"
            >
              <Spinner aria-hidden="true" />
              <span>{t('ai.workspace.loadingSession')}</span>
            </div>
          ) : hero ? (
            <AiEmptyHero
              title={heroTitle}
              description={heroDescription}
              icon={surfaceMode === 'ask'
                ? <MessageCircleQuestionIcon />
                : <ShellSpanGlyph />}
            />
          ) : (
            <AiConversation
              key={sessionLedgerKey ?? 'pending'}
              nodes={conversationNodes}
              renderers={surfaceMode === 'ask' ? aiAskConversationNodeRenderers : undefined}
              runningIndicator={historicalTargetUnavailable ? 'none' : surfaceMode}
              pending={activeComposerState?.phase === 'submitting'
                || Boolean(pendingSubmissions?.some(submission => submission.startsTurn))}
              submittedOperationId={submittedOperationId}
              imageSubmissionId={imageSubmissionId}
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
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          currentSessionId={selectedSessionId}
          onRefreshSessions={onRefreshSessions}
          onReadSession={onReadSession}
          mode={surfaceMode}
          imageControls={imageControls}
          onPasteImages={!readOnlySession
            && !view?.snapshot.value.header.subagent ? onPasteImages : undefined}
          hasImages={hasImages}
          imageBusy={imageBusy}
          imageLocked={imageLocked}
          phase={hero ? 'hero' : 'active'}
          status={historicalComposerDisplay ? 'idle' : status}
          draft={draft}
          defaultDraft={defaultDraft}
          providerLabel={providerLabel}
          modelLabel={modelLabel}
          modelControl={modelControl}
          contextUsage={surfaceMode === 'agent' && !readOnlySession ? view?.contextUsage : undefined}
          permissionControl={surfaceMode === 'agent' ? permissionControl : undefined}
          executionSurfaceControl={surfaceMode === 'agent' ? executionSurfaceControl : undefined}
          composerState={activeComposerState}
          inbox={surfaceMode === 'agent' && !readOnlySession ? view?.inbox : undefined}
          taskSteps={surfaceMode === 'agent' && !readOnlySession ? taskSteps : undefined}
          queueMutation={surfaceMode === 'agent' && !readOnlySession ? queueMutation : undefined}
          queueMutable={Boolean(view && !readOnlySession && !view.summary.archived && !view.snapshot.value.ended)}
          announcement={announcement}
          pendingApproval={surfaceMode === 'agent' && !readOnlySession ? view?.pendingApproval : undefined}
          pendingQuestion={readOnlySession ? undefined : view?.pendingQuestion}
          onAnswerQuestion={readOnlySession ? undefined : onAnswerQuestion}
          onListFileReferences={surfaceMode === 'agent' && !readOnlySession ? onListFileReferences : undefined}
          onListSkills={surfaceMode === 'agent' && !readOnlySession ? onListSkills : undefined}
          skillsScopeKey={skillsScopeKey}
          attachmentScopeKey={sessionLedgerKey ?? skillsScopeKey}
          skillsNeedsRoot={skillsNeedsRoot}
          projectTargetLabel={projectTargetLabel}
          approvalDecision={approvalDecision}
          approvalError={approvalError}
          approvalArguments={approvalArguments}
          approvalArgumentsLoading={approvalArgumentsLoading}
          approvalArgumentsError={approvalArgumentsError}
          unavailableReason={agentUnavailableReason}
          availabilityHintId={availabilityHintId}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit ? (content) => {
            firstSubmitTransition.prepare();
            return onSubmit({ content });
          } : undefined}
          onSubmitGesture={onSubmitGesture ? (gesture, accelerated) => {
            firstSubmitTransition.prepare();
            onSubmitGesture(gesture, accelerated);
          } : undefined}
          onStop={readOnlySession ? undefined : onStop}
          onBusyPreferenceChange={surfaceMode === 'agent' && !readOnlySession
            && !view?.snapshot.value.header.subagent ? onBusyPreferenceChange : undefined}
          onUpdateQueueItem={surfaceMode === 'agent' && !readOnlySession ? onUpdateQueueItem : undefined}
          onRemoveQueueItem={surfaceMode === 'agent' && !readOnlySession ? onRemoveQueueItem : undefined}
          onSteerQueueItem={surfaceMode === 'agent' && !readOnlySession ? onSteerQueueItem : undefined}
          onResumeQueueItem={surfaceMode === 'agent' && !readOnlySession ? onResumeQueueItem : undefined}
          onReorderQueueLane={surfaceMode === 'agent' && !readOnlySession ? onReorderQueueLane : undefined}
          onOpenModel={onOpenModel}
          onApprove={surfaceMode === 'agent' && !readOnlySession ? onApprove : undefined}
          onReject={surfaceMode === 'agent' && !readOnlySession ? onReject : undefined}
          onOpenApprovalDetails={() => {
            if (readOnlySession) return;
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
