import { create } from 'zustand';
import { getTerminalGroups, pruneEmptyTerminalGroups, replaceTerminalSessionId, type TerminalLayoutNode, type TerminalSplitState } from '@/components/terminal/terminal-split';
import type {
  ClosedEvent,
  SessionStatus,
  SessionSummary,
  SessionPtyInfo,
  StatusEvent,
  TerminalBrokerIntegrationState,
  TerminalIntegrationStateEvent,
} from '@/types';
import { generateId } from '@/lib/utils';
import { useAppStore } from './appStore';
import { useProfileStore } from './profileStore';
import { formatTabTitle, resolveTabTitleValues } from '@/lib/terminal/tab-title';

export interface TerminalSession {
  sessionId: string;
  /** Ephemeral broker identity; deliberately excluded from TerminalWorkspaceSession. */
  terminalSessionId?: string;
  terminalGeneration?: number;
  /** Live backend metadata; excluded from persisted workspaces. */
  ptyInfo?: SessionPtyInfo;
  integrationState?: TerminalBrokerIntegrationState;
  integrationReason?: string;
  integrationStateRevision?: number;
  promptReady?: boolean;
  title: string;
  baseTitle?: string;
  manualTitle?: string;
  titleIndex?: number;
  host: string;
  port: number;
  username: string;
  status: SessionStatus;
  statusMessage?: string;
  closed?: ClosedEvent;
  profileId?: string;
  pinned?: boolean;
  color?: string;
  reconnecting?: boolean;
  pendingConnection?: boolean;
  /** Ephemeral predecessor used to keep split layout stable while a connection id changes. */
  replacesSessionId?: string;
  /** Bounded, in-memory reconnect ancestry; never used as backend authorization. */
  replacedSessionIds?: readonly string[];
  /** Ancestry confirmed by consecutive broker generations in this process. */
  brokerReplacedSessionIds?: readonly string[];
}

export interface PendingTerminalConnection {
  title: string;
  host: string;
  port: number;
  username: string;
  profileId?: string;
  insertAfterId?: string;
  pinned?: boolean;
  color?: string;
}

export type TerminalWorkspaceSession = Pick<
  TerminalSession,
  'sessionId' | 'title' | 'baseTitle' | 'manualTitle' | 'titleIndex' | 'host' | 'port' | 'username' | 'profileId' | 'pinned' | 'color'
>;

const sortSessions = (sessions: TerminalSession[]): TerminalSession[] => {
  const pinned = sessions.filter((session) => session.pinned);
  const unpinned = sessions.filter((session) => !session.pinned);
  return [...pinned, ...unpinned];
};

const brokerIdentity = (
  summary: SessionSummary,
): Pick<TerminalSession, 'terminalSessionId' | 'terminalGeneration'> | Record<string, never> => {
  const terminalSessionId = summary.terminalSessionId;
  const terminalGeneration = summary.terminalGeneration;
  return terminalSessionId && terminalGeneration
    ? { terminalSessionId, terminalGeneration }
    : {};
};

export type TerminalWorkspace = 'terminal' | 'focus';

interface WorkspaceView {
  activeSessionId: string | null;
  order: string[];
  split: TerminalSplitState | null;
  focusedSlot: string;
}

function reconcileWorkspace(view: WorkspaceView, sessions: TerminalSession[]): WorkspaceView {
  const available = new Set(sessions.map(session => session.sessionId));
  const replacements = new Map(sessions.filter(session => session.replacesSessionId)
    .map(session => [session.replacesSessionId!, session.sessionId]));
  const resolve = (id: string): string => replacements.get(id) ?? id;
  const order = [...new Set([...view.order.map(resolve).filter(id => available.has(id)), ...available])];
  const selected = view.activeSessionId ? resolve(view.activeSessionId) : null;
  const activeSessionId = selected && available.has(selected) ? selected : order[0] ?? null;
  let layout: TerminalLayoutNode | null = view.split;
  for (const [before, after] of replacements) {
    if (layout) layout = replaceTerminalSessionId(layout, before, after);
  }
  const prune = (node: TerminalLayoutNode): TerminalLayoutNode => node.kind === 'split'
    ? { ...node, first: prune(node.first), second: prune(node.second) }
    : { ...node, sessionIds: node.sessionIds.filter(id => available.has(id)),
      activeSessionId: available.has(node.activeSessionId) ? node.activeSessionId
        : node.sessionIds.find(id => available.has(id)) ?? '' };
  layout = layout ? pruneEmptyTerminalGroups(prune(layout)) : null;
  if (layout) {
    const groups = getTerminalGroups(layout);
    const assigned = new Set(groups.flatMap(group => group.sessionIds));
    const group = groups.find(item => item.id === view.focusedSlot) ?? groups[0];
    // New shared connections become available without replacing the workspace's selection.
    group.sessionIds = [...group.sessionIds, ...order.filter(id => !assigned.has(id))];
  }
  const split = layout?.kind === 'split' ? layout : null;
  const focusedSlot = split && getTerminalGroups(split).some(group => group.id === view.focusedSlot)
    ? view.focusedSlot : split ? getTerminalGroups(split)[0].id : 'first';
  return { activeSessionId, order, split, focusedSlot };
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  workspace: TerminalWorkspace;
  workspaceViews: Partial<Record<TerminalWorkspace, WorkspaceView>>;
  workspaceSplit: TerminalSplitState | null;
  workspaceFocusedSlot: string;
  switchWorkspace: (workspace: TerminalWorkspace) => void;
  setWorkspaceSplit: (update: TerminalSplitState | null | ((current: TerminalSplitState | null) => TerminalSplitState | null)) => void;
  setWorkspaceFocusedSlot: (slot: string) => void;
  restoredLayout: TerminalLayoutNode | null;
  beginConnectionAttempt: (
    pending: PendingTerminalConnection,
    attemptId?: string,
  ) => string;
  resolveConnectionAttempt: (
    attemptId: string,
    summary: SessionSummary,
    profileId?: string,
  ) => void;
  endConnectionAttempt: (attemptId: string) => void;
  addSession: (
    summary: SessionSummary,
    profileId?: string,
    options?: {
      insertAfterId?: string;
      pinned?: boolean;
      color?: string;
      replacesSessionId?: string;
    },
  ) => void;
  addRestoredSessions: (
    sessions: TerminalWorkspaceSession[],
    layout?: TerminalLayoutNode | null,
  ) => void;
  removeSession: (sessionId: string) => void;
  reconnectSession: (
    oldSessionId: string,
    summary: SessionSummary,
    profileId?: string,
  ) => void;
  setReconnecting: (sessionId: string, reconnecting: boolean) => void;
  reorderSessions: (activeId: string, insertIndex: number) => void;
  setActiveSession: (sessionId: string | null) => void;
  setRestoredLayout: (layout: TerminalLayoutNode | null) => void;
  clearRestoredLayout: () => void;
  setStatus: (sessionId: string, event: StatusEvent) => void;
  setClosed: (sessionId: string, event: ClosedEvent) => void;
  setIntegrationState: (event: TerminalIntegrationStateEvent) => void;
  updateTitle: (sessionId: string, title: string) => void;
  resetTitle: (sessionId: string) => void;
  togglePin: (sessionId: string) => void;
  setTabColor: (sessionId: string, color?: string) => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  sessions: [],
  activeSessionId: null,
  workspace: 'terminal',
  workspaceViews: {},
  workspaceSplit: null,
  workspaceFocusedSlot: 'first',
  switchWorkspace: (workspace) => set(state => {
    if (state.workspace === workspace) return state;
    const current: WorkspaceView = { activeSessionId: state.activeSessionId,
      order: state.sessions.map(session => session.sessionId), split: state.workspaceSplit,
      focusedSlot: state.workspaceFocusedSlot };
    const next = reconcileWorkspace(state.workspaceViews[workspace] ?? {
      activeSessionId: state.activeSessionId, order: current.order, split: null, focusedSlot: 'first',
    }, state.sessions);
    const byId = new Map(state.sessions.map(session => [session.sessionId, session]));
    return { workspace, workspaceViews: { ...state.workspaceViews, [state.workspace]: current },
      sessions: sortSessions(next.order.map(id => byId.get(id)!)), activeSessionId: next.activeSessionId,
      workspaceSplit: next.split, workspaceFocusedSlot: next.focusedSlot };
  }),
  setWorkspaceSplit: (update) => set(state => ({ workspaceSplit: typeof update === 'function' ? update(state.workspaceSplit) : update })),
  setWorkspaceFocusedSlot: (workspaceFocusedSlot) => set({ workspaceFocusedSlot }),
  restoredLayout: null,
  beginConnectionAttempt: (pending, attemptId = `pending-${generateId()}`) => {
    set((state) => {
      const existingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (existingIndex >= 0) {
        const sessions = [...state.sessions];
        const existing = sessions[existingIndex];
        sessions[existingIndex] = {
          ...existing,
          title: pending.title,
          baseTitle: pending.title,
          host: pending.host,
          port: pending.port,
          username: pending.username,
          profileId: pending.profileId ?? existing.profileId,
          pinned: pending.pinned ?? existing.pinned,
          color: pending.color ?? existing.color,
        };
        return { sessions, activeSessionId: attemptId };
      }

      const pendingSession: TerminalSession = {
        sessionId: attemptId,
        title: pending.title,
        host: pending.host,
        port: pending.port,
        username: pending.username,
        status: 'connecting',
        profileId: pending.profileId,
        pinned: pending.pinned,
        color: pending.color,
        pendingConnection: true,
      };
      const sourceIndex = pending.insertAfterId
        ? state.sessions.findIndex((session) => session.sessionId === pending.insertAfterId)
        : -1;
      const sessions = [...state.sessions];
      if (sourceIndex >= 0) {
        sessions.splice(sourceIndex + 1, 0, pendingSession);
      } else {
        sessions.push(pendingSession);
      }
      return {
        sessions: sortSessions(sessions),
        activeSessionId: attemptId,
      };
    });
    return attemptId;
  },
  resolveConnectionAttempt: (attemptId, summary, profileId) =>
    set((state) => {
      const pendingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (pendingIndex < 0) return state;

      const pending = state.sessions[pendingIndex];
      const sessions = [...state.sessions];
      sessions[pendingIndex] = {
        sessionId: summary.sessionId,
        ...brokerIdentity(summary),
        ptyInfo: summary.ptyInfo,
        title: summary.title,
        baseTitle: summary.title,
        manualTitle: pending.manualTitle,
        titleIndex: pending.titleIndex,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId: profileId ?? pending.profileId,
        pinned: pending.pinned,
        color: pending.color,
        replacesSessionId: attemptId,
      };
      return {
        sessions,
        activeSessionId: state.activeSessionId === attemptId
          ? summary.sessionId
          : state.activeSessionId,
      };
    }),
  endConnectionAttempt: (attemptId) =>
    set((state) => {
      const pendingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (pendingIndex < 0) return state;
      const sessions = state.sessions.filter((session) => session.sessionId !== attemptId);
      return {
        sessions,
        activeSessionId: state.activeSessionId === attemptId
          ? sessions[sessions.length - 1]?.sessionId ?? null
          : state.activeSessionId,
      };
    }),
  addSession: (summary, profileId, options) =>
    set((state) => {
      const exists = state.sessions.some(
        (session) => session.sessionId === summary.sessionId,
      );
      if (exists) return state;

      const sourceIndex = options?.insertAfterId
        ? state.sessions.findIndex(
            (session) => session.sessionId === options.insertAfterId,
          )
        : -1;
      const newSession: TerminalSession = {
        sessionId: summary.sessionId,
        ...brokerIdentity(summary),
        ptyInfo: summary.ptyInfo,
        title: summary.title,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId,
        pinned: options?.pinned,
        color: options?.color,
        replacesSessionId: options?.replacesSessionId,
      };

      let sessions: TerminalSession[];
      if (sourceIndex >= 0) {
        sessions = [...state.sessions];
        sessions.splice(sourceIndex + 1, 0, newSession);
        sessions = sortSessions(sessions);
      } else {
        sessions = sortSessions([...state.sessions, newSession]);
      }

      return {
        sessions,
        activeSessionId: summary.sessionId,
      };
    }),
  addRestoredSessions: (restored, layout) =>
    set((state) => {
      if (state.sessions.length > 0 || restored.length === 0) return state;
      const sessions = restored.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        baseTitle: session.baseTitle ?? session.title,
        manualTitle: session.manualTitle ?? (session.baseTitle === undefined
          && session.title !== (useProfileStore.getState().getProfile(session.profileId ?? '')?.name || session.host)
          ? session.title : undefined),
        titleIndex: session.titleIndex,
        host: session.host,
        port: session.port,
        username: session.username,
        profileId: session.profileId,
        pinned: session.pinned,
        color: session.color,
        status: 'disconnected' as const,
        closed: {
          sessionId: session.sessionId,
          reasonKind: 'transport_disconnect' as const,
          retryable: true,
        },
      }));
      return {
        sessions,
        activeSessionId: sessions[0]?.sessionId ?? null,
        restoredLayout: layout ?? null,
      };
    }),
  setRestoredLayout: (layout) => set({ restoredLayout: layout }),
  clearRestoredLayout: () => set({ restoredLayout: null }),
  removeSession: (sessionId) =>
    set((state) => {
      if (!state.sessions.some((session) => session.sessionId === sessionId)) {
        return state;
      }
      const sessions = state.sessions.filter(
        (session) => session.sessionId !== sessionId,
      );
      const activeSessionId =
        state.activeSessionId === sessionId
          ? sessions[sessions.length - 1]?.sessionId ?? null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    }),
  reconnectSession: (oldSessionId, summary, profileId) =>
    set((state) => {
      const oldIndex = state.sessions.findIndex(
        (session) => session.sessionId === oldSessionId,
      );
      // The old session may have been closed while the reconnect was in flight;
      // never resurrect it.
      if (oldIndex === -1) return state;
      const old = state.sessions[oldIndex];
      const brokerContinued = Boolean(old.terminalSessionId
        && summary.terminalSessionId === old.terminalSessionId
        && summary.terminalGeneration === (old.terminalGeneration ?? 0) + 1);
      const newSession: TerminalSession = {
        sessionId: summary.sessionId,
        ...brokerIdentity(summary),
        ptyInfo: summary.ptyInfo,
        title: old.title ?? summary.title,
        baseTitle: old.baseTitle ?? old.title,
        manualTitle: old.manualTitle,
        titleIndex: old.titleIndex,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId,
        pinned: old.pinned,
        color: old.color,
        reconnecting: true,
        replacesSessionId: oldSessionId,
        replacedSessionIds: [...(old.replacedSessionIds ?? []), oldSessionId].slice(-32),
        brokerReplacedSessionIds: brokerContinued
          ? [...(old.brokerReplacedSessionIds ?? []), oldSessionId].slice(-32) : [],
      };
      const sessions = state.sessions.filter(
        (session) => session.sessionId !== oldSessionId,
      );
      sessions.splice(oldIndex, 0, newSession);
      return {
        sessions: sortSessions(sessions),
        activeSessionId: state.activeSessionId === oldSessionId
          ? summary.sessionId
          : state.activeSessionId,
      };
    }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  setReconnecting: (sessionId, reconnecting) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, reconnecting };
      });
      return changed ? { sessions } : state;
    }),
  reorderSessions: (activeId, insertIndex) =>
    set((state) => {
      const fromIndex = state.sessions.findIndex(
        (session) => session.sessionId === activeId,
      );
      if (fromIndex === -1) return state;
      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      const clampedIndex = Math.max(0, Math.min(insertIndex, sessions.length));
      sessions.splice(clampedIndex, 0, moved);
      return { sessions: sortSessions(sessions) };
    }),
  setStatus: (sessionId, event) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return {
          ...session,
          status: event.status,
          statusMessage: event.message,
          pendingConnection: event.status === 'error' ? false : session.pendingConnection,
          reconnecting:
            event.status === 'connecting' ? session.reconnecting : false,
        };
      });
      return changed ? { sessions } : state;
    }),
  setClosed: (sessionId, event) =>
    set((state) => {
      let changed = false;
      const sessions: TerminalSession[] = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return {
          ...session,
          closed: event,
          status: event.reasonKind === 'error' ? 'error' : 'disconnected',
        };
      });
      return changed ? { sessions } : state;
    }),
  setIntegrationState: (event) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== event.sessionId) return session;
        if (
          session.terminalSessionId
          && (session.terminalSessionId !== event.terminalSessionId
            || session.terminalGeneration !== event.terminalGeneration)
        ) return session;
        const sameTerminalGeneration = session.terminalSessionId === event.terminalSessionId
          && session.terminalGeneration === event.terminalGeneration;
        if (
          sameTerminalGeneration
          && session.integrationStateRevision !== undefined
          && event.integrationStateRevision <= session.integrationStateRevision
        ) return session;
        if (
          session.integrationState === event.state
          && session.integrationReason === event.reason
          && session.integrationStateRevision === event.integrationStateRevision
          && session.promptReady === event.promptReady
        ) return session;
        changed = true;
        return {
          ...session,
          terminalSessionId: event.terminalSessionId,
          terminalGeneration: event.terminalGeneration,
          integrationState: event.state,
          integrationReason: event.reason,
          integrationStateRevision: event.integrationStateRevision,
          promptReady: event.promptReady,
        };
      });
      return changed ? { sessions } : state;
    }),
  updateTitle: (sessionId, title) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, title, manualTitle: title };
      });
      return changed ? { sessions } : state;
    }),
  resetTitle: (sessionId) => set((state) => ({
    sessions: state.sessions.map((session) => session.sessionId === sessionId
      ? { ...session, manualTitle: undefined } : session),
  })),
  togglePin: (sessionId) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, pinned: !session.pinned };
      });
      return changed ? { sessions: sortSessions(sessions) } : state;
    }),
  setTabColor: (sessionId, color) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, color };
      });
      return changed ? { sessions } : state;
    }),
}));

function refreshTabTitles(): void {
  const { sessions } = useTerminalStore.getState();
  const preferences = useAppStore.getState();
  const profiles = useProfileStore.getState();
  const identity = (session: TerminalSession) => session.profileId ?? `${session.username}@${session.host}:${session.port}`;
  const maxima = new Map<string, number>();
  for (const session of sessions) {
    maxima.set(identity(session), Math.max(maxima.get(identity(session)) ?? 0, session.titleIndex ?? 0));
  }
  let changed = false;
  const next = sessions.map((session) => {
    const key = identity(session);
    const index = session.titleIndex ?? (maxima.get(key) ?? 0) + 1;
    maxima.set(key, Math.max(maxima.get(key) ?? 0, index));
    const baseTitle = session.baseTitle ?? session.title;
    const profile = session.profileId ? profiles.getProfile(session.profileId) : undefined;
    const template = (session.profileId && preferences.terminalTabTitleOverrides[session.profileId]) || preferences.terminalTabTitleTemplate;
    const custom = session.profileId && preferences.terminalTabTitleOverrides[session.profileId] !== undefined
      ? preferences.terminalTabTitleCustomOverrides[session.profileId] === true
      : preferences.terminalTabTitleCustom;
    const title = session.manualTitle ?? formatTabTitle(template,
      resolveTabTitleValues({ ...session, titleIndex: index }, profile), custom);
    if (title === session.title && baseTitle === session.baseTitle && index === session.titleIndex) return session;
    changed = true;
    return { ...session, title, baseTitle, titleIndex: index };
  });
  if (changed) useTerminalStore.setState({ sessions: next });
}

useTerminalStore.subscribe((state, previous) => {
  if (state.sessions !== previous.sessions) {
    if (state.workspace === previous.workspace && Object.keys(state.workspaceViews).length > 0) {
      const workspaceViews = { ...state.workspaceViews };
      for (const workspace of ['terminal', 'focus'] as const) {
        const view = workspaceViews[workspace];
        if (workspace !== state.workspace && view) workspaceViews[workspace] = reconcileWorkspace(view, state.sessions);
      }
      useTerminalStore.setState({ workspaceViews });
    }
    refreshTabTitles();
  }
});
useAppStore.subscribe((state, previous) => {
  if (state.terminalTabTitleTemplate !== previous.terminalTabTitleTemplate
    || state.terminalTabTitleCustom !== previous.terminalTabTitleCustom
    || state.terminalTabTitleCustomOverrides !== previous.terminalTabTitleCustomOverrides
    || state.terminalTabTitleOverrides !== previous.terminalTabTitleOverrides) refreshTabTitles();
});
useProfileStore.subscribe((state, previous) => {
  if (state.profiles !== previous.profiles) refreshTabTitles();
});
