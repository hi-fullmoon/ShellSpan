import { expect, it } from 'vitest';
import { terminalExecutionRecovery } from '../terminal-execution-recovery';
import { terminalRecoveryView } from '@/test/fixtures/terminal-execution-recovery';

it('recognizes the recorded quarantine and its underlying control acknowledgement failure', () => {
  expect(terminalExecutionRecovery(terminalRecoveryView())).toEqual({
    needsStop: true, reasonKey: 'ai.workspace.terminalRecovery.confirmation',
  });
});

it('retains recovery after stopping and requires an explicit reconnect instead of replay', () => {
  const stopped = terminalRecoveryView('idle');
  expect(terminalExecutionRecovery(stopped)).toEqual({
    needsStop: false, reasonKey: 'ai.workspace.terminalRecovery.confirmation',
  });
  expect(terminalExecutionRecovery({ ...stopped, recovery: { status: 'none' } })).toBeNull();
});

it('does not revive historical diagnostics during a new execution or after completion', () => {
  const view = terminalRecoveryView();
  for (const status of ['running', 'completed'] as const) {
    expect(terminalExecutionRecovery({ ...view, status })).toBeNull();
  }
  expect(terminalExecutionRecovery({ ...view, summary: { ...view.summary, archived: true } })).toBeNull();
  expect(terminalExecutionRecovery({ ...view, statusReason: 'waitingForNetwork', recovery: { status: 'none' } })).toBeNull();
});
