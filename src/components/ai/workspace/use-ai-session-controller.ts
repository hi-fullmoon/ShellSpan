import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAgentSessionAdapter } from '@/lib/ai/agent-session-adapter';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { questionKey } from '@/types/agent-question';
import { useImageDraft } from './use-image-draft';
import { sessionProviderConfig } from '@/lib/ai/session-settings';
import { listAllAiSessions } from '@/lib/ai/session-list';
import type { AiProviderConfig } from '@/types/ai';
import { requireVision } from '@/lib/ai/vision-contract';
import { resolveAiSubmission } from '@/lib/ai/submission-policy';
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
import { normalizeAiSessionError, sessionArchiveErrorMessage } from '@/lib/ai/session-error';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import {
  createAiWorkspaceNavigationState,
  sessionRouteKey,
  type AiScrollAnchor,
  type AiWorkspaceNavigationState,
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
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { routeProviderConfigs, useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AppSection } from '@/types';
import type { AgentPermissionMode } from '@/types/agent-approval';
import type {
  AgentSessionPermissionMode,
  AgentSessionTarget,
} from '@/types/agent-session';

const OPTIMISTIC_COMMIT_TIMEOUT_MS = 15_000;
type AiAnnouncement = Extract<AiComposerEffect, { type: 'announce' }>['reason'];

export type AiSessionControllerAdapter = AiSessionAdapter<'agent'>;

export interface UseAiSessionControllerInput {
  readonly scope: Extract<AppSection, 'terminal' | 'workbench'>;
  readonly adapter?: AiSessionControllerAdapter;
  readonly now?: () => number;
  readonly operationId?: () => string;
}

export interface AiSessionController {
  readonly selectedProvider?: AiProviderConfig;
  readonly selectedPermission?: AgentPermissionMode;
  readonly settingsBusy: boolean;
  readonly selectModel: (provider: AiProviderConfig) => Promise<void>;
  readonly selectPermission: (mode: AgentPermissionMode) => Promise<void>;
  readonly imageDraft: ReturnType<typeof useImageDraft>;
  readonly listFileReferences: import('@/types/agent-file-reference').ListFileReferences;
  readonly listSkills: (root?: string) => Promise<import('@/types/agent-skill').SkillUserList>;
  readonly skillsScopeKey: string;
  readonly skillsNeedsRoot: boolean;
  readonly projectTargetLabel: string;
  readonly answerQuestion: AiSessionAdapter['answerQuestion'];
  readonly view: AiSessionView | null;
  readonly pendingNodes: readonly AiConversationNode[];
  readonly composer: AiComposerState;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly canStartAgent: boolean;
  readonly agentUnavailableReason: string | null;
  readonly announcement: AiAnnouncement | null;
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
  readonly setBusyPreference: (value: 'queue' | 'steer') => void;
  readonly submit: (gesture: 'keyboard' | 'primary', accelerated?: boolean) => void;
  readonly stop: () => void;
  readonly retryFailedDraft: (failedDraftId: string) => void;
  readonly dismissError: () => void;
  readonly openSessions: () => void;
  readonly openSession: (summary: AiSessionSummary) => void;
  readonly newSession: () => void;
  readonly refreshSessions: () => void;
  readonly archiveSession: (summary: AiSessionSummary) => void;
  readonly updateQueueItem: (item: AiInboxItem, content: string) => void;
  readonly removeQueueItem: (item: AiInboxItem) => void;
  readonly steerQueueItem: (item: AiInboxItem) => void;
  readonly reorderQueueLane: (lane: AiInboxItem['lane'], orderedItemIds: readonly string[]) => void;
  readonly retryQueueMutation: () => void;
  readonly renameSession: (summary: AiSessionSummary, title: string) => void;
  readonly back: () => void;
  readonly openToolDetails: (node: AiConversationNodeOf<'tool'>) => void;
  readonly openArtifactDetails: (node: AiConversationNodeOf<'artifact'>) => void;
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
  | Readonly<{ type: 'steer'; itemId: string }>
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

function permissionMode(mode: AgentPermissionMode): AgentSessionPermissionMode {
  if (mode === 'autoApproveReadOnly') return 'scopedAutopilot';
  if (mode === 'fullAccess') return 'operator';
  return 'requestApproval';
}

function sameTarget(left: AgentSessionTarget | undefined, right: AgentSessionTarget | undefined): boolean {
  if (!left || !right) return left === right;
  // IPC serialization can reorder fields in a restored target. Compare every value.
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof AgentSessionTarget)[]);
  return [...keys].every(key => left[key] === right[key]);
}

function sameOptimistic(
  left: readonly AiOptimisticSubmission[],
  right: readonly AiOptimisticSubmission[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Interpret Composer effects against the Agent adapter while committed views stay adapter-owned. */
export function useAiSessionController({
  scope,
  adapter: providedAdapter,
  now = Date.now,
  operationId = generateId,
}: UseAiSessionControllerInput): AiSessionController {
  const ownedAdapter = useMemo<AiSessionControllerAdapter | null>(() => (
    providedAdapter ? null : createAgentSessionAdapter()
  ), [providedAdapter]);
  const adapter = providedAdapter ?? ownedAdapter!;
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const activeTerminalId = useTerminalStore((state) => state.activeSessionId);
  const legacyProviders = useAiSettingsStore((state) => state.providers);
  const routeSnapshot = useLlmRoutesStore((state) => state.snapshot);
  const routeModels = useLlmRoutesStore((state) => state.modelsByRoute);
  const hydrateRoutes = useLlmRoutesStore((state) => state.hydrate);
  useEffect(()=>{if(isTauriRuntime()&&!routeSnapshot)void hydrateRoutes();},[routeSnapshot,hydrateRoutes]);
  const providers = useMemo(()=>routeSnapshot ? routeProviderConfigs(routeSnapshot,routeModels) : isTauriRuntime() ? [] : legacyProviders,[routeSnapshot,routeModels,legacyProviders]);
  const defaultProviderId = useAiSettingsStore((state) => state.defaultProviderId);
  const provider = useMemo(() => {
    if (routeSnapshot) {
      if (!routeSnapshot.defaultSelection) return undefined;
      try {
        return sessionProviderConfig(routeSnapshot.defaultSelection, providers);
      } catch {
        return undefined;
      }
    }
    return providers.find((item) => item.id === defaultProviderId) ?? providers[0];
  }, [defaultProviderId, providers, routeSnapshot]);
  const activeTerminal = terminalSessions.find((item) => item.sessionId === activeTerminalId);
  const [view, setView] = useState<AiSessionView | null>(null);
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<readonly AiOptimisticSubmission[]>([]);
  const [announcement, setAnnouncement] = useState<AiAnnouncement | null>(null);
  const [composer, setComposer] = useState(() => createAiComposerState({
    draft: useAiDraftStore.getState().drafts[`new:agent:${scope}:${activeTerminal?.sessionId ?? 'workspace'}`] ?? '',
  }));
  const [navigation, setNavigation] = useState(() => createAiWorkspaceNavigationState());
  const scrollAnchorsRef = useRef<Record<string, AiScrollAnchor | undefined>>({});
  const [sessions, setSessions] = useState<readonly AiSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const archivePendingRef = useRef(false);
  const [approvalDecision, setApprovalDecision] = useState<'approve' | 'reject' | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [queueMutation, setQueueMutation] = useState<AiQueueMutationState | null>(null);
  const queueOperationRef = useRef<{ input: AiInboxMutationInput; pending: boolean } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const composerRef = useRef(composer);
  const viewRef = useRef(view);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsPending = useRef(false);
  const currentProviderConfig = useCallback((): AiProviderConfig => {
    const selection = viewRef.current?.snapshot.value.header.modelSelection;
    const routes=useLlmRoutesStore.getState();
    const available=routes.snapshot ? routeProviderConfigs(routes.snapshot,routes.modelsByRoute) : isTauriRuntime() ? [] : useAiSettingsStore.getState().providers;
    if(selection)return sessionProviderConfig(selection,available);
    if(routes.snapshot?.defaultSelection)return sessionProviderConfig(routes.snapshot.defaultSelection,available);
    if(isTauriRuntime())throw new Error('INVALID_MODEL_SELECTION: no default route');
    return useAiSettingsStore.getState().getProviderConfig();
  }, []);
  const changeSettings = async (change: (sessionId: string) => Promise<void>): Promise<void> => {
    const sessionId = viewRef.current?.summary.id;
    if (!sessionId || settingsPending.current) return;
    settingsPending.current = true;
    setSettingsBusy(true);
    const context = submissionContextRef.current;
    try {
      await change(sessionId);
    } catch (error) {
      if (mountedRef.current && submissionContextRef.current === context) {
        dispatch({ type: 'error.reported', error: normalizeAiSessionError(error) });
      }
    } finally {
      settingsPending.current = false;
      if (mountedRef.current) setSettingsBusy(false);
    }
  };

  const optimisticRef = useRef(optimistic);
  const mountedRef = useRef(true);
  const timeoutRef = useRef(new Map<string, number>());
  const effectExecutorRef = useRef<(effect: AiComposerEffect) => void>(() => undefined);
  const sessionListRequestRef = useRef(0);

  const workspaceScopeKey = `agent:${scope}:${activeTerminal?.sessionId ?? 'workspace'}`;
  const appliedWorkspaceRef = useRef(workspaceScopeKey);
  const workspaceChanging = appliedWorkspaceRef.current !== workspaceScopeKey;
  const submissionContextRef = useRef({ key: workspaceScopeKey });
  if (submissionContextRef.current.key !== workspaceScopeKey) {
    submissionContextRef.current = { key: workspaceScopeKey };
  }
  // Initial history is only a convenience. It must never claim a workspace after
  // the user has begun a draft, chosen a project, or explicitly navigated.
  const automaticRestore = useRef({ key: workspaceScopeKey, eligible: true });
  if (automaticRestore.current.key !== workspaceScopeKey) {
    automaticRestore.current = { key: workspaceScopeKey, eligible: true };
  }
  const claimWorkspace = useCallback(() => { automaticRestore.current.eligible = false; }, []);
  const canStartAgent = scope === 'terminal'
    && activeTerminal?.status === 'connected';
  const terminalUnavailableReason = canStartAgent
    ? null
    : t('agent.availability.needsTerminal');
  const hasProvider = Boolean(view?.snapshot.value.header.modelSelection?.modelId.trim() || provider?.model.trim());

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

  const navigationDraftKey = useCallback((sessionId: string | null): string => (
    sessionId
      ? sessionRouteKey('agent', sessionId)
      : `new:agent:${scope}:${activeTerminal?.sessionId ?? 'workspace'}`
  ), [activeTerminal?.sessionId, scope]);
  // Keep the editor's owner until its draft is saved, even after the active
  // terminal has changed in the store.
  const draftOwnerRef = useRef(navigationDraftKey(null));

  const saveCurrentDraft = useCallback((): void => {
    useAiDraftStore.getState().saveDraft(draftOwnerRef.current, composerRef.current.draft);
  }, []);

  const restoreDraft = useCallback((sessionId: string | null): void => {
    const key = navigationDraftKey(sessionId);
    draftOwnerRef.current = key;
    dispatch({
      type: 'draft.changed',
      value: useAiDraftStore.getState().drafts[key] ?? '',
    });
  }, [dispatch, navigationDraftKey]);

  const adoptDraft = useCallback((sessionId: string): void => {
    const key = navigationDraftKey(sessionId);
    if (draftOwnerRef.current === key) return;
    // The new-conversation draft now belongs to the created session. Do not
    // resurrect its submitted text the next time a blank conversation opens.
    useAiDraftStore.getState().saveDraft(draftOwnerRef.current, '');
    draftOwnerRef.current = key;
  }, [navigationDraftKey]);

  const resetComposer = useCallback((summary?: AiSessionSummary): void => {
    saveCurrentDraft();
    submissionContextRef.current = { key: workspaceScopeKey };
    for (const timeout of timeoutRef.current.values()) window.clearTimeout(timeout);
    timeoutRef.current.clear();
    updateOptimistic(() => []);
    const key = navigationDraftKey(summary?.id ?? null);
    draftOwnerRef.current = key;
    const next = createAiComposerState({
      sessionId: summary?.id ?? null,
      runtimeStatus: summary?.status ?? 'idle',
      terminal: summary !== undefined && ['completed', 'cancelled', 'failed'].includes(summary.status),
      waitingApproval: summary?.status === 'waiting',
      draft: useAiDraftStore.getState().drafts[key] ?? '',
      preferredBusyMode: composerRef.current.preferredBusyMode,
    });
    composerRef.current = next;
    setComposer(next);
    setAnnouncement(null);
  }, [navigationDraftKey, saveCurrentDraft, updateOptimistic, workspaceScopeKey]);

  const coldSkillSession = useRef<Promise<AiSessionView> | null>(null);
  const imageDraft = useImageDraft(navigationDraftKey(openedSessionId ?? view?.summary.id ?? null), composer.draft,
    value => { claimWorkspace(); dispatch({ type: 'draft.changed', value }); });
  const [skillNavigation, setSkillNavigation] = useState(0);
  const [skillRoot, setSkillRoot] = useState<string | null>(null);
  useEffect(() => { coldSkillSession.current = null; setSkillRoot(null); }, [workspaceScopeKey, openedSessionId]);

  const createInput = useCallback((
    content: string,
  ): Extract<AiCreateSessionInput, { kind: 'agent' }> => {
    if (scope !== 'terminal' || !activeTerminal || activeTerminal.status !== 'connected') {
      throw new Error(t('ai.workspace.error.connectedTerminalRequired'));
    }
    const sessionId = `agent-${activeTerminal.sessionId}-${operationId()}`;
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
  }, [activeTerminal, operationId, scope]);

  const projectKey = `${workspaceScopeKey}:${openedSessionId ?? 'new'}:${skillNavigation}`;
  const projectEpoch = useRef({ key: projectKey });
  if (projectEpoch.current.key !== projectKey) projectEpoch.current = { key: projectKey };
  const ensureProjectSession = useCallback(async (root?: string): Promise<string> => {
    const epoch = projectEpoch.current;
    let sessionId = viewRef.current?.summary.id ?? openedSessionId;
    if (!sessionId) {
      if (!coldSkillSession.current) {
        const selectedRoot = root?.trim();
        if (!selectedRoot || !(/^(?:\/|[A-Za-z]:[\\/])/.test(selectedRoot)) || /[\x00-\x1f]/.test(selectedRoot)) throw new Error(t('ai.workspace.skills.absoluteRoot'));
        claimWorkspace();
        const input = createInput(composerRef.current.draft.trim() || t('ai.workspace.skills.title'));
        const target = input.request.target!;
        coldSkillSession.current = adapter.create({ ...input, request: { ...input.request, target: { ...target, ...(target.kind === 'local' ? { cwd: selectedRoot } : { rootPath: selectedRoot }) } } });
        setSkillRoot(selectedRoot);
      }
      const pending = coldSkillSession.current;
      try { sessionId = (await pending).summary.id; } catch (error) {
        if (coldSkillSession.current === pending) { coldSkillSession.current = null; setSkillRoot(null); }
        throw error;
      }
      if (coldSkillSession.current !== pending) throw new Error(t('ai.workspace.skills.unavailable'));
    }
    if (projectEpoch.current !== epoch) throw new Error('Cancelled');
    return sessionId;
  }, [adapter, claimWorkspace, createInput, openedSessionId, skillNavigation, t]);

  const listSkills = useCallback(async (root?: string): Promise<import('@/types/agent-skill').SkillUserList> => {
    // Browsing bundled instructions must not create a cold Session or freeze a directory.
    if (root === undefined && !viewRef.current && !openedSessionId && !coldSkillSession.current) {
      if (scope !== 'terminal' || !activeTerminal || activeTerminal.status !== 'connected') throw new Error(t('ai.workspace.error.connectedTerminalRequired'));
      return builtinSkillPreview;
    }
    if (!adapter.listSkills) throw new Error(t('ai.workspace.skills.unavailable'));
    const sessionId = await ensureProjectSession(root);
    return adapter.listSkills(sessionId);
  }, [activeTerminal, adapter, ensureProjectSession, openedSessionId, scope, t]);
  const listFileReferences = useCallback<import('@/types/agent-file-reference').ListFileReferences>(async (query, signal, root) => {
    const epoch = projectEpoch.current;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!adapter.listFileReferences) throw new Error('Unavailable');
    const sessionId = await ensureProjectSession(root);
    if (signal.aborted || epoch !== projectEpoch.current) throw new DOMException('Cancelled', 'AbortError');
    const result = await adapter.listFileReferences(sessionId, query, signal);
    if (signal.aborted || epoch !== projectEpoch.current) throw new DOMException('Cancelled', 'AbortError');
    return result;
  }, [adapter, ensureProjectSession]);

  effectExecutorRef.current = (effect): void => {
    const context = submissionContextRef.current;
    const isCurrent = (): boolean => mountedRef.current && submissionContextRef.current === context;
    if (effect.type === 'focusEditor') return;
    if (effect.type === 'announce') {
      setAnnouncement(effect.reason);
      return;
    }
    if (effect.type === 'stop') {
      void adapter.stop(effect.sessionId).then(
        () => { if (isCurrent()) dispatch({ type: 'stop.succeeded' }); },
        (error: unknown) => { if (isCurrent()) dispatch({ type: 'stop.failed', error: normalizeAiSessionError(error) }); },
      );
      return;
    }

    const payload = effect.payload;
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
        const currentProvider = currentProviderConfig();
        const base = {
          content: payload.content,
          mode: payload.mode,
          clientOperationId: payload.clientOperationId,
          provider: currentProvider,
        };
        const cold = payload.sessionId === null ? await coldSkillSession.current : null;
        const receipt = await adapter.submit(payload.sessionId ?? cold?.summary.id ?? null, {
          ...base,
          ...(payload.sessionId === null && !cold
            ? { create: createInput(payload.content) }
            : {}),
        } satisfies AiSubmitInput<'agent'>);
        if (!isCurrent()) return;
        updateOptimistic((current) => current.map((item) => (
          item.clientOperationId === payload.clientOperationId
            ? { ...item, sessionId: receipt.sessionId, delivery: 'accepted' }
            : item
        )));
        setOpenedSessionId(receipt.sessionId);
        adoptDraft(receipt.sessionId);
        setNavigation((current) => current.route.kind === 'conversation' ? ({
          ...current,
          route: { kind: 'conversation', sessionId: receipt.sessionId },
        }) : current);
        dispatch({ type: 'submit.accepted', receipt });
        const timeout = window.setTimeout(() => {
          timeoutRef.current.delete(payload.clientOperationId);
          if (!isCurrent()) return;
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
        if (!isCurrent()) return;
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
      saveCurrentDraft();
      mountedRef.current = false;
      for (const timeout of timeoutRef.current.values()) window.clearTimeout(timeout);
      timeoutRef.current.clear();
      ownedAdapter?.dispose();
    };
  }, [ownedAdapter, saveCurrentDraft]);

  useEffect(() => {
    resetComposer();
    appliedWorkspaceRef.current = workspaceScopeKey;
    if (composerRef.current.draft) claimWorkspace();
    setOpenedSessionId(null);
    setView(null);
    setQueueMutation(null);
    queueOperationRef.current = null;
    viewRef.current = null;
    setNavigation(createAiWorkspaceNavigationState());
  }, [claimWorkspace, resetComposer, workspaceScopeKey]);

  useEffect(() => {
    // Wait for the old workspace's state to clear before choosing its successor.
    if (workspaceChanging) return;
    let alive = true;
    let unsubscribe = (): void => undefined;
    const restore = automaticRestore.current;
    const context = submissionContextRef.current;
    let established = false;
    const canPublish = (): boolean => alive && submissionContextRef.current === context && (Boolean(openedSessionId)
      || (automaticRestore.current === restore && (established || restore.eligible)));
    const open = async (): Promise<void> => {
      let sessionId = openedSessionId;
      if (!sessionId && scope === 'terminal' && activeTerminal) {
        if (!canPublish()) return;
        const summaries = await listAllAiSessions(adapter, {
          scopeKey: `terminal-${activeTerminal.sessionId}`,
          archived: false,
          limit: 100,
        }, canPublish);
        sessionId = summaries?.[0]?.id ?? null;
      }
      if (!canPublish() || !sessionId) return;
      const publish = (next: AiSessionView): void => {
        if (!canPublish()) return;
        established = true;
        viewRef.current = next;
        setView(next);
      };
      unsubscribe = adapter.subscribe(sessionId, publish);
      publish(await adapter.open(sessionId));
    };
    void open().catch((error: unknown) => {
      if (canPublish()) dispatch({ type: 'stop.failed', error: normalizeAiSessionError(error) });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [
    activeTerminal,
    adapter,
    dispatch,
    openedSessionId,
    scope,
    skillNavigation,
    workspaceChanging,
  ]);

  useEffect(() => {
    // An explicit history selection already owns the composer. A missing view
    // here means its transcript is loading, not that a new session was opened.
    if (!view && openedSessionId) return;
    if (view && viewRef.current !== view) return;
    if (view && draftOwnerRef.current !== navigationDraftKey(view.summary.id)) {
      saveCurrentDraft();
      if (composerRef.current.pendingSubmissions.some((item) => item.sessionId === null)) {
        adoptDraft(view.summary.id);
      } else {
        restoreDraft(view.summary.id);
      }
    }
    dispatch({
      type: 'runtime.synchronized',
      sessionId: view?.summary.id ?? null,
      status: view?.status ?? 'idle',
      terminal: view !== null
        && (view.status === 'completed' || view.status === 'cancelled' || view.status === 'failed'),
      waitingApproval: view?.pendingApproval !== null && view?.pendingApproval !== undefined,
      waitingQuestion: Boolean(view?.pendingQuestion),
    });
  }, [adoptDraft, dispatch, navigationDraftKey, openedSessionId, restoreDraft, saveCurrentDraft, view]);

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
  const sessionProviderResolution = useMemo(() => {
    const selection = visibleView?.snapshot.value.header.modelSelection;
    if (!selection) return { provider: undefined, error: null };
    try {
      return { provider: sessionProviderConfig(selection, providers), error: null };
    } catch (error) {
      return { provider: undefined, error: normalizeAiSessionError(error).message };
    }
  }, [providers, visibleView]);
  const agentUnavailableReason = sessionProviderResolution.error ?? terminalUnavailableReason;
  const pendingNodes = useMemo(() => (
    view ? [] : withOptimisticConversationNodes([], optimistic, workspaceScopeKey, null)
  ), [optimistic, view, workspaceScopeKey]);

  useEffect(() => {
    setApprovalDecision(null);
    setApprovalError(null);
  }, [view?.pendingApproval?.approvalId]);

  const refreshSessions = useCallback(async (): Promise<void> => {
    const requestId = ++sessionListRequestRef.current;
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const summaries = await listAllAiSessions(adapter, { limit: 200 }, () => (
        mountedRef.current && requestId === sessionListRequestRef.current
      ));
      if (summaries && mountedRef.current && requestId === sessionListRequestRef.current) {
        setSessions(summaries);
      }
    } catch (error) {
      if (mountedRef.current && requestId === sessionListRequestRef.current) {
        setSessionsError(normalizeAiSessionError(error).message);
      }
    } finally {
      if (mountedRef.current && requestId === sessionListRequestRef.current) {
        setSessionsLoading(false);
      }
    }
  }, [adapter]);

  const openSessions = useCallback((): void => {
    claimWorkspace();
    setNavigation((current) => ({ ...current, route: { kind: 'sessions' } }));
    void refreshSessions();
  }, [claimWorkspace, refreshSessions]);

  const openSession = useCallback((summary: AiSessionSummary): void => {
    claimWorkspace();
    const retainedView = viewRef.current?.summary.id === summary.id ? viewRef.current : null;
    resetComposer(summary);
    // Selecting the current history entry is a new visit too; renew its
    // subscription even when the session ID itself has not changed.
    setSkillNavigation((generation) => generation + 1);
    setOpenedSessionId(summary.id);
    // Refreshing the visible session must not unmount its transcript/scroller.
    setView(retainedView);
    setQueueMutation(null);
    queueOperationRef.current = null;
    viewRef.current = retainedView;
    setNavigation((current) => ({
      ...current,
      route: { kind: 'conversation', sessionId: summary.id },
      returnFocus: null,
    }));
  }, [claimWorkspace, resetComposer]);

  const newSession = useCallback((): void => {
    claimWorkspace();
    automaticRestore.current = { ...automaticRestore.current, eligible: false };
    coldSkillSession.current = null;
    setSkillNavigation((generation) => generation + 1);
    setSkillRoot(null);
    resetComposer();
    setOpenedSessionId(null);
    setView(null);
    setQueueMutation(null);
    queueOperationRef.current = null;
    viewRef.current = null;
    setNavigation((current) => ({
      ...current,
      route: { kind: 'conversation', sessionId: null },
      returnFocus: null,
    }));
  }, [claimWorkspace, resetComposer]);

  const archiveSession = useCallback((summary: AiSessionSummary): void => {
    if (archivePendingRef.current || summary.archived) return;
    const current = viewRef.current?.summary.id === summary.id
      ? viewRef.current.summary
      : sessions.find(session => session.id === summary.id) ?? summary;
    setSessionsError(null);
    if (current.status === 'running' || current.status === 'waiting') {
      setSessionsError(t('ai.workspace.sessions.archiveBusy'));
      return;
    }
    archivePendingRef.current = true;
    setArchivingSessionId(summary.id);
    void adapter.archive(summary.id).then(
      () => {
        if (viewRef.current?.summary.id === summary.id) newSession();
        void refreshSessions();
      },
      async (error: unknown) => {
        const message = sessionArchiveErrorMessage(error, t);
        await refreshSessions();
        if (mountedRef.current) setSessionsError(message);
      },
    ).finally(() => {
      archivePendingRef.current = false;
      if (mountedRef.current) setArchivingSessionId(null);
    });
  }, [adapter, newSession, refreshSessions, sessions, t]);

  const executeQueueMutation = useCallback((intent: AiQueueMutationIntent, retry = false): void => {
    // React state alone cannot guard two clicks within the same render.
    if (queueOperationRef.current?.pending) return;
    if (!retry) queueOperationRef.current = null;
    const current = viewRef.current;
    const previous = retry ? queueOperationRef.current?.input : undefined;
    if (current?.summary.kind !== 'agent' || current.revision == null) {
      setQueueMutation({ intent, status: 'failed', error: t('ai.workspace.queue.errorUnavailable'), conflict: false });
      return;
    }
    if (previous && previous.sessionId !== current.summary.id) return;
    if (previous && current.committedOperationIds?.includes(previous.clientOperationId)) {
      queueOperationRef.current = null;
      setQueueMutation(null);
      return;
    }
    // A retry must reach the durable receipt lookup even if the item has since
    // been consumed. New requests can be rejected immediately from the view.
    const terminal = ['completed', 'failed', 'cancelled'].includes(current.status);
    const steerable = intent.type !== 'steer' || (current.status === 'running'
      && current.inbox.some((item) => item.id === intent.itemId && item.state === 'queued'
        && item.source === 'user' && item.lane === 'nextTurn'));
    if (!previous && (current.summary.archived || current.snapshot.value.ended || terminal || !steerable)) {
      setQueueMutation({ intent, status: 'failed', error: t('ai.workspace.queue.errorNotActionable'), conflict: false });
      return;
    }
    const input: AiInboxMutationInput = {
      ...intent,
      sessionId: current.summary.id,
      expectedRevision: current.revision,
      clientOperationId: previous?.clientOperationId ?? operationId(),
    };
    const operation = { input, pending: true };
    queueOperationRef.current = operation;
    const isCurrent = (): boolean => mountedRef.current && queueOperationRef.current === operation
      && viewRef.current?.summary.id === input.sessionId;
    setQueueMutation({ intent, status: 'pending', error: null, conflict: false });
    void adapter.mutateInbox(input).then(
      () => {
        if (!isCurrent()) return;
        queueOperationRef.current = null;
        setQueueMutation(null);
      },
      async (error: unknown) => {
        const normalized = normalizeAiSessionError(error);
        if (normalized.kind === 'conflict' && isCurrent()) {
          try {
            const refreshed = await adapter.refresh(input.sessionId);
            if (isCurrent()) {
              viewRef.current = refreshed;
              setView(refreshed);
            }
          } catch {
            // Keep the recognizable conflict; retry remains available.
          }
        }
        if (!isCurrent()) return;
        if (viewRef.current?.committedOperationIds?.includes(input.clientOperationId)) {
          queueOperationRef.current = null;
          setQueueMutation(null);
          return;
        }
        operation.pending = false;
        setQueueMutation({ intent, status: 'failed', error: normalized.message, conflict: normalized.kind === 'conflict' });
      },
    );
  }, [adapter, operationId, t]);

  const renameSession = useCallback((summary: AiSessionSummary, rawTitle: string): void => {
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
          revision = (await adapter.refresh(summary.id)).revision;
        }
        if (revision === null || revision === undefined) {
          throw new Error(t('ai.workspace.sessions.renameRevisionUnavailable'));
        }
        await adapter.rename({
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
            await adapter.refresh(summary.id);
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
  }, [adapter, operationId, refreshSessions]);

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

  const saveScrollAnchor = useCallback((anchor: AiScrollAnchor): void => {
    const session = viewRef.current?.summary;
    if (!session) return;
    const key = sessionRouteKey(session.kind, session.id);
    // Reading position is navigation bookkeeping, not rendered UI state.
    scrollAnchorsRef.current[key] = anchor;
  }, []);

  const decideApproval = useCallback((decision: 'approve' | 'reject'): void => {
    const approval = viewRef.current?.pendingApproval;
    if (!approval || approvalDecision !== null) return;
    setApprovalDecision(decision);
    setApprovalError(null);
    const operation = decision === 'approve' ? adapter.approve(approval) : adapter.reject(approval);
    void operation.catch((error: unknown) => {
      setApprovalDecision(null);
      setApprovalError(normalizeAiSessionError(error).message);
    });
  }, [adapter, approvalDecision]);

  const loadOlder = useCallback((): void => {
    const current = viewRef.current;
    if (!current?.canLoadOlder || loadingOlder) return;
    setLoadingOlder(true);
    const firstSeq = current.nodes[0]?.firstSeq ?? 0;
    void adapter.loadOlder(current.summary.id, String(firstSeq)).then(
      (older) => {
        if (older.length === 0 || viewRef.current?.summary.id !== current.summary.id) return;
        const keys = new Set(current.nodes.map((node) => node.key));
        const next = { ...current, nodes: [...older.filter((node) => !keys.has(node.key)), ...current.nodes] };
        viewRef.current = next;
        setView(next);
      },
      (error: unknown) => {
        if (mountedRef.current && viewRef.current?.summary.id === current.summary.id) {
          dispatch({ type: 'error.reported', error: normalizeAiSessionError(error) });
        }
      },
    ).finally(() => setLoadingOlder(false));
  }, [adapter, dispatch, loadingOlder]);

  const loadArtifact = useCallback<AiSessionAdapter['loadArtifact']>((sessionId, artifactId, maxBytes) => (
    adapter.loadArtifact(sessionId, artifactId, maxBytes)
  ), [adapter]);

  return {
    imageDraft: {
      ...imageDraft,
      add: files => { claimWorkspace(); return imageDraft.add(files); },
      remove: index => { claimWorkspace(); return imageDraft.remove(index); },
      cancel: () => { claimWorkspace(); return imageDraft.cancel(); },
    },
    listFileReferences,
    listSkills,
    projectTargetLabel: (() => {
      const target = visibleView?.snapshot.kind === 'agent' ? visibleView.snapshot.value.header.target : null;
      if (target) return `${target.label ?? target.targetId} (${target.kind === 'local' ? 'local' : `${target.username}@${target.host}:${target.port}`}) · ${target.kind === 'local' ? target.cwd ?? '' : target.rootPath ?? ''}`;
      return activeTerminal ? `${activeTerminal.title} (${activeTerminal.host === 'local' ? 'local' : `${activeTerminal.username}@${activeTerminal.host}:${activeTerminal.port}`})${skillRoot ? ` · ${skillRoot}` : ''}` : '';
    })(),
    skillsNeedsRoot: !visibleView && !openedSessionId && !skillRoot,
    skillsScopeKey: `${workspaceScopeKey}:${openedSessionId ?? "new"}:${skillNavigation}`,
    view: visibleView,
    answerQuestion: async (input) => {
      const current = viewRef.current?.pendingQuestion;
      if (!current || questionKey(current.identity) !== questionKey(input.identity)) throw new Error('Question is no longer active');
      await adapter.answerQuestion(input);
    },
    pendingNodes,
    composer,
    selectedProvider: sessionProviderResolution.provider,
    selectedPermission: visibleView ? (visibleView.snapshot.value.header.permissionMode === 'operator'
      ? 'fullAccess' : 'autoApproveReadOnly') : undefined,
    settingsBusy,
    selectModel: (provider) => changeSettings(async (sessionId) => {
      if (!adapter.selectModel) throw new Error('Model selection is unavailable');
      await adapter.selectModel(sessionId, provider);
    }),
    selectPermission: (mode) => changeSettings(async (sessionId) => {
      if (!adapter.setPermission) throw new Error('Permission selection is unavailable');
      await adapter.setPermission(sessionId, permissionMode(mode));
    }),
    providerLabel: routeSnapshot?.routes.find((route) => route.id === (
      visibleView?.snapshot.value.header.modelSelection?.routeId ?? provider?.id
    ))?.displayName ?? legacyProviders.find((item) => item.id === (
      visibleView?.snapshot.value.header.modelSelection?.routeId ?? provider?.id
    ))?.name ?? '',
    modelLabel: visibleView?.snapshot.value.header.modelSelection?.modelId ?? provider?.model ?? '',
    canStartAgent,
    agentUnavailableReason,
    announcement,
    navigation: { ...navigation, scrollAnchorBySession: scrollAnchorsRef.current },
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
    setDraft: (value) => { claimWorkspace(); dispatch({ type: 'draft.changed', value }); },
    setBusyPreference: (value) => dispatch({ type: 'preference.changed', value }),
    submit: (gesture, accelerated = false) => {
      claimWorkspace();
      const context = submissionContextRef.current;
      if (!canStartAgent) {
        setAnnouncement('sessionUnavailable');
        return;
      }
      if (imageDraft.draft?.images.length) {
        const decision = resolveAiSubmission({ sessionId: composer.sessionId, sessionStatus: composer.runtimeStatus,
          terminal: composer.terminal, waitingApproval: composer.waitingApproval, waitingQuestion: composer.waitingQuestion,
          hasProvider, canCreateSession: canStartAgent, draft: composer.draft, hasImages: true, gesture,
          accelerated, preferredBusyMode: composer.preferredBusyMode, submitting: imageDraft.busy });
        if (decision.kind !== 'submit') { imageDraft.reportError(decision.kind === 'reject' ? decision.reason : 'sessionUnavailable'); return; }
        // Use the same model for vision preflight and submission, even if navigation
        // changes the current Session while native creation is pending.
        let imageProvider: AiProviderConfig;
        try {
          imageProvider = currentProviderConfig();
          requireVision(imageProvider);
        }
        catch (e) { imageDraft.reportError(String(e)); return; }
        void imageDraft.send(async () => {
          const cold = await coldSkillSession.current;
          const sessionId = composer.sessionId ?? cold?.summary.id;
          const create = sessionId ? undefined : createInput(composerRef.current.draft.trim() || t('ai.workspace.images.add'));
          return { id: operationId(), sessionId: sessionId ?? create!.request.sessionId, mode: decision.mode, create };
        }, async value => {
          const op = value.operation!;
          if (op.create) {
            let existing: AiSessionView | null = null;
            try { existing = await adapter.open(op.sessionId); } catch { /* Not yet created. */ }
            if (!existing) await adapter.create(op.create);
            else if (existing.snapshot.kind !== 'agent'
              || !sameTarget(existing.snapshot.value.header.target, op.create.request.target)) {
              throw new Error('IMAGE_SESSION_TARGET_MISMATCH');
            }
          }
          await adapter.submit(op.sessionId, { clientOperationId: op.id, mode: op.mode, content: value.text,
            images: value.images, provider: imageProvider });
        }, value => {
          if (!mountedRef.current || submissionContextRef.current !== context) return;
          if (composerRef.current.draft === value.text) dispatch({ type: 'draft.changed', value: '' });
          setOpenedSessionId(value.operation!.sessionId);
          adoptDraft(value.operation!.sessionId);
          setNavigation(current => current.route.kind === 'conversation'
            ? { ...current, route: { kind: 'conversation', sessionId: value.operation!.sessionId } } : current);
        });
        return;
      }
      const clientOperationId = operationId();
      dispatch({
        type: 'submit.requested',
        gesture,
        accelerated,
        clientOperationId,
        now: now(),
        hasProvider,
        canCreateSession: canStartAgent,
      });
    },
    stop: () => dispatch({ type: 'stop.requested' }),
    retryFailedDraft: (failedDraftId) => {
      if (!canStartAgent) {
        setAnnouncement('sessionUnavailable');
        return;
      }
      const clientOperationId = operationId();
      dispatch({
        type: 'retry.requested',
        failedDraftId,
        clientOperationId,
        now: now(),
        hasProvider,
        canCreateSession: canStartAgent,
      });
    },
    dismissError: () => dispatch({ type: 'error.dismissed' }),
    openSessions,
    openSession,
    newSession,
    refreshSessions: () => { void refreshSessions(); },
    archiveSession,
    updateQueueItem: (item, content) => executeQueueMutation({
      type: 'update', itemId: item.id, content,
    }),
    removeQueueItem: (item) => executeQueueMutation({ type: 'remove', itemId: item.id }),
    steerQueueItem: (item) => executeQueueMutation({ type: 'steer', itemId: item.id }),
    reorderQueueLane: (lane, orderedItemIds) => executeQueueMutation({
      type: 'reorder', lane, orderedItemIds,
    }),
    retryQueueMutation: () => {
      if (queueMutation) executeQueueMutation(queueMutation.intent, true);
    },
    renameSession,
    back,
    openToolDetails,
    openArtifactDetails,
    saveScrollAnchor,
    completeRouteReturn: () => setNavigation((current) => ({ ...current, returnFocus: null })),
    approve: () => decideApproval('approve'),
    reject: () => decideApproval('reject'),
    loadOlder,
    loadArtifact,
  };
}
