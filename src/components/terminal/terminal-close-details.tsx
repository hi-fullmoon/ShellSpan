import { useSyncExternalStore } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';

function SessionCloseDetails({ session }: { session: TerminalSession }) {
  const { t } = useI18n();
  const liveSession = useTerminalStore((state) => state.sessions.find((item) => item.sessionId === session.sessionId)) ?? session;
  const lease = useSyncExternalStore(agentTerminalLeaseState.subscribe, () => agentTerminalLeaseState.get(session.sessionId));
  const statusKey = lease ? 'terminal.tab.closeStateAgent'
    : liveSession.status !== 'connected' ? `terminal.status.${liveSession.status}` as const
      : liveSession.integrationState !== 'ready' || liveSession.promptReady === undefined ? 'terminal.tab.closeStateUnknown'
        : liveSession.promptReady ? 'terminal.tab.closeStateReady' : 'terminal.tab.closeStateBusy';
  return (
    <li className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="break-all">{liveSession.title}</span>
      <span className="break-all text-xs text-app-text-soft">{liveSession.username}@{liveSession.host}:{liveSession.port}</span>
      <span className="text-xs text-app-text-soft">{t(statusKey)}</span>
    </li>
  );
}

export function TerminalCloseDetails({ sessions }: { sessions: readonly TerminalSession[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-3" data-terminal-close-details>
      {sessions.map((session) => <SessionCloseDetails key={session.sessionId} session={session} />)}
    </ul>
  );
}
