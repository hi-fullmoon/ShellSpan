import { Activity, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleAlertIcon, InfoIcon, MessageCircleQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ShellSpanGlyph } from '@/components/brand/shellspan-mark';
import { Spinner } from '@/components/ui/spinner';
import { StableContent } from '@/components/ui/stable-content';

import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { aiErrorMessage } from '@/lib/ai/error-message';
import { cn } from '@/lib/utils';
import { terminalLoginLabel } from '@/lib/ai/terminal-login-scope';
import { contextUsageForModel } from '@/lib/ai/session-settings';
import { conversationArtifacts } from '@/lib/ai/conversation-artifact';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import { taskBudgetArtifactTitleKey } from '@/lib/ai/task-token-budget';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { pendingUserAction } from '@/types/agent-question';
import type { AppSection } from '@/types';
import { AiComposerSeat } from './ai-composer-seat';
import { useFirstSubmitTransition } from './use-first-submit-transition';
import { AiEmptyHero } from './ai-empty-hero';
import { AiConversation } from './ai-conversation';
import { AiFailureRecoveryContext } from './ai-failure-recovery';
import { latestFailureRecovery } from '@/lib/ai/failure-recovery';
import { childBudgetExhausted } from '@/lib/ai/subagent-continuation';
import { terminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';
import { AiTerminalRecoveryNotice } from './ai-terminal-recovery-notice';
import { aiAskConversationNodeRenderers, AiContinueGenerationContext } from './ai-conversation-node-seat';
import {
  exportConversationFileName,
  formatConversationMarkdown,
  hasExportableConversationMessages,
} from '@/lib/ai/conversation-export';
import { invokeExportLogFile, invokeRevealPath, isTauriRuntime } from '@/lib/ipc/tauri';
import { getPlatform } from '@/lib/platform';
import { AiSessionHeader, type AiSessionHeaderSubagentNav } from './ai-session-header';
import { AiSessionBrowser } from './ai-session-browser';
import { AiSubagentCatalog } from './ai-subagent-catalog';
import { AiSubagentContext } from './ai-subagent-context';
import { AiSubagentStrip } from './ai-subagent-strip';
import { subagentModeLabel, subagentRoleLabel, subagentStatusLabel } from './ai-subagent-tree';
import {
  buildSubagentLineage,
  correlateSubagentToolSessions,
  filterActiveSubagentEntries,
} from '@/lib/ai/subagent-lineage';
import { AiArtifactDetails } from './ai-artifact-details';
import type { AiQueueMutationState } from './use-ai-session-controller';
import { AiWorkspaceErrorNotices } from './ai-workspace-error-notices';
import { AiFailedDraftRecoveryContext } from './ai-failed-draft-recovery';
import { AiNoticeTransition } from './ai-notice-transition';
import { AiNoticeAction } from './ai-notice-action';
import { AiMarkdownTargetContext, AiTerminalInsertContext } from '@/components/ai/assistant-message-content';
import {
  activateVimBridgeInTerminal,
  insertCommandIntoTerminal,
  useTerminalInsertTarget,
  useTerminalVimBridgeState,
  VIM_BRIDGE_ACTIVATION_COMMAND,
} from './ai-terminal-insert';
import { toolLiveOutputStore } from './use-tool-live-output';

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
    const notices = node.children.filter((child) => child.kind === 'question' || child.kind === 'error'
      || (child.kind === 'assistantMessage' && child.state !== 'streaming' && child.state !== 'completed'));
    const reasoning = node.children.filter((child) => child.kind === 'reasoning');
    const first = reasoning[0];
    const visible: AiConversationNode[] = [...notices];
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

const VIM_TOOL_NAMES = new Set([
  'inspect_vim_buffer',
  'insert_vim_text',
  'save_vim_buffer',
  'close_vim_editor',
]);

function isVimNotAttachedOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  return record.reason === 'editorNotAttached'
    && record.activationCommand === VIM_BRIDGE_ACTIVATION_COMMAND;
}

function latestTurnNeedsVimBridgeActivation(nodes: readonly AiConversationNode[]): boolean {
  const flat: AiConversationNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.kind === 'userMessage') break;
    if (node.kind === 'turnProcess') {
      for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
        flat.push(node.children[childIndex]);
      }
    } else {
      flat.push(node);
    }
  }
  for (const node of flat) {
    if (node.kind !== 'tool') continue;
    const name = node.nativeName ?? node.name;
    if (!VIM_TOOL_NAMES.has(name)) continue;
    if (node.state === 'succeeded') return false;
    if (node.state === 'rejected' && isVimNotAttachedOutput(node.output)) return true;
  }
  return false;
}

function historicalOutput<Node extends AiConversationNode>(node: Node): Node {
  if (node.kind === 'compaction' && node.state === 'running') {
    return { ...node, state: 'cancelled', durationMs: null };
  }
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

export interface AiWorkspaceRootProps {
  readonly headerActions?: React.ReactNode;
  readonly headerBadge?: React.ReactNode;
  readonly mode?: 'ask' | 'agent';
  readonly imageControls?: React.ReactNode;
  readonly onPasteImages?: (files: File[]) => void | Promise<void>;
  readonly hasImages?: boolean;
  readonly imageBusy?: boolean;
  readonly imageSubmissionId?: string;
  readonly imageLocked?: boolean;
  readonly submissionContext?: object;
  readonly view: AiSessionView | null;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly requestOutputTokens?: number;
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
  readonly sandboxToggleControl?: React.ReactNode;
  readonly executionSurfaceNotice?: React.ReactNode;
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
  readonly onListProjectDirectories?: import('@/types/agent-file-reference').ListProjectDirectories;
  readonly onListSkills?: (root?: string) => Promise<import('@/types/agent-skill').SkillUserList>;
  readonly skillsScopeKey?: string;
  readonly skillsNeedsRoot?: boolean;
  readonly projectTargetLabel?: string;
  readonly onAnswerQuestion?: (input: import('@/types/agent-question').AnswerQuestionInput) => Promise<void>;
  readonly onRefreshQuestionAnswer?: (input: import('@/types/agent-question').AnswerQuestionInput) => Promise<void>;
  readonly onResolveSkillProposal?: (input: import('@/types/agent-skill').ResolveSkillProposalInput) => Promise<void>;
  readonly onInspectSkillTarget?: (input: import('@/types/agent-skill').InspectSkillTargetInput) => Promise<import('@/types/agent-skill').SkillTargetInspection>;
  readonly loadingOlder?: boolean;
  readonly queueMutation?: AiQueueMutationState | null;
  readonly onRetryQueueMutation?: import('./use-ai-session-controller').AiSessionController['retryQueueMutation'];
  readonly renamingSessionId?: string | null;
  readonly renameError?: string | null;
  readonly canStartAgent?: boolean;
  readonly submissionDisabled?: boolean;
  readonly agentUnavailableReason?: string | null;
  readonly terminalConflict?: boolean;
  readonly historyScopeLabel?: string | null;
  readonly terminalConnected?: boolean;
  readonly terminalReconnecting?: boolean;
  readonly readOnlySession?: boolean;
  readonly historicalTargetUnavailable?: boolean;
  readonly onDraftChange?: (value: string) => void;
  readonly onSubmit?: (input: AiWorkspaceSubmitInput) => void | Promise<void>;
  readonly onSubmitGesture?: (gesture: 'keyboard' | 'primary', accelerated: boolean) => void;
  readonly onStop?: () => void;
  readonly onContinueOnReconnectedTerminal?: () => void;
  readonly terminalReconnectBusy?: boolean;
  readonly onReconnectTerminal?: () => void;
  readonly historicalContinuationAvailable?: boolean;
  readonly historicalContinuationBusy?: boolean;
  readonly historicalContinuationError?: string | null;
  readonly onBusyPreferenceChange?: (value: 'queue' | 'steer') => void;
  readonly onDismissError?: () => void;
  readonly onRetryFailedDraft?: (id: string) => void;
  readonly failedDraftRetryBlockedReason?: string | null;
  readonly onRetrySync?: () => Promise<void>;
  readonly onOpenModel?: () => void;
  readonly onRetryModel?: (turnId: string) => void;
  readonly retryingModel?: boolean;
  readonly onNewSession?: () => void;
  readonly onHistory?: () => void;
  readonly onRefreshSessions?: () => void;
  readonly onReadSession?: (summary: AiSessionSummary, signal: AbortSignal) => Promise<File>;
  readonly onClose?: () => void;
  readonly onOpenSession?: (summary: AiSessionSummary) => void;
  readonly onArchiveSession?: (summary: AiSessionSummary) => void;
  readonly onDeleteSession?: (summary: AiSessionSummary) => void;
  readonly onEditQueueItem?: import('./use-ai-session-controller').AiSessionController['editQueueItem'];
  readonly onUpdateQueueItem?: import('./use-ai-session-controller').AiSessionController['updateQueueItem'];
  readonly onDiscardQueueEdit?: (itemId: string) => void;
  readonly onRemoveQueueItem?: (item: AiInboxItem) => void;
  readonly onSteerQueueItem?: (item: AiInboxItem) => void;
  readonly onResumeQueueItem?: (item: AiInboxItem) => void;
  readonly onReorderQueueLane?: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly onRenameSession?: (summary: AiSessionSummary, title: string) => void;
  readonly onBack?: () => void;
  readonly onOpenStoredOutput?: (node: import('@/lib/ai/conversation-node').AiConversationNodeOf<'tool'>, artifactId: string) => void;
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
  headerActions,
  headerBadge,
  imageControls, onPasteImages, hasImages, imageBusy, imageSubmissionId, imageLocked,
  submissionContext,
  view,
  contextWindow,
  maxOutputTokens,
  requestOutputTokens,
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
  sandboxToggleControl,
  executionSurfaceNotice,
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
  onRefreshQuestionAnswer,
  onResolveSkillProposal,
  onInspectSkillTarget,
  onListFileReferences,
  onListProjectDirectories,
  onListSkills,
  skillsScopeKey,
  skillsNeedsRoot,
  projectTargetLabel,
  loadingOlder = false,
  queueMutation = null,
  onRetryQueueMutation,
  renamingSessionId = null,
  renameError = null,
  canStartAgent = false,
  submissionDisabled = false,
  agentUnavailableReason: rawAgentUnavailableReason = null,
  terminalConflict = false,
  historyScopeLabel = null,
  terminalConnected = canStartAgent,
  terminalReconnecting = false,
  readOnlySession = false,
  historicalTargetUnavailable = false,
  onDraftChange,
  onSubmit,
  onSubmitGesture,
  onStop,
  onContinueOnReconnectedTerminal,
  terminalReconnectBusy = false,
  onReconnectTerminal,
  historicalContinuationAvailable = false,
  historicalContinuationBusy = false,
  historicalContinuationError = null,
  onBusyPreferenceChange,
  onDismissError,
  onRetryFailedDraft,
  failedDraftRetryBlockedReason,
  onRetrySync,
  onOpenModel,
  onRetryModel,
  retryingModel = false,
  onNewSession,
  onHistory,
  onRefreshSessions,
  onReadSession,
  onClose,
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onEditQueueItem,
  onUpdateQueueItem,
  onDiscardQueueEdit,
  onRemoveQueueItem,
  onSteerQueueItem,
  onResumeQueueItem,
  onReorderQueueLane,
  onRenameSession,
  onBack,
  onOpenStoredOutput,
  onOpenArtifact,
  onScrollAnchorChange,
  onRouteReturnComplete,
  onApprove,
  onReject,
  onLoadOlder,
  loadArtifact,
}: AiWorkspaceRootProps): React.ReactNode {
  const { t } = useI18n();
  const profileName = useAppStore((state) => state.profileName);
  const agentUnavailableReason = rawAgentUnavailableReason === null
    ? null : aiErrorMessage(rawAgentUnavailableReason, t);
  const rootRef = useRef<HTMLElement>(null);
  const route = navigation.route;
  const sessionKind = view?.summary.kind ?? 'agent';
  const status = view?.status ?? composerState?.runtimeStatus ?? 'idle';
  const visibleNodes = view?.nodes ?? pendingNodes;
  const selectedSessionId = view?.summary.id ?? composerState?.sessionId
    ?? (route.kind === 'conversation' ? route.sessionId : null);
  useEffect(() => {
    if (!selectedSessionId) return;
    return () => toolLiveOutputStore.clearSession(selectedSessionId);
  }, [selectedSessionId]);
  const sessionLoading = !view && (restoringSession || selectedSessionId !== null) && visibleNodes.length === 0;
  const taskSteps = view?.snapshot.kind === 'agent'
    ? view.snapshot.value.task.plan?.steps ?? []
    : [];
  const resolvedTitle = title ?? view?.summary.title
    ?? sessions.find((summary) => summary.id === selectedSessionId)?.title
    ?? t(scope === 'workbench' ? 'ai.workbench.conversationTitle' : 'ai.newConversation');
  const heroTitle = scope === 'terminal'
    ? profileName
      ? t('agent.emptyTitleWithName', { name: profileName })
      : t('agent.emptyTitle')
    : profileName
      ? t('ai.workbench.emptyTitleWithName', { name: profileName })
      : t('ai.workbench.emptyTitle');
  const heroDescription = scope === 'terminal'
    ? t('agent.emptyDescription')
    : t('ai.workbench.empty');
  const surfaceMode = mode ?? 'agent';
  const subagent = view?.snapshot.value.header.subagent ?? view?.summary.subagent;
  const subagentReadOnly = Boolean(subagent && (readOnlySession || view?.snapshot.value.ended
    || view?.snapshot.value.archived || view?.summary.archived
    || ['completed', 'cancelled', 'failed'].includes(status)));
  const subagentInputMode = !subagent ? 'default'
    : subagent.continuable && !subagentReadOnly ? 'supplement' : 'hidden';
  const canResolveApproval = surfaceMode === 'agent' && view && !historicalTargetUnavailable
    && !view.snapshot.value.ended && !view.snapshot.value.archived && !view.summary.archived
    && (!readOnlySession || subagent?.continuable === false);
  const terminalRecovery = surfaceMode === 'agent' && !readOnlySession && !historicalTargetUnavailable
    ? terminalExecutionRecovery(view) : null;
  const sessionTarget = view?.snapshot.value.header.target;
  const boundRemoteTerminalSessionId = !readOnlySession
    && !historicalTargetUnavailable
    && !subagent
    && surfaceMode === 'agent'
    && sessionTarget?.kind === 'remote'
    ? sessionTarget.sessionId
    : null;
  const vimBridgeState = useTerminalVimBridgeState(boundRemoteTerminalSessionId);
  const [vimCommandCopied, setVimCommandCopied] = useState(false);
  const vimCopyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (vimCopyTimerRef.current !== null) window.clearTimeout(vimCopyTimerRef.current);
  }, []);
  const terminalInsertTarget = useTerminalInsertTarget(
    !readOnlySession && !historicalTargetUnavailable ? sessionTarget?.sessionId : null,
  );
  const terminalInsertContext = useMemo(
    () => (terminalInsertTarget ? {
      targetName: terminalInsertTarget.targetName,
      insert: (code: string) => {
        const inserted = insertCommandIntoTerminal(terminalInsertTarget.sessionId, code);
        if (!inserted) toast.error(t('ai.workspace.question.actionInsertCommandFailed'));
        return inserted;
      },
    } : undefined),
    [terminalInsertTarget, t],
  );
  const historicalTargetLabel = sessionTarget?.kind === 'local'
    ? t('ai.workspace.localTarget')
    : sessionTarget && (terminalLoginLabel(sessionTarget) ?? sessionTarget.label ?? sessionTarget.host);
  const terminalContext = readOnlySession || historicalTargetUnavailable
    ? t('ai.terminal.readOnlyContext', { target: historicalTargetLabel || t('section.terminal') })
    : historyScopeLabel || terminalConnected || terminalReconnecting
      ? t(
        terminalConnected
          ? 'ai.terminal.connectedContext'
          : terminalReconnecting
            ? 'ai.terminal.reconnectingContext'
            : 'ai.terminal.disconnectedContext',
        { target: historyScopeLabel ?? t('section.terminal') },
      )
      : t('ai.terminal.noTerminalContext');
  const headerContext = !mode
    ? t(scope === 'terminal' ? 'section.terminal' : 'section.workbench')
    : surfaceMode === 'agent' ? terminalContext : t('ai.workbench.scopeDescription');
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
    const transcriptNodes = visibleNodes.filter(node => node.kind !== 'runtimeArtifacts');
    const nodes: readonly AiConversationNode[] = historicalTargetUnavailable
      ? transcriptNodes.map(historicalOutput) : transcriptNodes;
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
  const [conversationIdentity, setConversationIdentity] = useState({
    context: submissionContext, sessionId: selectedSessionId, generation: 0,
  });
  if (conversationIdentity.context !== submissionContext
    || conversationIdentity.sessionId !== selectedSessionId) {
    // The controller keeps this context through creation and replaces it on
    // navigation. Adopting the new session must not restart the scroller.
    const adoptingSession = submissionContext !== undefined
      && conversationIdentity.context === submissionContext
      && conversationIdentity.sessionId === null && selectedSessionId !== null;
    setConversationIdentity({
      context: submissionContext, sessionId: selectedSessionId,
      generation: conversationIdentity.generation + (adoptingSession ? 0 : 1),
    });
  }
  const scrollAnchor = sessionLedgerKey
    ? navigation.scrollAnchorBySession[sessionLedgerKey]
    : undefined;
  const artifactDetailsNode = route.kind === 'artifactDetails'
    ? conversationArtifacts(view?.nodes ?? []).find((node) => node.artifactId === route.artifactId)
    : undefined;
  const toolCorrelation = useMemo(
    () => correlateSubagentToolSessions(
      view?.nodes ?? [],
      view?.activityNodes ?? [],
      view?.subagents ?? [],
      sessions,
    ),
    [sessions, view?.activityNodes, view?.nodes, view?.subagents],
  );
  const lineageView = useMemo(
    () => (view ? { summary: view.summary, status: view.status, subagents: view.subagents } : null),
    [view?.status, view?.subagents, view?.summary],
  );
  const lineage = useMemo(
    () => buildSubagentLineage(lineageView, sessions, toolCorrelation.goalByChildId),
    [lineageView, sessions, toolCorrelation.goalByChildId],
  );
  const activeSubagentEntries = useMemo(
    () => (lineage ? filterActiveSubagentEntries(lineage.currentChildren) : []),
    [lineage],
  );
  const [expandedDockStrips, setExpandedDockStrips] = useState<Readonly<Record<string, 'tasks' | 'subagents'>>>({});
  const dockStripScopeId = lineage?.current.id ?? selectedSessionId ?? '__default__';
  const expandedDockStrip = expandedDockStrips[dockStripScopeId] ?? null;
  const setDockStripOpen = (strip: 'tasks' | 'subagents', open: boolean): void => {
    setExpandedDockStrips((current) => {
      if (open) {
        if (current[dockStripScopeId] === strip) return current;
        return { ...current, [dockStripScopeId]: strip };
      }
      if (current[dockStripScopeId] !== strip) return current;
      const next = { ...current };
      delete next[dockStripScopeId];
      return next;
    });
  };
  const activeBlockingApproval = canResolveApproval ? view.pendingApproval : undefined;
  const activeBlockingQuestion = readOnlySession ? undefined : view?.pendingQuestion;
  const blockingPromptKey = activeBlockingApproval
    ? `approval:${activeBlockingApproval.approvalId}`
    : activeBlockingQuestion
      ? `question:${activeBlockingQuestion.identity.questionRequestId}`
      : null;
  const lastBlockingPromptByScopeRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    const previous = lastBlockingPromptByScopeRef.current.get(dockStripScopeId) ?? null;
    if (blockingPromptKey !== null && previous !== blockingPromptKey) {
      setExpandedDockStrips((current) => {
        if (!(dockStripScopeId in current)) return current;
        const next = { ...current };
        delete next[dockStripScopeId];
        return next;
      });
    }
    lastBlockingPromptByScopeRef.current.set(dockStripScopeId, blockingPromptKey);
  }, [blockingPromptKey, dockStripScopeId]);
  const currentSubagentBudgetExhausted = childBudgetExhausted(view?.snapshot.value);
  const subagentContextValue = useMemo(
    () => ({
      lineage,
      toolChildSessionIds: toolCorrelation.toolChildSessionIds,
      onOpenSession,
    }),
    [lineage, onOpenSession, toolCorrelation.toolChildSessionIds],
  );
  const subagentNav: AiSessionHeaderSubagentNav | undefined = useMemo(() => {
    if (!subagent || !lineage || !onOpenSession) return undefined;
    const parent = lineage.parent;
    const roleLabel = subagentRoleLabel(subagent.role, t);
    const modeStatus = `${subagentModeLabel(subagent.continuable, currentSubagentBudgetExhausted, t)} · ${subagentStatusLabel(status, t)}`;
    const ancestors = lineage.trail.slice(0, -1).map((item) => item.title).join(' / ');
    return {
      roleLabel,
      subtitle: ancestors ? `${ancestors} · ${modeStatus}` : modeStatus,
      subtitleTooltip: [...lineage.trail.map((item) => item.title), modeStatus].join(' · '),
      ...(parent ? {
        backLabel: t(
          parent.id === lineage.root.id
            ? 'ai.workspace.subagents.backToMain'
            : 'ai.workspace.subagents.backToParent',
          { title: parent.title },
        ),
        onBack: () => onOpenSession(parent),
      } : {}),
      switcher: (
        <AiSubagentCatalog
          root={lineage.root}
          current={lineage.current}
          entries={lineage.entries}
          currentBudgetExhausted={currentSubagentBudgetExhausted}
          onOpen={onOpenSession}
          onRefresh={onRefreshSessions}
        />
      ),
      hideSessionChrome: Boolean(parent),
    };
  }, [currentSubagentBudgetExhausted, lineage, onOpenSession, onRefreshSessions, status, subagent, t]);

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

  // Update the icon inset and text padding in the same render as the action.
  const verifyingConnection = !terminalConflict && !onReconnectTerminal && Boolean(onContinueOnReconnectedTerminal);
  const verificationReady = t('ai.workspace.reconnectAvailable');
  const verificationPending = t('ai.workspace.reconnectChecking');
  const availabilityDescription = agentUnavailableReason ?? (onContinueOnReconnectedTerminal
    ? (terminalReconnectBusy ? verificationPending : verificationReady)
    : t('ai.workspace.sessions.previousTerminalReadOnly'));
  const availabilityAction = terminalConflict ? null
    : onReconnectTerminal ? <AiNoticeAction onClick={onReconnectTerminal}>{t('ai.workspace.status.reconnect')}</AiNoticeAction>
      : onContinueOnReconnectedTerminal ? <AiNoticeAction
        disabled={terminalReconnectBusy}
        aria-busy={terminalReconnectBusy || undefined}
        onClick={onContinueOnReconnectedTerminal}>
        <StableContent className="justify-items-end" active={terminalReconnectBusy ? 1 : 0}
          variants={[t('ai.workspace.continueOnReconnectedTerminal'), verificationPending]} />
      </AiNoticeAction>
        : !readOnlySession && canStartAgent && onOpenModel
          ? <AiNoticeAction onClick={onOpenModel}>{t('ai.workspace.status.openSettings')}</AiNoticeAction> : null;
  const availabilityCopyClass = cn('min-w-0 flex-1 basis-48', availabilityAction && 'py-1');

  const canContinueGeneration = Boolean(
    onSubmit
    && !submissionDisabled
    && !readOnlySession
    && !historicalTargetUnavailable
    && status !== 'running'
    && status !== 'waiting',
  );
  const latestInterruptedAssistantKey = useMemo(() => {
    if (!canContinueGeneration) return null;
    for (let index = conversationNodes.length - 1; index >= 0; index -= 1) {
      const node = conversationNodes[index];
      if (node.kind === 'userMessage') return null;
      if (node.kind === 'assistantMessage') {
        return node.state === 'cancelled' || node.state === 'interrupted' || node.partialReason === 'outputLimit'
          ? node.key
          : null;
      }
      if (node.kind === 'turnProcess') {
        for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
          const child = node.children[childIndex];
          if (child.kind === 'assistantMessage') {
            return child.state === 'cancelled' || child.state === 'interrupted' || child.partialReason === 'outputLimit'
              ? child.key
              : null;
          }
        }
      }
    }
    return null;
  }, [canContinueGeneration, conversationNodes]);
  const continueGenerationContext = useMemo(
    () => (latestInterruptedAssistantKey ? {
      latestAssistantKey: latestInterruptedAssistantKey,
      busy: activeComposerState?.phase === 'submitting' || activeComposerState?.phase === 'stopping',
      onContinue: () => { void onSubmit?.({ content: t('ai.workspace.continuePrompt') }); },
    } : undefined),
    [activeComposerState?.phase, latestInterruptedAssistantKey, onSubmit, t],
  );
  const canExportMarkdown = useMemo(
    () => !hero && hasExportableConversationMessages(conversationNodes),
    [conversationNodes, hero],
  );
  const handleExportMarkdown = (): void => {
    const markdown = formatConversationMarkdown({
      title: resolvedTitle,
      nodes: conversationNodes,
      userLabel: t('ai.message.user'),
      assistantLabel: t('ai.message.assistant'),
    });
    if (!markdown) return;
    const fileName = exportConversationFileName(resolvedTitle);
    if (isTauriRuntime()) {
      void invokeExportLogFile(fileName, markdown).then((savedPath) => {
        if (!savedPath) return;
        const revealLabel = t(getPlatform() === 'macos' ? 'ai.path.revealFinder' : 'ai.path.revealExplorer');
        toast.success(t('ai.workspace.export.success'), {
          action: {
            label: revealLabel,
            onClick: () => { void invokeRevealPath(savedPath); },
          },
        });
      }).catch(() => {
        toast.error(t('ai.workspace.export.failed'));
      });
      return;
    }
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(t('ai.workspace.export.success'));
    } catch {
      toast.error(t('ai.workspace.export.failed'));
    }
  };

  const showVimBridgeAttachNotice = useMemo(
    () => Boolean(
      boundRemoteTerminalSessionId
      && !vimBridgeState.vimAttached
      && !activeBlockingApproval
      && !activeBlockingQuestion
      && status !== 'running'
      && status !== 'waiting'
      && latestTurnNeedsVimBridgeActivation(conversationNodes),
    ),
    [
      activeBlockingApproval,
      activeBlockingQuestion,
      boundRemoteTerminalSessionId,
      conversationNodes,
      status,
      vimBridgeState.vimAttached,
    ],
  );
  const handleActivateVimBridge = (): void => {
    if (!boundRemoteTerminalSessionId) return;
    void activateVimBridgeInTerminal(boundRemoteTerminalSessionId).then((sent) => {
      if (!sent) toast.error(t('ai.workspace.vimBridge.attachFailed'));
    }).catch(() => {
      toast.error(t('ai.workspace.vimBridge.attachFailed'));
    });
  };
  const handleCopyVimBridgeCommand = (): void => {
    void navigator.clipboard.writeText(VIM_BRIDGE_ACTIVATION_COMMAND).then(() => {
      setVimCommandCopied(true);
      if (vimCopyTimerRef.current !== null) window.clearTimeout(vimCopyTimerRef.current);
      vimCopyTimerRef.current = window.setTimeout(() => {
        vimCopyTimerRef.current = null;
        setVimCommandCopied(false);
      }, 1500);
    }).catch(() => {
      toast.error(t('ai.workspace.question.actionCopyFailed'));
    });
  };
  const editorAttachedBadge = vimBridgeState.vimAttached ? (
    <Badge
      variant="outline"
      size="sm"
      className="shrink-0 gap-1"
      data-slot="ai-editor-attached-badge"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-app-success" aria-hidden="true" />
      {t(
        vimBridgeState.vimEditor === 'neovim'
          ? 'ai.workspace.vimBridge.attachedNeovim'
          : 'ai.workspace.vimBridge.attachedVim',
      )}
    </Badge>
  ) : undefined;

  return (
    <section
      ref={rootRef}
      data-slot="ai-workspace-root"
      data-phase={hero ? 'hero' : 'active'}
      data-session-kind={sessionKind}
      data-session-id={view?.summary.id}
      data-ai-mode={surfaceMode}
      className="ai-workspace-root @container/ai-workspace flex size-full min-h-0 min-w-0 flex-col overflow-x-hidden"
      aria-label={t('ai.workspace')}
    >
      {route.kind === 'artifactDetails' ? (
        <AiArtifactDetails
          sessionId={route.sessionId}
          node={artifactDetailsNode?.kind === 'artifact' ? artifactDetailsNode : null}
          artifactId={route.sourceToolKey ? route.artifactId : undefined}
          title={route.sourceToolKey ? t('ai.workspace.details.output') : undefined}
          load={loadArtifact ?? (() => Promise.reject(new Error(t('ai.workspace.details.artifactUnavailable'))))}
          onBack={() => onBack?.()}
          onClose={onClose}
        />
      ) : null}
      <Activity mode={route.kind === 'artifactDetails' ? 'hidden' : 'visible'}>
      <AiSessionHeader
        extraActions={headerActions}
        editorBadge={editorAttachedBadge}
        sandboxBadge={headerBadge}
        title={resolvedTitle}
        context={headerContext}
        status={status}
        mode={surfaceMode}
        subagentNav={subagentNav}
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
        onExportMarkdown={canExportMarkdown ? handleExportMarkdown : undefined}
      />

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
            <AiFailureRecoveryContext.Provider value={{
              recovery: view && (!readOnlySession || Boolean(subagent)) && !historicalTargetUnavailable
                ? latestFailureRecovery(view) : null,
              busy: retryingModel || activeComposerState?.phase === 'submitting' || activeComposerState?.phase === 'stopping',
              onRetry: onRetryModel,
              onSettings: onOpenModel,
            }}>
            <AiFailedDraftRecoveryContext.Provider value={{
              composerState, syncRecovery: view?.syncRecovery,
              onRetrySync, onRetryFailedDraft: readOnlySession ? undefined : onRetryFailedDraft,
              failedDraftRetryBlockedReason,
            }}>
            <AiMarkdownTargetContext.Provider value={sessionTarget}>
            <AiTerminalInsertContext.Provider value={terminalInsertContext}>
            <AiContinueGenerationContext.Provider value={continueGenerationContext}>
            <AiSubagentContext.Provider value={subagentContextValue}>
            <AiConversation
              key={conversationIdentity.generation}
              nodes={conversationNodes}
              renderers={surfaceMode === 'ask' ? aiAskConversationNodeRenderers : undefined}
              runningIndicator={historicalTargetUnavailable
                || (status === 'waiting' && Boolean(activeBlockingQuestion && pendingUserAction(activeBlockingQuestion)))
                ? 'none' : surfaceMode}
              pending={surfaceMode === 'ask' && (activeComposerState?.phase === 'submitting'
                || Boolean(pendingSubmissions?.some(submission => submission.startsTurn)))}
              submittedOperationId={submittedOperationId}
              imageSubmissionId={imageSubmissionId}
              status={status}
              statusReason={view?.statusReason ?? (view?.pendingQuestion ? 'waitingForUserQuestion'
                : view?.pendingSkillProposal ? 'waitingForSkillProposal'
                : view?.pendingApproval ? 'toolApprovalPending' : undefined)}
              throughSeq={view?.throughSeq ?? null}
              initialAnchor={scrollAnchor}
              onAnchorChange={onScrollAnchorChange}
              onOpenStoredOutput={onOpenStoredOutput}
              onOpenArtifact={onOpenArtifact}
              canLoadOlder={view?.canLoadOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={onLoadOlder}
            />
            </AiSubagentContext.Provider>
            </AiContinueGenerationContext.Provider>
            </AiTerminalInsertContext.Provider>
            </AiMarkdownTargetContext.Provider>
            </AiFailedDraftRecoveryContext.Provider>
            </AiFailureRecoveryContext.Provider>
          )}
        </div>

        <AiComposerSeat
          inputMode={subagentInputMode}
          statusNotices={(
            <>
              <AiWorkspaceErrorNotices
                key={subagent ? selectedSessionId : undefined}
                composerState={composerState}
                syncError={view?.syncError}
                syncRecovery={view?.syncRecovery}
                storageFaultAtSeq={view?.storageFaultAtSeq}
                onRetrySync={onRetrySync}
                onDismissError={onDismissError}
              />

              <div
                data-slot="ai-workspace-status-notices"
                className="flex w-full min-w-0 shrink-0 flex-col gap-1.5 empty:hidden"
              >
                {terminalRecovery && <AiTerminalRecoveryNotice id={availabilityHintId} recovery={terminalRecovery}
                  stopping={activeComposerState?.phase === 'stopping'} reconnecting={terminalReconnecting}
                  onStop={onStop} onReconnect={onReconnectTerminal} />}
                {historicalContinuationError && (
                  <Alert variant="destructiveSubtle" size="sm" className="items-center">
                    <CircleAlertIcon aria-hidden="true" />
                    <AlertDescription>{aiErrorMessage(historicalContinuationError, t)}</AlertDescription>
                  </Alert>
                )}
                {showVimBridgeAttachNotice && (
                  <Alert
                    variant="info"
                    size="sm"
                    role="status"
                    data-vim-bridge-attach-notice=""
                    className="[--alert-icon-inset:--spacing(1)]"
                  >
                    <InfoIcon aria-hidden="true" />
                    <AlertDescription className="flex min-w-0 flex-wrap items-center gap-1.5 break-words">
                      <span className="min-w-0 flex-1 basis-48 py-1">{t('ai.workspace.vimBridge.attachHint')}</span>
                      <span className="flex shrink-0 items-center gap-2.5">
                        <AiNoticeAction disabled={!terminalInsertTarget} onClick={handleActivateVimBridge}>
                          {t('ai.workspace.vimBridge.attachAction')}
                        </AiNoticeAction>
                        <AiNoticeAction className="text-muted-foreground hover:text-foreground" onClick={handleCopyVimBridgeCommand}>
                          {t(vimCommandCopied ? 'common.copied' : 'ai.workspace.vimBridge.copyAction')}
                        </AiNoticeAction>
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
                <AiNoticeTransition key={subagent ? selectedSessionId : undefined}>
                  {!subagent && !terminalRecovery && (agentUnavailableReason || onContinueOnReconnectedTerminal) ? (
                    <Alert id={availabilityHintId} variant={terminalConflict ? 'warning' : 'info'} size="sm" role="status" aria-label={t('agent.availability.title')}
                      className={availabilityAction ? '[--alert-icon-inset:--spacing(1)]' : undefined}>
                      {terminalConflict ? <TriangleAlertIcon aria-hidden="true" /> : <InfoIcon aria-hidden="true" />}
                      <AlertDescription className="flex min-w-0 flex-wrap items-start gap-1 break-words">
                        {verifyingConnection ? (
                          <StableContent className={availabilityCopyClass} active={0} variants={[
                            availabilityDescription, terminalReconnectBusy ? verificationReady : verificationPending,
                          ]} />
                        ) : <span className={availabilityCopyClass}>{availabilityDescription}</span>}
                        {availabilityAction}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </AiNoticeTransition>
              </div>

            </>
          )}
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
          contextWindow={contextWindow}
          maxOutputTokens={maxOutputTokens}
          requestOutputTokens={requestOutputTokens}
          contextUsage={surfaceMode === 'agent' && !readOnlySession
            ? contextUsageForModel(view?.contextUsage, contextWindow) : undefined}
          permissionControl={surfaceMode === 'agent' ? permissionControl : undefined}
          executionSurfaceControl={surfaceMode === 'agent' ? executionSurfaceControl : undefined}
          sandboxToggleControl={surfaceMode === 'agent' ? sandboxToggleControl : undefined}
          executionSurfaceNotice={surfaceMode === 'agent' && !subagent ? executionSurfaceNotice : undefined}
          composerState={activeComposerState}
          submissionDisabled={submissionDisabled}
          inbox={surfaceMode === 'agent' && !readOnlySession ? view?.inbox : undefined}
          taskSteps={surfaceMode === 'agent' && (!readOnlySession || subagent) ? taskSteps : undefined}
          taskPlanActive={terminalRecovery ? false : view?.taskPlanActive}
          taskStripOpen={expandedDockStrip === 'tasks'}
          onTaskStripOpenChange={(open) => setDockStripOpen('tasks', open)}
          subagentStrip={surfaceMode === 'agent' && onOpenSession && lineage && activeSubagentEntries.length > 0
            ? (
                <AiSubagentStrip
                  key={`subagent:${lineage.current.id}`}
                  entries={activeSubagentEntries}
                  currentSessionId={lineage.current.id}
                  currentBudgetExhausted={currentSubagentBudgetExhausted}
                  open={expandedDockStrip === 'subagents'}
                  onOpenChange={(open) => setDockStripOpen('subagents', open)}
                  onOpen={onOpenSession}
                  onRefresh={onRefreshSessions}
                />
              )
            : undefined}
          queueMutation={surfaceMode === 'agent' && !readOnlySession ? queueMutation : undefined}
          onRetryQueueMutation={surfaceMode === 'agent' && !readOnlySession ? onRetryQueueMutation : undefined}
          queueMutable={Boolean(view && !terminalRecovery && !readOnlySession && !view.summary.archived && (!view.snapshot.value.ended || view.status === 'failed'))}
          announcement={announcement}
          pendingApproval={canResolveApproval ? view.pendingApproval : undefined}
          pendingQuestion={readOnlySession ? undefined : view?.pendingQuestion}
          onAnswerQuestion={readOnlySession ? undefined : onAnswerQuestion}
          onRefreshQuestionAnswer={onRefreshQuestionAnswer}
          pendingSkillProposal={readOnlySession ? undefined : view?.pendingSkillProposal}
          onResolveSkillProposal={readOnlySession ? undefined : onResolveSkillProposal}
          onInspectSkillTarget={readOnlySession ? undefined : onInspectSkillTarget}
          onListFileReferences={surfaceMode === 'agent' && !readOnlySession ? onListFileReferences : undefined}
          onListProjectDirectories={surfaceMode === 'agent' && !readOnlySession ? onListProjectDirectories : undefined}
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
          unavailableReason={terminalRecovery ? t('ai.workspace.terminalRecovery.title')
            : subagent && terminalConflict ? null : agentUnavailableReason}
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
          onEditQueueItem={surfaceMode === 'agent' && !readOnlySession ? onEditQueueItem : undefined}
          onUpdateQueueItem={surfaceMode === 'agent' && !readOnlySession ? onUpdateQueueItem : undefined}
          onDiscardQueueEdit={onDiscardQueueEdit}
          onRemoveQueueItem={surfaceMode === 'agent' && !readOnlySession ? onRemoveQueueItem : undefined}
          onSteerQueueItem={surfaceMode === 'agent' && !readOnlySession ? onSteerQueueItem : undefined}
          onResumeQueueItem={surfaceMode === 'agent' && !readOnlySession ? onResumeQueueItem : undefined}
          onReorderQueueLane={surfaceMode === 'agent' && !readOnlySession ? onReorderQueueLane : undefined}
          onOpenModel={onOpenModel}
          onApprove={canResolveApproval ? onApprove : undefined}
          onReject={canResolveApproval ? onReject : undefined}
        />
      </div>
      </Activity>
    </section>
  );
}
