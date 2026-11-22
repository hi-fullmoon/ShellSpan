import { useMemo, useSyncExternalStore } from 'react';
import { agentTerminalLeaseState } from '@/components/terminal/agent-terminal-lease-state';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import {
  canInsertIntoTerminal,
  sanitizeSingleLineTerminalCommand,
  terminalSessionDisplayName,
} from '@/lib/ai/terminal-insert';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';

export interface TerminalInsertTarget {
  readonly sessionId: string;
  readonly targetName: string;
}

export function insertCommandIntoTerminal(sessionId: string, code: string): boolean {
  const sanitized = sanitizeSingleLineTerminalCommand(code);
  if (!sanitized) return false;
  const session = useTerminalStore.getState().sessions.find((item) => item.sessionId === sessionId);
  const controller = terminalRegistry.get(sessionId);
  const ready = canInsertIntoTerminal({
    session,
    preparing: terminalInputReadiness.isPreparing(sessionId),
    blockedByAgent: agentTerminalLeaseState.blocksUserInput(sessionId, session?.foregroundHandoffActive),
    hasTerminal: Boolean(controller?.terminal),
  });
  if (!ready || !controller?.terminal) return false;
  useTerminalStore.getState().setActiveSession(sessionId);
  useAppStore.getState().setActiveSection('terminal');
  controller.terminal.focus();
  controller.terminal.paste(sanitized);
  return true;
}

export function useTerminalInsertTarget(
  targetSessionId: string | null | undefined,
): TerminalInsertTarget | null {
  const session = useTerminalStore((state) => (
    targetSessionId ? state.sessions.find((item) => item.sessionId === targetSessionId) ?? null : null
  ));
  const sessionId = session?.sessionId ?? null;
  const foregroundHandoffActive = session?.foregroundHandoffActive;
  const blockedByAgent = useSyncExternalStore(
    agentTerminalLeaseState.subscribe,
    () => (sessionId ? agentTerminalLeaseState.blocksUserInput(sessionId, foregroundHandoffActive) : false),
  );
  const preparing = useSyncExternalStore(
    terminalInputReadiness.subscribe,
    () => (sessionId ? terminalInputReadiness.isPreparing(sessionId) : false),
  );
  const targetName = session ? terminalSessionDisplayName(session) : '';
  const available = Boolean(sessionId && canInsertIntoTerminal({ session, preparing, blockedByAgent }));
  return useMemo(
    () => (available && sessionId ? { sessionId, targetName } : null),
    [available, sessionId, targetName],
  );
}
