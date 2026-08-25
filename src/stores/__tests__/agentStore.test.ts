import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '../agentStore';

function structuredPlan(command = 'df -h'): string {
  return JSON.stringify({
    objective: 'Inspect disk usage',
    target: 'The currently bound host only',
    assumptions: ['The host exposes standard filesystem tools.'],
    summary: 'Collect fresh bounded disk evidence.',
    evidence: [
      {
        id: 'terminal-context',
        description: 'Original terminal context',
        source: 'context',
        sourceStepId: null,
        maxAgeSeconds: 120,
      },
      {
        id: 'disk-output',
        description: 'Fresh disk usage output',
        source: 'stepOutput',
        sourceStepId: 'check-disk',
        maxAgeSeconds: 60,
      },
    ],
    steps: [{
      id: 'check-disk',
      title: 'Inspect filesystems',
      description: 'Read disk usage.',
      command,
      risk: 'readOnly',
      evidenceIds: ['terminal-context'],
      impact: 'Reads filesystem usage on one reviewed host.',
      rollback: 'No mutation is performed.',
      expected: { exitCode: 0, stdoutContains: [] },
      timeoutSeconds: 15,
      safeToRetry: true,
    }],
  });
}

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.getState().clear();
  });

  it('stores a structured plan as a review-only Runbook handoff', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-1', 'diagnose disk usage', 'session-1', 'root@server');
    store.appendDelta('request-1', structuredPlan());
    store.completePlanning('request-1');

    const run = useAgentStore.getState().run;
    expect(run).toMatchObject({
      phase: 'awaitingReview',
      summary: 'Collect fresh bounded disk evidence.',
      plan: {
        objective: 'Inspect disk usage',
        target: 'The currently bound host only',
      },
    });
    expect(run?.steps.find((step) => step.id === 'check-disk')).toMatchObject({
      kind: 'command',
      status: 'informational',
      risk: 'readOnly',
    });

    useAgentStore.getState().markHandedOff();
    expect(useAgentStore.getState().run?.phase).toBe('handedOff');
  });

  it('binds the plan to its profile, evidence source, and observation time', () => {
    useAgentStore.getState().beginRun(
      'request-health',
      'diagnose health snapshot',
      'session-health',
      'root@prod · remote health',
      'profile-health',
      'remoteHealth',
      1_234,
      'conversation-health',
    );

    expect(useAgentStore.getState().run).toMatchObject({
      sessionId: 'session-health',
      conversationId: 'conversation-health',
      profileId: 'profile-health',
      contextSource: 'remoteHealth',
      contextObservedAt: 1_234,
    });
  });

  it('fails closed when a model understates a modifying command as read-only', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-unsafe', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-unsafe', structuredPlan('systemctl restart nginx'));
    store.completePlanning('request-unsafe');
    expect(useAgentStore.getState().run).toMatchObject({ phase: 'error' });
    expect(useAgentStore.getState().run?.error).toContain('unsafe read-only command');
  });

  it('does not overwrite a plan while its model request is still streaming', () => {
    const store = useAgentStore.getState();
    expect(store.beginRun('request-1', 'first', 'session-1', 'server')).toBe(true);
    expect(store.beginRun('request-2', 'replacement', 'session-1', 'server')).toBe(false);
    expect(useAgentStore.getState().run?.requestId).toBe('request-1');
  });

  it('allows a reviewed or handed-off draft to be replaced without executing it', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-1', 'first', 'session-1', 'server');
    store.appendDelta('request-1', structuredPlan());
    store.completePlanning('request-1');
    expect(store.beginRun('request-2', 'next', 'session-1', 'server')).toBe(true);
    expect(useAgentStore.getState().run).toMatchObject({
      requestId: 'request-2',
      phase: 'planning',
    });
  });

  it('stops planning and ignores late model output', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-stop', 'diagnose', 'session-1', 'server');
    store.stopRun();
    store.appendDelta('request-stop', structuredPlan());
    store.completePlanning('request-stop');

    expect(useAgentStore.getState().run).toMatchObject({
      phase: 'cancelled',
      responseText: '',
    });
    expect(useAgentStore.getState().run?.plan).toBeUndefined();
  });
});
