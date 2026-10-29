import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import { terminalLoginScopeKey } from './terminal-login-scope';

/** An explicit restore may verify a fresh connection even after ancestry was lost. */
export function canVerifyTerminalContinuation(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!snapshot || !terminal || terminal.status !== 'connected' || snapshot.archived
    || snapshot.header.subagent || snapshot.header.capabilityScope) return false;
  const target = snapshot.header.target;
  if (!target || !['local', 'remote'].includes(target.kind) || target.sessionId === terminal.sessionId) return false;
  const login = terminalLoginScopeKey(target);
  return login !== null && login === terminalLoginScopeKey(terminal);
}

/** Preserve the old transcript through a direct reconnect, including its connecting phase. */
export function isDirectReconnectedTerminal(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!snapshot || !terminal || snapshot.archived || snapshot.header.subagent) return false;
  const target = snapshot.header.target;
  if (!target || !['local', 'remote'].includes(target.kind)) return false;
  const replacesTarget = terminal.replacesSessionId === target.sessionId
    || Boolean(terminal.replacedSessionIds?.includes(target.sessionId));
  if (target.kind === 'local') return terminal.host === 'local' && terminal.port === 0
    && replacesTarget && terminal.sessionId !== target.sessionId;
  return replacesTarget
    && terminal.sessionId !== target.sessionId
    && terminal.profileId === target.profileId
    && terminal.host === target.host
    && terminal.port === target.port
    && terminal.username === target.username;
}

/** Rebind only settled conversations; reconnect never authorizes replay or pending work. */
export function canContinueOnReconnectedTerminal(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!isDirectReconnectedTerminal(snapshot, terminal) || !snapshot || !terminal
    || !terminal.brokerReplacedSessionIds?.includes(snapshot.header.target!.sessionId)
    || ['running', 'waiting'].includes(snapshot.status)
    || snapshot.header.capabilityScope
    || snapshot.inbox.nextTurn.length || snapshot.inbox.nextStep.length) return false;
  if (snapshot.recovery.kind !== 'executionInFlight' && (snapshot.recovery.status === 'available' || snapshot.recovery.status === 'required'
    || snapshot.recovery.status === 'reconciling'
    || snapshot.recovery.kind === 'authorizedBeforeExecute')) return false;
  return terminal.status === 'connected'
    && (snapshot.header.executionSurface !== 'boundTerminal'
      || (terminal.integrationState === 'ready' && terminal.promptReady === true));
}

export function terminalReconnectErrorKey(message: string):
  'ai.workspace.reconnectFailed' | 'ai.workspace.reconnectUnverified' | 'ai.workspace.reconnectUnsettled'
  | 'ai.workspace.reconnectSourceActive' {
  if (message.includes('TERMINAL_RECONNECT_SOURCE_ACTIVE')) return 'ai.workspace.reconnectSourceActive';
  if (/TERMINAL_RECONNECT_UNVERIFIED|verified replacement transport|TERMINAL_BROKER_(?:TRANSPORT_NOT_FOUND|STALE_TRANSPORT)/.test(message)) {
    return 'ai.workspace.reconnectUnverified';
  }
  if (/TERMINAL_RECONNECT_BUSY|settled|reconciled|execution lease/.test(message)) {
    return 'ai.workspace.reconnectUnsettled';
  }
  return 'ai.workspace.reconnectFailed';
}
