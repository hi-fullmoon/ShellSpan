import type { TerminalSession } from '@/stores/terminalStore';
import type { AgentSessionSnapshot } from '@/types/agent-session';

/** Preserve the old transcript through a direct reconnect, including its connecting phase. */
export function isDirectReconnectedTerminal(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!snapshot || !terminal || snapshot.archived || snapshot.header.subagent) return false;
  const target = snapshot.header.target;
  if (!target || target.kind !== 'remote' || !target.profileId || !target.host
    || !target.port || !target.username || !snapshot.header.goal.trim()
    || snapshot.header.goal.length > 16_000) return false;
  if (target.cwd || target.rootPath || target.localRoot) return false;
  return terminal.replacesSessionId === target.sessionId
    && terminal.sessionId !== target.sessionId
    && terminal.profileId === target.profileId
    && terminal.host === target.host
    && terminal.port === target.port
    && terminal.username === target.username;
}

/** A replacement terminal is a new trust boundary, never a mutation of the old Agent target. */
export function canContinueOnReconnectedTerminal(
  snapshot: AgentSessionSnapshot | null | undefined,
  terminal: TerminalSession | null | undefined,
): boolean {
  if (!isDirectReconnectedTerminal(snapshot, terminal) || !snapshot || !terminal
    || !snapshot.ended || snapshot.status !== 'failed' || snapshot.uncertainNativeEffects) return false;
  if (snapshot.recovery.status === 'available' || snapshot.recovery.status === 'required'
    || snapshot.recovery.status === 'reconciling'
    || snapshot.recovery.kind === 'executionInFlight'
    || snapshot.recovery.kind === 'authorizedBeforeExecute') return false;
  return terminal.status === 'connected';
}
