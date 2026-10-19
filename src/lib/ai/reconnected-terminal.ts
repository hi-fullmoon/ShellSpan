import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentSessionSnapshot } from '@/types/agent-session';

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
    || ['running', 'waiting'].includes(snapshot.status) || snapshot.uncertainNativeEffects
    || snapshot.header.capabilityScope
    || snapshot.inbox.nextTurn.length || snapshot.inbox.nextStep.length) return false;
  if (snapshot.recovery.status === 'available' || snapshot.recovery.status === 'required'
    || snapshot.recovery.status === 'reconciling'
    || snapshot.recovery.kind === 'executionInFlight'
    || snapshot.recovery.kind === 'authorizedBeforeExecute') return false;
  return terminal.status === 'connected';
}
