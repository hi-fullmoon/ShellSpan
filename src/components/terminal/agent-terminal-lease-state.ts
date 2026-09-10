import type { AgentTerminalLeaseEvent } from '@/types/agent-session';

export interface AgentTerminalLeaseView extends AgentTerminalLeaseEvent {
  readonly state: 'acquired';
  /** False while the same Agent turn continues between terminal commands. */
  readonly terminalOwned: boolean;
  readonly inputBlocked: boolean;
  readonly takeoverRequested: boolean;
  readonly takeoverFailed: boolean;
  readonly requestTakeover: () => void;
}

const leases = new Map<string, AgentTerminalLeaseView>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const agentTerminalLeaseState = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  get(sessionId: string | null): AgentTerminalLeaseView | undefined {
    return sessionId === null ? undefined : leases.get(sessionId);
  },

  set(lease: AgentTerminalLeaseView): void {
    leases.set(lease.sessionId, lease);
    notify();
  },

  update(
    sessionId: string,
    operationId: string,
    update: (lease: AgentTerminalLeaseView) => AgentTerminalLeaseView,
  ): boolean {
    const lease = leases.get(sessionId);
    if (!lease || lease.operationId !== operationId) return false;
    leases.set(sessionId, update(lease));
    notify();
    return true;
  },

  clear(sessionId: string, operationId: string): boolean {
    const lease = leases.get(sessionId);
    if (!lease || lease.operationId !== operationId) return false;
    leases.delete(sessionId);
    notify();
    return true;
  },

  clearAll(): void {
    if (leases.size === 0) return;
    leases.clear();
    notify();
  },
};
