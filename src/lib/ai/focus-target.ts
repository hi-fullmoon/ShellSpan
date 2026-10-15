import type { AiSessionView } from './session-adapter';
import type { TerminalSession } from '@/stores/terminalStore';

/** Switching hosts creates a fresh execution session; approvals and authority never migrate. */
export function canSwitchFocusTarget(view: AiSessionView, terminal: TerminalSession | undefined, checkCurrent = false): boolean {
  const snapshot = view.snapshot.value;
  if (snapshot.header.subagent || view.status === 'running' || view.status === 'waiting'
    || view.pendingApproval || view.pendingQuestion || snapshot.uncertainNativeEffects
    || view.subagents?.some(agent => agent.status === 'running' || agent.status === 'waiting')
    || snapshot.inbox.nextStep.length || snapshot.inbox.nextTurn.length) return false;
  if (checkCurrent) return true;
  if (snapshot.header.executionSurface !== 'boundTerminal') return false;
  return terminal?.status === 'connected' && snapshot.header.target?.sessionId !== terminal.sessionId;
}
