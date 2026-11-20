import { create } from 'zustand';
import { agentTerminalLeaseState } from '@/components/terminal/agent-terminal-lease-state';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';
import { getTerminalGroups } from '@/components/terminal/terminal-split';
import { useAppStore } from './appStore';
import { useTerminalStore, type TerminalSession } from './terminalStore';

type BroadcastMode = 'off' | 'splitGroup' | 'custom';

interface TerminalBroadcastState {
  mode: BroadcastMode;
  sessionIds: ReadonlySet<string>;
  configure: (mode: BroadcastMode, sessionIds?: readonly string[]) => void;
}

const OFF = { mode: 'off' as const, sessionIds: new Set<string>() };

export const useTerminalBroadcastStore = create<TerminalBroadcastState>((set) => ({
  ...OFF,
  configure: (mode, requested = []) => {
    const { workspaceSplit, sessions } = useTerminalStore.getState();
    const ids = mode === 'splitGroup'
      ? (workspaceSplit ? getTerminalGroups(workspaceSplit).map((group) => group.activeSessionId) : [])
      : requested;
    const sessionIds = new Set(ids.filter((id) => sessions.some((session) => session.sessionId === id && session.status === 'connected')));
    set((state) => {
      if (mode === 'off' || sessionIds.size < 2) return state.mode === 'off' ? state : OFF;
      if (mode === state.mode && sessionIds.size === state.sessionIds.size
        && [...sessionIds].every((id) => state.sessionIds.has(id))) return state;
      return { mode, sessionIds };
    });
  },
}));

useTerminalStore.subscribe((state, previous) => {
  const broadcast = useTerminalBroadcastStore.getState();
  if (broadcast.mode === 'off') return;
  if (state.workspace !== previous.workspace) broadcast.configure('off');
  else if (state.sessions !== previous.sessions || state.workspaceSplit !== previous.workspaceSplit) {
    broadcast.configure(broadcast.mode, [...broadcast.sessionIds]);
  }
});

export function canReceiveTerminalBroadcast(session: TerminalSession): boolean {
  return session.status === 'connected' && !session.pendingConnection && !session.readOnly
    && !session.foregroundHandoffActive && !terminalInputReadiness.isPreparing(session.sessionId)
    && !agentTerminalLeaseState.get(session.sessionId);
}

export function getTerminalBroadcastTargets(sourceId: string): string[] {
  if (useAppStore.getState().activeSection !== 'terminal') return [];
  const { sessionIds } = useTerminalBroadcastStore.getState();
  if (!sessionIds.has(sourceId)) return [];
  const sessions = useTerminalStore.getState().sessions;
  const source = sessions.find((session) => session.sessionId === sourceId);
  if (!source || !canReceiveTerminalBroadcast(source)) return [];
  return sessions.filter((session) => session.sessionId !== sourceId && sessionIds.has(session.sessionId)
    && canReceiveTerminalBroadcast(session)).map(({ sessionId }) => sessionId);
}
