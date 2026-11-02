import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalCommandPhase, TerminalInputObservation } from '@/types';
import en from '@/locales/en-US';
import zh from '@/locales/zh-CN';
import { agentTerminalLeaseState, type AgentTerminalLeaseView } from '../agent-terminal-lease-state';
import { agentTerminalCommandFeedback } from '../agent-terminal-command-feedback';

// Pure projection inputs. These are not native receipts or execution evidence.
function lease(): AgentTerminalLeaseView {
  return { sessionId: 'terminal', agentSessionId: 'agent', taskId: 'task', operationId: 'operation', acquiredAtUnixMs: 1,
    state: 'acquired', terminalOwned: true, inputBlocked: true, takeoverRequested: false, takeoverFailed: false,
    commandExecution: true, requestTakeover: () => { throw new Error('a read-only projection invoked takeover'); } };
}
function observation(phase: TerminalCommandPhase, sequence: number): TerminalInputObservation {
  return { snapshotSequence: sequence, commandInputPending: false, nativeRecoveryRequired: false, nativeClearPending: false,
    commandObservationUnavailable: false, activeCommand: { agentSessionId: 'agent', taskId: 'task', operationId: 'operation', commandId: 'command', phase, legacyState: 'submitted',
      legacyRevision: 1, mayHaveSubmitted: phase === 'submissionAttempted' || phase === 'running', fullInputConfirmed: phase === 'inputConfirmed',
      submissionIntentDurable: false, draftCleared: false, leaseGeneration: 2, sourceRevision: 1, safeActions: ['query'],
      sourceMayBeEnqueued: false, executionEvidence: 'unknown', noAutoReplay: true } };
}
afterEach(() => agentTerminalLeaseState.clearAll());

describe('terminal command snapshot projection', () => {
  it('uses the complete snapshot cursor even when legacy lifecycle revision is unchanged', () => {
    agentTerminalLeaseState.set(lease());
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, observation('typing', 2))).toBe(true);
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, observation('inputConfirmed', 3))).toBe(true);
    expect(agentTerminalLeaseState.get('terminal')?.backendObservation?.value.activeCommand?.fullInputConfirmed).toBe(true);
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, observation('typing', 2))).toBe(false);
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, observation('typing', 3))).toBe(false);
    expect(agentTerminalLeaseState.observe('terminal', 'other-logical', 1, observation('running', 4))).toBe(false);
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 0, observation('running', 5))).toBe(false);
    expect(agentTerminalLeaseState.get('terminal')?.backendObservation?.value.activeCommand?.phase).toBe('inputConfirmed');
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, observation('running', 6))).toBe(true);
    expect(agentTerminalCommandFeedback(agentTerminalLeaseState.get('terminal')!).label).toBe('terminal.agentLease.commandRunning');
  });
  it('never restores input or ownership from clear-looking snapshot flags', () => {
    agentTerminalLeaseState.set(lease());
    const clearLooking = observation('completed', 1);
    agentTerminalLeaseState.observe('terminal', 'logical', 1, clearLooking);
    const current = agentTerminalLeaseState.get('terminal')!;
    expect(current.inputBlocked).toBe(true);
    expect(current.terminalOwned).toBe(true);
    expect(current.takeoverRequested).toBe(false);
    expect(current.requestTakeover).toBeDefined();
  });
  it('retains recovery when the operation has retired and rejects a different operation', () => {
    agentTerminalLeaseState.set(lease());
    const recovery: TerminalInputObservation = { snapshotSequence: 1, commandInputPending: true, nativeRecoveryRequired: true,
      nativeClearPending: false, commandObservationUnavailable: false };
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, recovery)).toBe(true);
    expect(agentTerminalCommandFeedback(agentTerminalLeaseState.get('terminal')!).label).toBe('terminal.agentLease.recoveryRequired');
    const foreign = observation('running', 2);
    foreign.activeCommand = { ...foreign.activeCommand!, operationId: 'foreign' };
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, foreign)).toBe(false);
    foreign.activeCommand = { ...foreign.activeCommand!, operationId: 'operation', agentSessionId: 'foreign-agent' };
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, foreign)).toBe(false);
    foreign.activeCommand = { ...foreign.activeCommand!, agentSessionId: 'agent', taskId: 'foreign-task' };
    expect(agentTerminalLeaseState.observe('terminal', 'logical', 1, foreign)).toBe(false);
  });
  it('has readable bilingual feedback for every lifecycle phase and never calls a submission attempt running', () => {
    const phases: TerminalCommandPhase[] = ['awaitingReady', 'preparing', 'typing', 'inputConfirmed', 'submissionAttempted',
      'running', 'completed', 'cancelRequested', 'cancelled', 'failed', 'uncertain', 'recoveryRequired'];
    for (const phase of phases) {
      const value = { ...lease(), backendObservation: { terminalSessionId: 'logical', terminalGeneration: 1, value: observation(phase, 1) } };
      const feedback = agentTerminalCommandFeedback(value);
      for (const key of [feedback.label, feedback.hint]) {
        expect(zh).toHaveProperty(key);
        expect(en).toHaveProperty(key);
      }
      if (phase !== 'running') expect(feedback.label).not.toBe('terminal.agentLease.commandRunning');
    }
  });
});
