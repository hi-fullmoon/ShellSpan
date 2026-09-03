import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { conversationFromTerminal } from '@/lib/ai-sessions';
import { createAgentSessionAdapter } from '@/lib/ai/agent-session-adapter';
import { createAskSessionAdapter } from '@/lib/ai/ask-session-adapter';
import {
  createAiComposerState,
  reduceAiComposer,
  type AiComposerEffect,
  type AiComposerEvent,
  type AiComposerState,
} from '@/lib/ai/composer-machine';
import {
  reconcileOptimisticSubmissions,
  withOptimisticConversationNodes,
  type AiOptimisticSubmission,
} from '@/lib/ai/optimistic-submission';
import { normalizeAiSessionError } from '@/lib/ai/session-error';
import type { AiSessionKind } from '@/lib/ai/conversation-node';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import {
  createAiWorkspaceNavigationState,
  sessionRouteKey,
  type AiScrollAnchor,
  type AiWorkspaceNavigationState,
  type AiWorkspaceTab,
} from '@/lib/ai/panel-route';
import type {
  AiCreateSessionInput,
  AiInboxMutationInput,
  AiInboxItem,
  AiSessionAdapter,
  AiSessionSummary,
  AiSessionView,
  AiSubmitInput,
} from '@/lib/ai/session-adapter';
import { generateId } from '@/lib/utils';
import { t } from '@/locales';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiStore } from '@/stores/aiStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AppSection } from '@/types';
import type { AiConversation } from '@/types/ai';
import type {
  AgentSessionPermissionMode,
  AgentSessionTarget,
} from '@/types/agent-session';

const OPTIMISTIC_COMMIT_TIMEOUT_MS = 15_000;

export interface AiSessionControllerAdapters {
  readonly ask: AiSessionAdapter<'ask'>;
  readonly agent: AiSessionAdapter<'agent'>;
}

export interface UseAiSessionControllerInput {
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly initialPreset?: AiSessionKind;
  readonly adapters?: AiSessionControllerAdapters;
  readonly now?: () => number;
  readonly operationId?: () => string;
}

export interface AiSessionController {
  readonly view: AiSessionView | null;
  readonly pendingNodes: readonly AiConversationNode[];
  readonly composer: AiComposerState;
  readonly preset: AiSessionKind;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly announcement: string | null;
  readonly navigation: AiWorkspaceNavigationState;
  readonly sessions: readonly AiSessionSummary[];
  readonly sessionsLoading: boolean;
  readonly sessionsError: string | null;
  readonly archivingSessionId: string | null;
  readonly approvalDecision: 'approve' | 'reject' | null;
  readonly approvalError: string | null;
  readonly loadingOlder: boolean;
  readonly queueMutation: AiQueueMutationState | null;
  readonly renamingSessionId: string | null;
  readonly renameError: string | null;
  readonly setDraft: (value: string) => void;
  readonly setPreset: (value: AiSessionKind) => void;
  readonly setBusyPreference: (value: 'queue' | 'steer') => void;
  readonly submit: (gesture: 'keyboard' | 'primary', accelerated?: boolean) => void;
  readonly stop: () => void;
  readonly retryFailedDraft: (failedDraftId: string) => void;
  readonly dismissError: () => void;
  readonly openSessions: () => void;
  readonly openSession: (summary: AiSessionSummary) => void;
  readonly newSession: () => void;
  readonly archiveSession: (summary: AiSessionSummary) => void;
  readonly updateQueueItem: (item: AiInboxItem, content: string) => void;
  readonly removeQueueItem: (item: AiInboxItem) => void;
  readonly reorderQueueLane: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly retryQueueMutation: () => void;
  readonly renameSession: (summary: AiSessionSummary, title: string) => void;
  readonly back: () => void;
  readonly openToolDetails: (node: AiConversationNodeOf<'tool'>) => void;
  readonly openArtifactDetails: (node: AiConversationNodeOf<'artifact'>) => void;
  readonly selectTab: (tab: AiWorkspaceTab) => void;
  readonly saveScrollAnchor: (anchor: AiScrollAnchor) => void;
  readonly completeRouteReturn: () => void;
  readonly approve: () => void;
  readonly reject: () => void;
  readonly loadOlder: () => void;
  readonly loadArtifact: AiSessionAdapter['loadArtifact'];
}

type AiQueueMutationIntent =
  | Readonly<{ type: 'update'; itemId: string; content: string }>
  | Readonly<{ type: 'remove'; itemId: string }>
  | Readonly<{ type: 'reorder'; lane: AiInboxItem['lane']; orderedItemIds: readonly string[] }>;

export interface AiQueueMutationState {
  readonly intent: AiQueueMutationIntent;
  readonly status: 'pending' | 'failed';
  readonly error: string | null;
  readonly conflict: boolean;
}

function runtimeTarget(session: TerminalSession): AgentSessionTarget {
  const local = session.host === 'local' && session.port === 0;
  return {
    kind: local ? 'local' : 'remote',
    targetId: `terminal-${session.sessionId}`,
    sessionId: session.sessionId,
    label: session.title,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    ...(local ? {} : { host: session.host, port: session.port, username: session.username }),
  };
}

function permissionMode(mode: string): AgentSessionPermissionMode {
  if (mode === 'autoApproveReadOnly') return 'scopedAutopilot';
  if (mode === 'fullAccess') return 'operator';
  return 'requestApproval';
}

function newWorkbenchConversation(now: number): AiConversation {
  const timestamp = new Date(now).toISOString();
  return {
    id: generateId(),
    startedAt: timestamp,
    updatedAt: timestamp,
    title: t('ai.newConversation'),
    archived: false,
    scope: 'workbench',
    host: '',
    port: 0,
    username: '',
  };
}

function ensureTerminalConversation(session: TerminalSession): AiConversation {
  let conversation = conversationFromTerminal(session);
  if (conversation) return conversation;
  useTerminalStore.getState().startNewConversation(session.sessionId);
  const updated = useTerminalStore.getState().sessions.find((item) => item.sessionId === session.sessionId);
  conversation = updated ? conversationFromTerminal(updated) : undefined;
  if (!conversation) throw new Error(t('ai.workspace.error.conversationIdentity'));
  return conversation;
}

function adaptersByKind(
  adapters: AiSessionControllerAdapters,
  kind: AiSessionKind,
): AiSessionAdapter<'ask'> | AiSessionAdapter<'agent'> {
  return kind === 'ask' ? adapters.ask : adapters.agent;
}

function sameOptimistic(
  left: readonly AiOptimisticSubmission[],
  right: readonly AiOptimisticSubmission[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Interpret Composer effects against Ask/Agent adapters while committed views stay adapter-owned. */
export function useAiSessionController({
  scope,
  initialPreset = 'ask',
  adapters: providedAdapters,
  now = Date.now,
  operationId = generateId,
}: UseAiSessionControllerInput): AiSessionController {
  const ownedAdapters = useMemo<AiSessionControllerAdapters | null>(() => (
    providedAdapters ? null : {
      ask: createAskSessionAdapter(),
      agent: createAgentSessionAdapter(),
    }
  ), [providedAdapters]);
  const adapters = providedAdapters ?? ownedAdapters!;
  const conversations = useAiStore((state) => state.conversations);
  const activeWorkbenchConversationId = useAiStore((state) => state.activeWorkbenchConversationId);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const activeTerminalId = useTerminalStore((state) => state.activeSessionId);
  const providers = useAiSettingsStore((state) => state.providers);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const agentEnabled = useAiSettingsStore((state) => state.agentEnabled);
  const provider = providers.find((item) => item.id === defaultProviderId) ?? providers[0];
  const activeTerminal = terminalSessions.find((item) => item.sessionId === activeTerminalId);
  const [preset, setPresetState] = useState<AiSessionKind>(initialPreset);
  const [view, setView] = useState<AiSessionView | null>(null);
  const [openedSession, setOpenedSession] = useState<{ kind: AiSessionKind; id: string } | null>(null);
  const [optimistic, setOptimistic] = useState<readonly AiOptimisticSubmission[]>([]);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [composer, setComposer] = useState(() => createAiComposerState({ preset: initialPreset }));
  const [navigation, setNavigation] = useState(() => createAiWorkspaceNavigationState());
  const [sessions, setSessions] = useState<readonly AiSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [approvalDecision, setApprovalDecision] = useState<'approve' | 'reject' | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [queueMutation, setQueueMutation] = useState<AiQueueMutationState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const composerRef = useRef(composer);
  const viewRef = useRef(view);
  const optimisticRef = useRef(optimistic);
  const mountedRef = useRef(true);
  const timeoutRef = useRef(new Map<string, number>());
  const effectExecutorRef = useRef<(effect: AiComposerEffect) => void>(() => undefined);
  const draftBySessionRef = useRef(new Map<string, string>());

  const workspaceScopeKey = `${preset}:${scope}:${activeTerminal?.sessionId ?? 'workspace'}`;
  const canCreateSession = preset === 'ask'
    || (scope === 'terminal' && activeTerminal?.status === 'connected' && agentEnabled);
  const hasProvider = Boolean(provider?.model.trim());

  const updateOptimistic = useCallback((updater: (
    current: readonly AiOptimisticSubmission[],
  ) => readonly AiOptimisticSubmission[]) => {
    setOptimistic((current) => {
      const next = updater(current);
      optimisticRef.current = next;
      return next;
    });
  }, []);

  const dispatch = useCallback((event: AiComposerEvent): void => {
    const transition = reduceAiComposer(composerRef.current, event);
    composerRef.current = transition.state;
    setComposer(transition.state);
    for (const effect of transition.effects) effectExecutorRef.current(effect);
  }, []);

  const navigationDraftKey = useCallback((kind: AiSessionKind, sessionId: string | null): string => (
    sessionId
      ? sessionRouteKey(kind, sessionId)
      : `new:${kind}:${scope}:${activeTerminal?.sessionId ?? 'workspace'}`
  ), [activeTerminal?.sessionId, scope]);

  const saveCurrentDraft = useCallback((): void => {
    draftBySessionRef.current.set(
      navigationDraftKey(composerRef.current.preset, composerRef.current.sessionId),
      composerRef.current.draft,
    );
  }, [navigationDraftKey]);

  const restoreDraft = useCallback((kind: AiSessionKind, sessionId: string | null): void => {
    dispatch({
      type: 'draft.changed',
      value: draftBySessionRef.current.get(navigationDraftKey(kind, sessionId)) ?? '',
    });
  }, [dispatch, navigationDraftKey]);

  const createInput = useCallback((
    kind: AiSessionKind,
    content: string,
  ): AiCreateSessionInput => {
    if (kind === 'ask') {
      const conversation = scope === 'terminal'
        ? ensureTerminalConversation(activeTerminal ?? (() => { throw new Error('No active terminal'); })())
        : newWorkbenchConversation(now());
      return { kind: 'ask', conversation };
    }
    if (!activeTerminal || activeTerminal.status !== 'connected') {
      throw new Error(t('ai.workspace.error.connectedTerminalRequired'));
    }
    const conversation = ensureTerminalConversation(activeTerminal);
    const sessionId = `agent-${conversation.id}-${operationId()}`;
    return {
      kind: 'agent',
      request: {
        sessionId,
        taskId: `task-${sessionId}`,
        goal: content,
        target: runtimeTarget(activeTerminal),
        permissionMode: permissionMode(
          useAgentPermissionStore.getState().getMode(activeTerminal.sessionId),
        ),
        successCriteria: [content],
      },
    };
  }, [activeTerminal, now, operationId, scope]);

  effectExecutorRef.current = (effect): void => {
    if (effect.type === 'focusEditor') return;
    if (effect.type === 'announce') {
      setAnnouncement(effect.reason);
      return;
    }
    if (effect.type === 'stop') {
      void adaptersByKind(adapters, composerRef.current.preset).stop(effect.sessionId).then(
        () => dispatch({ type: 'stop.succeeded' }),
        (error: unknown) => dispatch({ type: 'stop.failed', error: normalizeAiSessionError(error) }),
      );
      return;
    }

    const payload = effect.payload;
    const kind = composerRef.current.preset;
    const expectedNextSeq = viewRef.current?.throughSeq === null || viewRef.current?.throughSeq === undefined
      ? null
      : viewRef.current.throughSeq + 1;
    const submission: AiOptimisticSubmission = {
      ...payload,
      scopeKey: workspaceScopeKey,
      expectedNextSeq,
      delivery: 'pending',
    };
    updateOptimistic((current) => [
      ...current.filter((item) => (
        item.clientOperationId !== payload.clientOperationId
        && item.clientOperationId !== payload.retryOf
        && !(
          (item.delivery === 'failed' || item.delivery === 'timedOut')
          && item.scopeKey === workspaceScopeKey
          && item.content.trim() === payload.content.trim()
        )
      )),
      submission,
    ]);

    void (async () => {
      try {
        const currentProvider = useAiSettingsStore.getState().getProviderConfig();
        const base = {
          content: payload.content,
          mode: payload.mode,
          clientOperationId: payload.clientOperationId,
          provider: currentProvider,
        };
        const receipt = kind === 'ask'
          ? await adapters.ask.submit(payload.sessionId, {
              ...base,
              ...(payload.sessionId === null
                ? { create: createInput('ask', payload.content) as Extract<AiCreateSessionInput, { kind: 'ask' }> }
                : {}),
            } satisfies AiSubmitInput<'ask'>)
          : await adapters.agent.submit(payload.sessionId, {
              ...base,
              ...(payload.sessionId === null
                ? { create: createInput('agent', payload.content) as Extract<AiCreateSessionInput, { kind: 'agent' }> }
                : {}),
            } satisfies AiSubmitInput<'agent'>);
        if (!mountedRef.current) return;
        updateOptimistic((current) => current.map((item) => (
          item.clientOperationId === payload.clientOperationId
            ? { ...item, sessionId: receipt.sessionId, delivery: 'accepted' }
            : item
        )));
        setOpenedSession({ kind, id: receipt.sessionId });
        setNavigation((current) => ({
          ...current,
          route: { kind: 'conversation', sessionId: receipt.sessionId },
        }));
        dispatch({ type: 'submit.accepted', receipt });
        const timeout = window.setTimeout(() => {
          timeoutRef.current.delete(payload.clientOperationId);
          const pending = optimisticRef.current.find((item) => (
            item.clientOperationId === payload.clientOperationId
          ));
          if (!pending || pending.delivery !== 'accepted') return;
          const error = normalizeAiSessionError(new Error(t('ai.workspace.error.commitTimeout')));
          updateOptimistic((current) => current.map((item) => (
            item.clientOperationId === payload.clientOperationId
              ? { ...item, delivery: 'timedOut', error: error.message }
              : item
          )));
          dispatch({ type: 'submit.timedOut', clientOperationId: payload.clientOperationId, error });
        }, OPTIMISTIC_COMMIT_TIMEOUT_MS);
        timeoutRef.current.set(payload.clientOperationId, timeout);
      } catch (error) {
        if (!mountedRef.current) return;
        const normalized = normalizeAiSessionError(error);
        updateOptimistic((current) => current.map((item) => (
          item.clientOperationId === payload.clientOperationId
            ? { ...item, delivery: 'failed', error: normalized.message }
            : item
        )));
        dispatch({ type: 'submit.failed', clientOperationId: payload.clientOperationId, error: normalized });
      }
    })();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timeout of timeoutRef.current.values()) window.clearTimeout(timeout);
      timeoutRef.current.clear();
      ownedAdapters?.ask.dispose();
      ownedAdapters?.agent.dispose();
    };
  }, [ownedAdapters]);

  useEffect(() => {
    saveCurrentDraft();
    setOpenedSession(null);
    setView(null);
    setQueueMutation(null);
    viewRef.current = null;
    dispatch({
      type: 'runtime.synchronized',
      sessionId: null,
      preset,
      status: 'idle',
      terminal: false,
      waitingApproval: false,
    });
    setNavigation(createAiWorkspaceNavigationState());
  }, [activeTerminal?.sessionId, dispatch, saveCurrentDraft, scope]);

  const discoveredAskId = scope === 'workbench'
    ? activeWorkbenchConversationId
    : activeTerminal?.conversationId ?? null;

  useEffect(() => {
    let alive = true;
    let unsubscribe = (): void => undefined;
    const adapter = adaptersByKind(adapters, preset);
    const open = async (): Promise<void> => {
      let sessionId = openedSession?.kind === preset ? openedSession.id : null;
      if (!sessionId && preset === 'ask') {
        const exists = conversations.some((conversation) => (
          conversation.id === discoveredAskId && !conversation.archived
        ));
        sessionId = exists ? discoveredAskId : null;
      }
      if (!sessionId && preset === 'agent' && activeTerminal) {
        const page = await adapters.agent.list({
          scopeKey: `terminal-${activeTerminal.sessionId}`,
          archived: false,
          limit: 100,
        });
        sessionId = page.sessions[0]?.id ?? null;
      }
      if (!alive || !sessionId) return;
      const publish = (next: AiSessionView): void => {
        if (!alive) return;
        viewRef.current = next;
        setView(next);
      };
      unsubscribe = adapter.subscribe(sessionId, publish);
      publish(await adapter.open(sessionId));
    };
    void open().catch((error: unknown) => {
      if (alive) dispatch({ type: 'stop.failed', error: normalizeAiSessionError(error) });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [
    activeTerminal,
    adapters,
    conversations,
    discoveredAskId,
    dispatch,
    openedSession,
    preset,
  ]);

  useEffect(() => {
    dispatch({
      type: 'runtime.synchronized',
      sessionId: view?.summary.id ?? null,
      preset: view?.summary.kind ?? preset,
      status: view?.status ?? 'idle',
      terminal: view?.summary.kind === 'agent'
        && (view.status === 'completed' || view.status === 'cancelled' || view.status === 'failed'),
      waitingApproval: view?.pendingApproval !== null && view?.pendingApproval !== undefined,
    });
  }, [dispatch, preset, view?.pendingApproval, view?.status, view?.summary.id, view?.summary.kind]);

  useEffect(() => {
    if (!view) return;
    setNavigation((current) => current.route.kind === 'conversation'
      && current.route.sessionId !== view.summary.id
      ? { ...current, route: { kind: 'conversation', sessionId: view.summary.id } }
      : current);
  }, [view]);

  useEffect(() => {
    if (!view) return;
    const result = reconcileOptimisticSubmissions(optimisticRef.current, view.nodes, view.inbox);
    if (!sameOptimistic(result.remaining, optimisticRef.current)) {
      updateOptimistic(() => result.remaining);
    }
    for (const clientOperationId of result.committedOperationIds) {
      const timeout = timeoutRef.current.get(clientOperationId);
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeoutRef.current.delete(clientOperationId);
      dispatch({ type: 'submit.committed', clientOperationId });
    }
  }, [dispatch, updateOptimistic, view]);

  const visibleView = useMemo<AiSessionView | null>(() => {
    if (!view) return null;
    return {
      ...view,
      nodes: withOptimisticConversationNodes(
        view.nodes,
        optimistic,
        workspaceScopeKey,
        view.summary.id,
        view.inbox,
      ),
    };
  }, [optimistic, view, workspaceScopeKey]);
  const pendingNodes = useMemo(() => (
    view ? [] : withOptimisticConversationNodes([], optimistic, workspaceScopeKey, null)
  ), [optimistic, view, workspaceScopeKey]);

  useEffect(() => {
    setApprovalDecision(null);
    setApprovalError(null);
  }, [view?.pendingApproval?.approvalId]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const [askPage, agentPage] = await Promise.all([
        adapters.ask.list({ limit: 200 }),
        adapters.agent.list({ limit: 200 }),
      ]);
      const combined = [...askPage.sessions, ...agentPage.sessions]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      setSessions(combined);
    } catch (error) {
      setSessionsError(normalizeAiSessionError(error).message);
    } finally {
      setSessionsLoading(false);
    }
  }, [adapters]);

  const openSessions = useCallback((): void => {
    setNavigation((current) => ({ ...current, route: { kind: 'sessions' } }));
    void refreshSessions();
  }, [refreshSessions]);

  const openSession = useCallback((summary: AiSessionSummary): void => {
    saveCurrentDraft();
    setPresetState(summary.kind);
    setOpenedSession({ kind: summary.kind, id: summary.id });
    setView(null);
    setQueueMutation(null);
    viewRef.current = null;
    setNavigation((current) => ({
      ...current,
      route: { kind: 'conversation', sessionId: summary.id },
      returnFocus: null,
    }));
    dispatch({
      type: 'runtime.synchronized',
      sessionId: summary.id,
      preset: summary.kind,
      status: summary.status,
      terminal: summary.status === 'completed' || summary.status === 'cancelled' || summary.status === 'failed',
      waitingApproval: summary.status === 'waiting',
    });
    restoreDraft(summary.kind, summary.id);
  }, [dispatch, restoreDraft, saveCurrentDraft]);

  const newSession = useCallback((): void => {
    saveCurrentDraft();
    setOpenedSession(null);
    setView(null);
    setQueueMutation(null);
    viewRef.current = null;
    setNavigation((current) => ({
      ...current,
      route: { kind: 'conversation', sessionId: null },
      returnFocus: null,
    }));
    dispatch({
      type: 'runtime.synchronized',
      sessionId: null,
      preset,
      status: 'idle',
      terminal: false,
      waitingApproval: false,
    });
    restoreDraft(preset, null);
  }, [dispatch, preset, restoreDraft, saveCurrentDraft]);

  const archiveSession = useCallback((summary: AiSessionSummary): void => {
    setArchivingSessionId(summary.id);
    void adaptersByKind(adapters, summary.kind).archive(summary.id).then(
      () => {
        if (viewRef.current?.summary.id === summary.id) newSession();
        void refreshSessions();
      },
      (error: unknown) => setSessionsError(normalizeAiSessionError(error).message),
    ).finally(() => setArchivingSessionId(null));
  }, [adapters, newSession, refreshSessions]);

  const executeQueueMutation = useCallback((intent: AiQueueMutationIntent): void => {
    const current = viewRef.current;
    if (current?.summary.kind !== 'agent' || current.revision === null || current.revision === undefined) {
      setQueueMutation({
        intent,
        status: 'failed',
        error: t('ai.workspace.queue.errorUnavailable'),
        conflict: false,
      });
      return;
    }
    const clientOperationId = operationId();
    const base = {
      sessionId: current.summary.id,
      expectedRevision: current.revision,
      clientOperationId,
    };
    const input: AiInboxMutationInput = intent.type === 'update'
      ? { ...base, ...intent }
      : intent.type === 'remove'
        ? { ...base, ...intent }
        : { ...base, ...intent };
    setQueueMutation({ intent, status: 'pending', error: null, conflict: false });
    void adapters.agent.mutateInbox(input).then(
      () => setQueueMutation(null),
      async (error: unknown) => {
        const normalized = normalizeAiSessionError(error);
        if (normalized.kind === 'conflict') {
          try {
            const refreshed = await adapters.agent.refresh(current.summary.id);
            if (viewRef.current?.summary.id === refreshed.summary.id) {
              viewRef.current = refreshed;
              setView(refreshed);
            }
          } catch {
            // Keep the recognizable conflict; retry remains available.
          }
        }
        setQueueMutation({
          intent,
          status: 'failed',
          error: normalized.message,
          conflict: normalized.kind === 'conflict',
        });
      },
    );
  }, [adapters.agent, operationId]);

  const renameSession = useCallback((summary: AiSessionSummary, rawTitle: string): void => {
    if (summary.kind !== 'agent') {
      setRenameError(t('ai.workspace.sessions.renameAgentOnly'));
      return;
    }
    const title = rawTitle.trim();
    if (!title) {
      setRenameError(t('ai.workspace.sessions.renameRequired'));
      return;
    }
    setRenamingSessionId(summary.id);
    setRenameError(null);
    void (async () => {
      try {
        let revision = summary.revision;
        if (revision === null || revision === undefined) {
          revision = (await adapters.agent.refresh(summary.id)).revision;
        }
        if (revision === null || revision === undefined) {
          throw new Error(t('ai.workspace.sessions.renameRevisionUnavailable'));
        }
        await adapters.agent.rename({
          sessionId: summary.id,
          expectedRevision: revision,
          clientOperationId: operationId(),
          title,
        });
        await refreshSessions();
      } catch (error) {
        const normalized = normalizeAiSessionError(error);
        if (normalized.kind === 'conflict') {
          try {
            await adapters.agent.refresh(summary.id);
            await refreshSessions();
          } catch {
            // The committed list refresh can be retried from the rename dialog.
          }
        }
        setRenameError(normalized.message);
      } finally {
        setRenamingSessionId(null);
      }
    })();
  }, [adapters.agent, operationId, refreshSessions]);

  const back = useCallback((): void => {
    setNavigation((current) => {
      if (current.route.kind === 'sessions') {
        return {
          ...current,
          route: { kind: 'conversation', sessionId: viewRef.current?.summary.id ?? null },
        };
      }
      if (current.route.kind === 'toolDetails' || current.route.kind === 'artifactDetails') {
        return {
          ...current,
          route: { kind: 'conversation', sessionId: current.route.sessionId },
        };
      }
      return current;
    });
  }, []);

  const openToolDetails = useCallback((node: AiConversationNodeOf<'tool'>): void => {
    setNavigation((current) => ({
      ...current,
      route: { kind: 'toolDetails', sessionId: node.sessionId, nodeKey: node.key },
      returnFocus: { sessionId: node.sessionId, nodeKey: node.key },
    }));
  }, []);

  const openArtifactDetails = useCallback((node: AiConversationNodeOf<'artifact'>): void => {
    setNavigation((current) => ({
      ...current,
      route: { kind: 'artifactDetails', sessionId: node.sessionId, artifactId: node.artifactId },
      returnFocus: { sessionId: node.sessionId, nodeKey: node.key },
    }));
  }, []);

  const selectTab = useCallback((tab: AiWorkspaceTab): void => {
    const session = viewRef.current?.summary;
    if (!session) return;
    const key = sessionRouteKey(session.kind, session.id);
    setNavigation((current) => ({
      ...current,
      selectedTabBySession: { ...current.selectedTabBySession, [key]: tab },
    }));
  }, []);

  const saveScrollAnchor = useCallback((anchor: AiScrollAnchor): void => {
    const session = viewRef.current?.summary;
    if (!session) return;
    const key = sessionRouteKey(session.kind, session.id);
    setNavigation((current) => ({
      ...current,
      scrollAnchorBySession: { ...current.scrollAnchorBySession, [key]: anchor },
    }));
  }, []);

  const decideApproval = useCallback((decision: 'approve' | 'reject'): void => {
    const approval = viewRef.current?.pendingApproval;
    if (!approval || approvalDecision !== null) return;
    setApprovalDecision(decision);
    setApprovalError(null);
    const operation = decision === 'approve' ? adapters.agent.approve(approval) : adapters.agent.reject(approval);
    void operation.catch((error: unknown) => {
      setApprovalDecision(null);
      setApprovalError(normalizeAiSessionError(error).message);
    });
  }, [adapters.agent, approvalDecision]);

  const loadOlder = useCallback((): void => {
    const current = viewRef.current;
    if (!current?.canLoadOlder || loadingOlder) return;
    setLoadingOlder(true);
    const firstSeq = current.nodes[0]?.firstSeq ?? 0;
    void adaptersByKind(adapters, current.summary.kind).loadOlder(current.summary.id, String(firstSeq)).then(
      (older) => {
        if (older.length === 0 || viewRef.current?.summary.id !== current.summary.id) return;
        const keys = new Set(current.nodes.map((node) => node.key));
        const next = { ...current, nodes: [...older.filter((node) => !keys.has(node.key)), ...current.nodes] };
        viewRef.current = next;
        setView(next);
      },
      (error: unknown) => setAnnouncement(normalizeAiSessionError(error).message),
    ).finally(() => setLoadingOlder(false));
  }, [adapters, loadingOlder]);

  const loadArtifact = useCallback<AiSessionAdapter['loadArtifact']>((sessionId, artifactId, maxBytes) => (
    adapters.agent.loadArtifact(sessionId, artifactId, maxBytes)
  ), [adapters.agent]);

  return {
    view: visibleView,
    pendingNodes,
    composer,
    preset,
    providerLabel: provider?.name ?? '',
    modelLabel: provider?.model ?? '',
    announcement,
    navigation,
    sessions,
    sessionsLoading,
    sessionsError,
    archivingSessionId,
    approvalDecision,
    approvalError,
    loadingOlder,
    queueMutation,
    renamingSessionId,
    renameError,
    setDraft: (value) => dispatch({ type: 'draft.changed', value }),
    setPreset: (value) => {
      saveCurrentDraft();
      setOpenedSession(null);
      setView(null);
      viewRef.current = null;
      setPresetState(value);
      dispatch({ type: 'preset.changed', value });
      dispatch({
        type: 'runtime.synchronized',
        sessionId: null,
        preset: value,
        status: 'idle',
        terminal: false,
        waitingApproval: false,
      });
      restoreDraft(value, null);
      setNavigation((current) => ({ ...current, route: { kind: 'conversation', sessionId: null } }));
    },
    setBusyPreference: (value) => dispatch({ type: 'preference.changed', value }),
    submit: (gesture, accelerated = false) => dispatch({
      type: 'submit.requested',
      gesture,
      accelerated,
      clientOperationId: operationId(),
      now: now(),
      hasProvider,
      canCreateSession,
    }),
    stop: () => dispatch({ type: 'stop.requested' }),
    retryFailedDraft: (failedDraftId) => dispatch({
      type: 'retry.requested',
      failedDraftId,
      clientOperationId: operationId(),
      now: now(),
      hasProvider,
      canCreateSession,
    }),
    dismissError: () => dispatch({ type: 'error.dismissed' }),
    openSessions,
    openSession,
    newSession,
    archiveSession,
    updateQueueItem: (item, content) => executeQueueMutation({
      type: 'update', itemId: item.id, content,
    }),
    removeQueueItem: (item) => executeQueueMutation({ type: 'remove', itemId: item.id }),
    reorderQueueLane: (lane, orderedItemIds) => executeQueueMutation({
      type: 'reorder', lane, orderedItemIds,
    }),
    retryQueueMutation: () => {
      if (queueMutation) executeQueueMutation(queueMutation.intent);
    },
    renameSession,
    back,
    openToolDetails,
    openArtifactDetails,
    selectTab,
    saveScrollAnchor,
    completeRouteReturn: () => setNavigation((current) => ({ ...current, returnFocus: null })),
    approve: () => decideApproval('approve'),
    reject: () => decideApproval('reject'),
    loadOlder,
    loadArtifact,
  };
}
