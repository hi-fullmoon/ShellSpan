import { describe, expect, it } from 'vitest';

import {
  resolveAiSubmission,
  type AiSubmissionPolicyInput,
} from '@/lib/ai/submission-policy';

const base: AiSubmissionPolicyInput = {
  sessionStatus: 'idle',
  terminal: false,
  sessionId: 'session-1',
  waitingApproval: false,
  hasProvider: true,
  canCreateSession: true,
  draft: 'Continue safely',
  gesture: 'keyboard',
  accelerated: false,
  preferredBusyMode: 'queue',
  submitting: false,
};

describe('resolveAiSubmission', () => {
  it.each([
    ['new plain', { sessionId: null }, { kind: 'submit', mode: 'start' }],
    ['new accelerated', { sessionId: null, accelerated: true }, { kind: 'submit', mode: 'start' }],
    ['idle existing', {}, { kind: 'submit', mode: 'nextTurn' }],
    ['running queue Enter', { sessionStatus: 'running' }, { kind: 'submit', mode: 'nextTurn' }],
    ['running queue accelerated', { sessionStatus: 'running', accelerated: true }, { kind: 'submit', mode: 'nextStep' }],
    ['running steer Enter', { sessionStatus: 'running', preferredBusyMode: 'steer' }, { kind: 'submit', mode: 'nextStep' }],
    ['running steer accelerated', { sessionStatus: 'running', preferredBusyMode: 'steer', accelerated: true }, { kind: 'submit', mode: 'nextTurn' }],
    ['waiting runtime queues', { sessionStatus: 'waiting' }, { kind: 'submit', mode: 'nextTurn' }],
  ] as const)('%s', (_label, changes, expected) => {
    expect(resolveAiSubmission({ ...base, ...changes })).toEqual(expected);
  });

  it.each([
    ['whitespace', { draft: '  ' }, 'empty'],
    ['keyboard empty while running', { draft: '', sessionStatus: 'running' }, 'empty'],
    ['approval', { waitingApproval: true }, 'waitingApproval'],
    ['terminal completed', { sessionStatus: 'completed', terminal: true }, 'terminal'],
    ['terminal failed', { sessionStatus: 'failed', terminal: true }, 'terminal'],
    ['provider', { hasProvider: false }, 'providerUnavailable'],
    ['cannot create', { sessionId: null, canCreateSession: false }, 'sessionUnavailable'],
    ['running without session', { sessionStatus: 'running', sessionId: null }, 'sessionUnavailable'],
    ['submitting', { submitting: true }, 'submitting'],
  ] as const)('rejects %s', (_label, changes, reason) => {
    expect(resolveAiSubmission({ ...base, ...changes })).toEqual({ kind: 'reject', reason });
  });

  it('maps only an explicit running empty primary action to Stop', () => {
    expect(resolveAiSubmission({
      ...base,
      sessionStatus: 'running',
      draft: '',
      gesture: 'primary',
      hasProvider: false,
    })).toEqual({ kind: 'stop' });
  });

  it('allows a retryable Agent failure to submit again in the same session', () => {
    expect(resolveAiSubmission({
      ...base,
      sessionStatus: 'failed',
      terminal: false,
    })).toEqual({ kind: 'submit', mode: 'nextTurn' });
  });
});
