import { create } from 'zustand';
import { agentTerminalLeaseState } from '@/components/terminal/agent-terminal-lease-state';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';
import { getTerminalGroups } from '@/components/terminal/terminal-split';
import { useAppStore } from './appStore';
import { useFocusStore } from './focusStore';
import { useTerminalStore, type TerminalSession } from './terminalStore';

type BroadcastMode = 'off' | 'splitGroup' | 'custom';

interface TerminalBroadcastState {
  mode: BroadcastMode;
  sessionIds: ReadonlySet<string>;
  configure: (mode: BroadcastMode, sessionIds?: readonly string[]) => void;
}

const OFF = { mode: 'off' as const, sessionIds: new Set<string>() };
const previousLeasedIds = new Set<string>();

function syncLeasedIds(extraIds: Iterable<string> = []): void {
  const candidateIds = new Set<string>(extraIds);
  for (const session of useTerminalStore.getState().sessions) {
    candidateIds.add(session.sessionId);
  }
  for (const id of useTerminalBroadcastStore.getState().sessionIds) {
    candidateIds.add(id);
  }
  previousLeasedIds.clear();
  for (const id of candidateIds) {
    if (agentTerminalLeaseState.get(id)) previousLeasedIds.add(id);
  }
}

export const useTerminalBroadcastStore = create<TerminalBroadcastState>((set) => ({
  ...OFF,
  configure: (mode, requested = []) => {
    const { workspaceSplit, sessions } = useTerminalStore.getState();
    const ids = mode === 'splitGroup'
      ? (workspaceSplit ? getTerminalGroups(workspaceSplit).map((group) => group.activeSessionId) : [])
      : requested;
    const sessionIds = new Set(ids.filter((id) => sessions.some((session) => (
      session.sessionId === id && session.status === 'connected' && !session.pendingConnection
    ))));
    set((state) => {
      if (mode === 'off' || sessionIds.size < 2) return state.mode === 'off' ? state : OFF;
      if (mode === state.mode && sessionIds.size === state.sessionIds.size
        && [...sessionIds].every((id) => state.sessionIds.has(id))) return state;
      return { mode, sessionIds };
    });
    syncLeasedIds(mode === 'off' || sessionIds.size < 2 ? [] : sessionIds);
  },
}));

useTerminalStore.subscribe((state, previous) => {
  const broadcast = useTerminalBroadcastStore.getState();
  if (broadcast.mode === 'off') {
    syncLeasedIds();
    return;
  }
  if (state.workspace !== previous.workspace) broadcast.configure('off');
  else if (state.sessions !== previous.sessions || state.workspaceSplit !== previous.workspaceSplit) {
    const unlocked = new Set(
      state.sessions
        .filter((session) => {
          const prior = previous.sessions.find((candidate) => candidate.sessionId === session.sessionId);
          return Boolean(prior && ((prior.readOnly && !session.readOnly)
            || (prior.foregroundHandoffActive && !session.foregroundHandoffActive)));
        })
        .map((session) => session.sessionId),
    );
    const remaining = [...broadcast.sessionIds].filter((id) => !unlocked.has(id));
    const removedAny = remaining.length !== broadcast.sessionIds.size;
    broadcast.configure(removedAny ? 'custom' : broadcast.mode, remaining);
  }
  syncLeasedIds();
});

agentTerminalLeaseState.subscribe(() => {
  const released = new Set<string>();
  for (const id of previousLeasedIds) {
    if (!agentTerminalLeaseState.get(id)) released.add(id);
  }
  const broadcast = useTerminalBroadcastStore.getState();
  syncLeasedIds();
  if (broadcast.mode === 'off' || released.size === 0) return;
  const remaining = [...broadcast.sessionIds].filter((id) => !released.has(id));
  if (remaining.length !== broadcast.sessionIds.size) {
    broadcast.configure('custom', remaining);
  }
});

export function canReceiveTerminalBroadcast(session: TerminalSession): boolean {
  return session.status === 'connected' && !session.pendingConnection && !session.readOnly
    && !session.foregroundHandoffActive && !terminalInputReadiness.isPreparing(session.sessionId)
    && !agentTerminalLeaseState.get(session.sessionId);
}

export function getTerminalBroadcastTargets(sourceId: string): string[] {
  if (useAppStore.getState().activeSection !== 'terminal') return [];
  const focus = useFocusStore.getState();
  if (focus.enabled && !focus.terminalOpen) return [];
  const { sessionIds } = useTerminalBroadcastStore.getState();
  if (!sessionIds.has(sourceId)) return [];
  const sessions = useTerminalStore.getState().sessions;
  const source = sessions.find((session) => session.sessionId === sourceId);
  if (!source || !canReceiveTerminalBroadcast(source)) return [];
  return sessions.filter((session) => session.sessionId !== sourceId && sessionIds.has(session.sessionId)
    && canReceiveTerminalBroadcast(session)).map(({ sessionId }) => sessionId);
}
