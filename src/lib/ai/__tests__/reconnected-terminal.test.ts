import { describe, expect, it } from 'vitest';
import { canContinueOnReconnectedTerminal, canVerifyTerminalContinuation, isDirectReconnectedTerminal, terminalReconnectErrorKey } from '../reconnected-terminal';
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
  brokerReplacedSessionIds: ['old'],
  title: 'Remote', host: 'example.com', port: 22, username: 'user', status: 'connected',
};

describe('reconnected terminal Agent continuation', () => {
  it('offers explicit verification when a fresh same-login connection has no ancestry', () => {
    const fresh = { ...terminal, profileId: 'recreated-profile', replacesSessionId: undefined, brokerReplacedSessionIds: undefined };
    expect(canVerifyTerminalContinuation(snapshot, fresh)).toBe(true);
    expect(canContinueOnReconnectedTerminal(snapshot, fresh)).toBe(false);
    expect(canVerifyTerminalContinuation(snapshot, { ...fresh, host: 'other.example.com' })).toBe(false);
    expect(canVerifyTerminalContinuation(snapshot, { ...fresh, username: 'other-user' })).toBe(false);
    expect(canVerifyTerminalContinuation(snapshot, { ...fresh, port: 2222 })).toBe(false);
    expect(canVerifyTerminalContinuation(snapshot, { ...fresh, status: 'disconnected' })).toBe(false);
    expect(canVerifyTerminalContinuation(snapshot, { ...fresh, sessionId: 'old' })).toBe(false);
    expect(canVerifyTerminalContinuation({ ...snapshot, archived: true }, fresh)).toBe(false);
  });

  it('does not mistake verification eligibility for authorization to resume uncertain execution', () => {
    const unsettled = { ...snapshot, uncertainNativeEffects: true };
    expect(canVerifyTerminalContinuation(unsettled, terminal)).toBe(true);
    expect(canContinueOnReconnectedTerminal(unsettled, terminal)).toBe(false);
    expect(terminalReconnectErrorKey('TERMINAL_RECONNECT_UNVERIFIED: requires the same connected identity'))
      .toBe('ai.workspace.reconnectUnverified');
    expect(terminalReconnectErrorKey('TERMINAL_RECONNECT_SOURCE_ACTIVE: previous terminal is still available'))
      .toBe('ai.workspace.reconnectSourceActive');
  });

  it('waits for the trusted shell prompt before automatically restoring visible execution', () => {
    const visible = { ...snapshot, header: { ...snapshot.header, executionSurface: 'boundTerminal' as const } };
    expect(canContinueOnReconnectedTerminal(visible, terminal)).toBe(false);
    expect(canContinueOnReconnectedTerminal(visible, { ...terminal, integrationState: 'ready', promptReady: false })).toBe(false);
    expect(canContinueOnReconnectedTerminal(visible, { ...terminal, integrationState: 'ready', promptReady: true })).toBe(true);
  });

  it('keeps restored history visible without offering an unverified rebind', () => {
    const restored = { ...terminal, brokerReplacedSessionIds: [] };
    expect(isDirectReconnectedTerminal(snapshot, restored)).toBe(true);
    expect(canContinueOnReconnectedTerminal(snapshot, restored)).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, brokerReplacedSessionIds: undefined })).toBe(false);
  });

  it('distinguishes connection ancestry errors from unsettled operations', () => {
    expect(terminalReconnectErrorKey('terminal reconnect requires a verified replacement transport'))
      .toBe('ai.workspace.reconnectUnverified');
    expect(terminalReconnectErrorKey('TERMINAL_BROKER_STALE_TRANSPORT'))
      .toBe('ai.workspace.reconnectUnverified');
    expect(terminalReconnectErrorKey('TERMINAL_RECONNECT_BUSY: wait for terminal closure to settle'))
      .toBe('ai.workspace.reconnectUnsettled');
    expect(terminalReconnectErrorKey('terminal reconnect requires a settled driver'))
      .toBe('ai.workspace.reconnectUnsettled');
    expect(terminalReconnectErrorKey('IPC unavailable')).toBe('ai.workspace.reconnectFailed');
  });
  it('allows rebinding only to a replacement of the same SSH target', () => {
    expect(canContinueOnReconnectedTerminal(snapshot, terminal)).toBe(true);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, host: 'other.example.com' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, profileId: 'other' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, replacesSessionId: 'unrelated' })).toBe(false);
    expect(canContinueOnReconnectedTerminal(snapshot, { ...terminal, status: 'disconnected' })).toBe(false);
  });

  it('blocks rebinding while effects need reconciliation or the root is live', () => {
    expect(canContinueOnReconnectedTerminal({
      ...snapshot,
      recovery: { ...snapshot.recovery, status: 'required', kind: 'executionInFlight' },
    }, terminal)).toBe(false);
    expect(canContinueOnReconnectedTerminal({ ...snapshot, uncertainNativeEffects: true }, terminal)).toBe(false);
    expect(isDirectReconnectedTerminal({ ...snapshot, status: 'running', ended: false }, {
      ...terminal, status: 'connecting',
    })).toBe(true);
    expect(canContinueOnReconnectedTerminal({ ...snapshot, status: 'idle', ended: false }, terminal)).toBe(true);
    expect(canContinueOnReconnectedTerminal({
      ...snapshot,
      header: { ...snapshot.header, target: { ...snapshot.header.target!, rootPath: '/srv' } },
    }, terminal)).toBe(true);
  });

  it('retains local projects and repeated reconnect ancestry', () => {
    const local: AgentSessionSnapshot = { ...snapshot, header: { ...snapshot.header, target: {
      kind: 'local', targetId: 'terminal-old', sessionId: 'old', cwd: '/tmp/project',
    } } };
    expect(canContinueOnReconnectedTerminal(local, {
      ...terminal, host: 'local', port: 0, replacesSessionId: 'intermediate', replacedSessionIds: ['old', 'intermediate'],
    })).toBe(true);
    expect(canContinueOnReconnectedTerminal({ ...snapshot, inbox: {
      nextStep: [], nextTurn: [{ messageId: 'pending', content: 'Pending user input', source: { kind: 'user', label: 'User', producerId: 'human' } }],
    } }, terminal)).toBe(false);
  });
});
