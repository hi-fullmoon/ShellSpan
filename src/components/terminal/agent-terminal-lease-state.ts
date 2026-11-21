import type { AgentTerminalLeaseEvent } from '@/types/agent-session';
import type { TerminalInputObservation } from '@/types';

export interface AgentTerminalLeaseView extends AgentTerminalLeaseEvent {
  readonly workspace?: 'terminal' | 'focus';
  readonly state: 'acquired';
  /** False while the same Agent turn continues between commands; input stays locked. */
  readonly terminalOwned: boolean;
  readonly waitingForUserAction?: boolean;
  readonly inputBlocked: boolean;
  readonly takeoverRequested: boolean;
  readonly takeoverFailed: boolean;
  readonly requestTakeover: () => void;
  readonly backendObservation?: {
    readonly terminalSessionId: string;
    readonly terminalGeneration: number;
    readonly value: TerminalInputObservation;
  };
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

  findByAgentSessionId(agentSessionId: string | null): AgentTerminalLeaseView | undefined {
    if (!agentSessionId) return undefined;
    for (const lease of leases.values()) {
      if (lease.agentSessionId === agentSessionId) return lease;
    }
    return undefined;
  },

  blocksUserInput(sessionId: string, foregroundHandoffActive = false): boolean {
    const lease = leases.get(sessionId);
    return !!lease && !lease.waitingForUserAction && !foregroundHandoffActive;
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

  observe(sessionId: string, terminalSessionId: string, terminalGeneration: number, observation: TerminalInputObservation): boolean {
    if (!Number.isSafeInteger(terminalGeneration) || terminalGeneration < 1
      || !Number.isSafeInteger(observation.snapshotSequence) || observation.snapshotSequence < 1) return false;
    const lease = leases.get(sessionId);
    const command = observation.activeCommand;
    if (!lease || command && (command.operationId !== lease.operationId
      || command.agentSessionId !== lease.agentSessionId || command.taskId !== lease.taskId)) return false;
    const previous = lease.backendObservation;
    if (previous && (previous.terminalSessionId !== terminalSessionId
      || terminalGeneration < previous.terminalGeneration
      || terminalGeneration === previous.terminalGeneration && observation.snapshotSequence <= previous.value.snapshotSequence)) return false;
    const phase = observation.activeCommand?.phase;
    const commandPhase = phase === 'submissionAttempted' || phase === 'running' ? 'running'
      : phase === 'preparing' || phase === 'typing' || phase === 'inputConfirmed' ? 'typing' : lease.commandPhase;
    // Facts only: no ownership, readiness, takeover, permission or input-lock
    // field is cleared or granted by a snapshot, even when every gate is false.
    leases.set(sessionId, { ...lease, commandPhase, backendObservation: { terminalSessionId, terminalGeneration, value: observation } });
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
