import { describe, expect, it } from 'vitest';
import { canContinueOnReconnectedTerminal, isDirectReconnectedTerminal } from '../reconnected-terminal';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import type { TerminalSession } from '@/stores/terminalStore';

const snapshot: AgentSessionSnapshot = {
  header: {
    sessionId: 'agent-old', taskId: 'task-old', goal: 'Finish the deployment',
    target: {
      kind: 'remote', targetId: 'terminal-old', sessionId: 'old', profileId: 'profile-1',
      host: 'example.com', port: 22, username: 'user',
    },
    executionSurface: 'direct', createdAtUnixMs: 1,
  },
  status: 'failed', ended: true, archived: false, eventCount: 10,
  surface: { generation: 0, messages: [] },
  inbox: { nextTurn: [], nextStep: [] },
  task: { evidence: [] },
  recovery: { kind: 'terminal', status: 'none', summary: '', lastCommittedSeq: 9 },
};

const terminal: TerminalSession = {
  sessionId: 'new', replacesSessionId: 'old', profileId: 'profile-1',
  title: 'Remote', host: 'example.com', port: 22, username: 'user', status: 'connected',
};

describe('reconnected terminal Agent continuation', () => {
  it('offers a fresh continuation only for the direct replacement of the same SSH target', () => {
    expect(canContinueOnReconnectedTerminal(snapshot, terminal)).toBe(true);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, host: 'other.example.com' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, profileId: 'other' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, replacesSessionId: 'unrelated' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, status: 'disconnected' })).toBe(false);
  });

  it('does not offer a new task while a write effect needs reconciliation or the root is live', () => {
    expect(canContinueOnReconnectedTerminal({
      ...snapshot,
      recovery: { ...snapshot.recovery, status: 'required', kind: 'executionInFlight' },
    }, terminal)).toBe(false);
    expect(canContinueOnReconnectedTerminal({ ...snapshot, uncertainNativeEffects: true }, terminal)).toBe(false);
    expect(isDirectReconnectedTerminal({ ...snapshot, status: 'running', ended: false }, {
      ...terminal, status: 'connecting',
    })).toBe(true);
    expect(canContinueOnReconnectedTerminal({ ...snapshot, ended: false }, terminal)).toBe(false);
    expect(canContinueOnReconnectedTerminal({
      ...snapshot,
      header: { ...snapshot.header, target: { ...snapshot.header.target!, rootPath: '/srv' } },
    }, terminal)).toBe(false);
  });
});
