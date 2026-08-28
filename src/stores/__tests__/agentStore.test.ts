import { beforeEach, describe, expect, it } from 'vitest';
import { useStaticDiagnosticStore } from '../staticDiagnosticStore';

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

describe('staticDiagnosticStore', () => {
  beforeEach(() => {
    useStaticDiagnosticStore.getState().clear();
  });

  it('stores a structured plan for review', () => {
    const store = useStaticDiagnosticStore.getState();
    store.beginRun('request-1', 'diagnose disk usage', 'session-1', 'root@server');
    store.appendDelta('request-1', structuredPlan());
    store.completePlanning('request-1');

    const run = useStaticDiagnosticStore.getState().run;
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
  });

  it('binds the plan to its profile, evidence source, and observation time', () => {
    useStaticDiagnosticStore.getState().beginRun(
      'request-health',
      'diagnose health snapshot',
      'session-health',
      'root@prod · remote health',
      'profile-health',
      'remoteHealth',
      1_234,
      'conversation-health',
    );

    expect(useStaticDiagnosticStore.getState().run).toMatchObject({
      sessionId: 'session-health',
      conversationId: 'conversation-health',
      profileId: 'profile-health',
      contextSource: 'remoteHealth',
      contextObservedAt: 1_234,
    });
  });

  it('fails closed when a model understates a modifying command as read-only', () => {
    const store = useStaticDiagnosticStore.getState();
    store.beginRun('request-unsafe', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-unsafe', structuredPlan('systemctl restart nginx'));
    store.completePlanning('request-unsafe');
    expect(useStaticDiagnosticStore.getState().run).toMatchObject({ phase: 'error' });
    expect(useStaticDiagnosticStore.getState().run?.error).toContain('unsafe read-only command');
  });

  it('does not overwrite a plan while its model request is still streaming', () => {
    const store = useStaticDiagnosticStore.getState();
    expect(store.beginRun('request-1', 'first', 'session-1', 'server')).toBe(true);
    expect(store.beginRun('request-2', 'replacement', 'session-1', 'server')).toBe(false);
    expect(useStaticDiagnosticStore.getState().run?.requestId).toBe('request-1');
  });

  it('allows a reviewed draft to be replaced without executing it', () => {
    const store = useStaticDiagnosticStore.getState();
    store.beginRun('request-1', 'first', 'session-1', 'server');
    store.appendDelta('request-1', structuredPlan());
    store.completePlanning('request-1');
    expect(store.beginRun('request-2', 'next', 'session-1', 'server')).toBe(true);
    expect(useStaticDiagnosticStore.getState().run).toMatchObject({
      requestId: 'request-2',
      phase: 'planning',
    });
  });

  it('stops planning and ignores late model output', () => {
    const store = useStaticDiagnosticStore.getState();
    store.beginRun('request-stop', 'diagnose', 'session-1', 'server');
    store.stopRun();
    store.appendDelta('request-stop', structuredPlan());
    store.completePlanning('request-stop');

    expect(useStaticDiagnosticStore.getState().run).toMatchObject({
      phase: 'cancelled',
      responseText: '',
    });
    expect(useStaticDiagnosticStore.getState().run?.plan).toBeUndefined();
  });
});
