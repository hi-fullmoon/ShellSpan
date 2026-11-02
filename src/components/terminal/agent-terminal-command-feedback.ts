import type { AgentTerminalLeaseView } from './agent-terminal-lease-state';
import type { LocaleKey } from '@/locales';

/** Presentation keys only. This projection never acknowledges or grants input. */
export function agentTerminalCommandFeedback(lease: AgentTerminalLeaseView): { label: LocaleKey; hint: LocaleKey } {
  const observation = lease.backendObservation?.value;
  if (observation?.nativeRecoveryRequired || observation?.commandObservationUnavailable) {
    return { label: 'terminal.agentLease.recoveryRequired', hint: 'terminal.agentLease.recoveryRequiredHint' };
  }
  switch (observation?.activeCommand?.phase) {
    case 'awaitingReady':
    case 'preparing':
      return { label: 'terminal.agentLease.commandPending', hint: 'terminal.agentLease.commandPendingHint' };
    case 'typing':
      return { label: 'terminal.agentLease.commandTyping', hint: 'terminal.agentLease.commandTypingHint' };
    case 'inputConfirmed':
      return { label: 'terminal.agentLease.inputConfirmed', hint: 'terminal.agentLease.inputConfirmedHint' };
    case 'submissionAttempted':
      return { label: 'terminal.agentLease.submitting', hint: 'terminal.agentLease.submittingHint' };
    case 'cancelRequested':
      return { label: 'terminal.agentLease.stopPending', hint: 'terminal.agentLease.stopPendingHint' };
    case 'uncertain':
    case 'recoveryRequired':
      return { label: 'terminal.agentLease.recoveryRequired', hint: 'terminal.agentLease.recoveryRequiredHint' };
    case 'completed':
      return { label: 'terminal.agentLease.commandEnded', hint: 'terminal.agentLease.inputBlockedHint' };
    case 'cancelled':
      return { label: 'terminal.agentLease.commandStopped', hint: 'terminal.agentLease.inputBlockedHint' };
    case 'failed':
      return { label: 'terminal.agentLease.commandPreparationFailed', hint: 'terminal.agentLease.inputBlockedHint' };
    case 'running':
      return { label: 'terminal.agentLease.commandRunning', hint: 'terminal.agentLease.inputLocked' };
    default:
      if (lease.commandPhase === 'typing') return { label: 'terminal.agentLease.commandTyping', hint: 'terminal.agentLease.commandTypingHint' };
      if (lease.commandExecution && !lease.commandPhase) return { label: 'terminal.agentLease.commandPending', hint: 'terminal.agentLease.commandPendingHint' };
      return { label: 'terminal.agentLease.commandRunning', hint: 'terminal.agentLease.inputLocked' };
  }
}
