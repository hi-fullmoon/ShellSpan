import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '../agentStore';

describe('agentStore', () => {
  beforeEach(() => {
    useAgentStore.getState().clear();
  });

  it('builds an approval-gated run from the streamed plan', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-1', 'diagnose disk usage', 'session-1', 'root@server');
    store.appendDelta('request-1', JSON.stringify({
      summary: 'Disk usage needs inspection.',
      steps: [
        { title: 'Inspect filesystems', description: 'Read disk usage.', command: 'df -h' },
        { title: 'Compare mounts', description: 'Review the reported percentages.' },
      ],
    }));
    store.completePlanning('request-1');

    const run = useAgentStore.getState().run;
    expect(run?.phase).toBe('awaitingApproval');
    expect(run?.steps.some((step) => step.status === 'awaitingApproval')).toBe(true);
    expect(run?.steps.some((step) => step.kind === 'tool')).toBe(true);
    expect(run?.steps.find((step) => step.title === 'Compare mounts')?.status)
      .toBe('informational');
  });

  it('keeps remote snapshot diagnosis bound to its profile and evidence source', () => {
    useAgentStore.getState().beginRun(
      'request-health',
      'diagnose health snapshot',
      'session-health',
      'root@prod · remote health',
      'profile-health',
      'remoteHealth',
    );

    expect(useAgentStore.getState().run).toMatchObject({
      sessionId: 'session-health',
      profileId: 'profile-health',
      contextSource: 'remoteHealth',
    });
    expect(useAgentStore.getState().run?.steps[0]).toMatchObject({
      title: 'remoteHealth.getSnapshotContext',
      status: 'completed',
    });
  });

  it('advances commands one at a time through approval, insertion, and completion', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-2', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-2', JSON.stringify({
      summary: 'Check two signals.',
      steps: [
        { title: 'Disk', description: 'Inspect disk.', command: 'df -h' },
        { title: 'Memory', description: 'Inspect memory.', command: 'free -h' },
      ],
    }));
    store.completePlanning('request-2');
    const commands = useAgentStore.getState().run?.steps.filter(
      (step) => step.kind === 'command',
    ) ?? [];
    expect(commands.map((step) => step.status)).toEqual(['awaitingApproval', 'queued']);

    expect(useAgentStore.getState().approveStep(
      commands[0].id,
      'before output',
      '__TERMBRIDGE_AGENT_RESULT_command1__',
    )).toBe(true);
    expect(useAgentStore.getState().run?.phase).toBe('awaitingExecution');
    expect(useAgentStore.getState().run?.steps.find((step) => step.id === commands[0].id))
      .toMatchObject({
        status: 'inserted',
        outputBaseline: 'before output',
        executionMarker: '__TERMBRIDGE_AGENT_RESULT_command1__',
      });

    expect(useAgentStore.getState().beginEvaluation(
      commands[0].id,
      'request-evaluation',
      'disk output',
      0,
    )).toBe(true);
    expect(useAgentStore.getState().run?.phase).toBe('evaluating');
    expect(useAgentStore.getState().run?.steps.find((step) => step.id === commands[0].id))
      .toMatchObject({ status: 'completed', result: 'disk output', exitCode: 0 });
    expect(useAgentStore.getState().run?.steps.find((step) => step.id === commands[1].id)?.status)
      .toBe('superseded');

    useAgentStore.getState().appendDelta('request-evaluation', JSON.stringify({
      summary: 'Memory remains to be checked.',
      steps: [{ title: 'Memory revised', description: 'Inspect memory now.', command: 'free -h' }],
    }));
    useAgentStore.getState().completePlanning('request-evaluation');
    expect(useAgentStore.getState().run?.phase).toBe('awaitingApproval');
    const revisedCommand = useAgentStore.getState().run?.steps.find(
      (step) => step.title === 'Memory revised',
    );
    expect(revisedCommand?.status).toBe('awaitingApproval');
    useAgentStore.getState().rejectStep(revisedCommand!.id);
    expect(useAgentStore.getState().run?.phase).toBe('completed');
    expect(useAgentStore.getState().run?.steps.find((step) => step.id === commands[0].id)?.result)
      .toBe('disk output');
  });

  it('fails closed when a plan contains an unsafe command', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-3', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-3', JSON.stringify({
      summary: 'Unsafe plan.',
      steps: [{ title: 'Restart', description: 'Mutates service state.', command: 'systemctl restart nginx' }],
    }));
    store.completePlanning('request-3');
    expect(useAgentStore.getState().run?.phase).toBe('error');
  });

  it('does not overwrite a run that still has pending approvals', () => {
    const store = useAgentStore.getState();
    expect(store.beginRun('request-4', 'first run', 'session-1', 'server')).toBe(true);
    store.appendDelta('request-4', JSON.stringify({
      summary: 'Approval is required.',
      steps: [{ title: 'Disk', description: 'Inspect disk.', command: 'df -h' }],
    }));
    store.completePlanning('request-4');

    expect(useAgentStore.getState().beginRun(
      'request-5',
      'replacement run',
      'session-1',
      'server',
    )).toBe(false);
    expect(useAgentStore.getState().run?.requestId).toBe('request-4');
    expect(useAgentStore.getState().run?.phase).toBe('awaitingApproval');
  });

  it('does not overwrite a run waiting for an inserted command to finish', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-inserted', 'first run', 'session-1', 'server');
    store.appendDelta('request-inserted', JSON.stringify({
      summary: 'Approval is required.',
      steps: [{ title: 'Disk', description: 'Inspect disk.', command: 'df -h' }],
    }));
    store.completePlanning('request-inserted');
    const command = useAgentStore.getState().run?.steps.find((step) => step.kind === 'command');
    useAgentStore.getState().approveStep(
      command!.id,
      '',
      '__TERMBRIDGE_AGENT_RESULT_inserted__',
    );

    expect(useAgentStore.getState().beginRun(
      'request-replacement',
      'replacement run',
      'session-1',
      'server',
    )).toBe(false);
    expect(useAgentStore.getState().run?.phase).toBe('awaitingExecution');
  });

  it('stops an active run and rejects every unresolved command', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-stop', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-stop', JSON.stringify({
      summary: 'Check two signals.',
      steps: [
        { title: 'Disk', description: 'Inspect disk.', command: 'df -h' },
        { title: 'Memory', description: 'Inspect memory.', command: 'free -h' },
      ],
    }));
    store.completePlanning('request-stop');
    store.stopRun();

    expect(useAgentStore.getState().run?.phase).toBe('cancelled');
    expect(useAgentStore.getState().run?.steps.filter((step) => step.kind === 'command'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
      ]));
  });

  it('ignores late stream events after the run has stopped', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-late', 'diagnose', 'session-1', 'server');
    store.stopRun();
    store.appendDelta('request-late', JSON.stringify({
      summary: 'This response arrived too late.',
      steps: [{ title: 'Disk', description: 'Inspect disk.', command: 'df -h' }],
    }));
    store.completePlanning('request-late');

    expect(useAgentStore.getState().run).toMatchObject({
      phase: 'cancelled',
      responseText: '',
    });
    expect(useAgentStore.getState().run?.steps.some((step) => step.title === 'Disk')).toBe(false);
  });

  it('caps the complete run at eight executed commands across replans', () => {
    const store = useAgentStore.getState();
    store.beginRun('request-budget-0', 'diagnose', 'session-1', 'server');
    store.appendDelta('request-budget-0', JSON.stringify({
      summary: 'Start bounded diagnosis.',
      steps: [{ title: 'Check 1', description: 'Inspect signal.', command: 'df -h' }],
    }));
    store.completePlanning('request-budget-0');

    for (let index = 0; index < 8; index += 1) {
      const command = useAgentStore.getState().run?.steps.find(
        (step) => step.status === 'awaitingApproval',
      );
      expect(command).toBeDefined();
      useAgentStore.getState().approveStep(
        command!.id,
        '',
        `__TERMBRIDGE_AGENT_RESULT_budget${index}__`,
      );
      const evaluationRequestId = `request-budget-${index + 1}`;
      useAgentStore.getState().beginEvaluation(command!.id, evaluationRequestId, 'output', 0);
      useAgentStore.getState().appendDelta(evaluationRequestId, JSON.stringify({
        summary: `Assessment ${index + 1}`,
        steps: [{
          title: `Check ${index + 2}`,
          description: 'Inspect next signal.',
          command: 'df -h',
        }],
      }));
      useAgentStore.getState().completePlanning(evaluationRequestId);
    }

    const finalRun = useAgentStore.getState().run;
    expect(finalRun?.phase).toBe('completed');
    expect(finalRun?.steps.filter((step) => (
      step.kind === 'command' && step.status === 'completed'
    ))).toHaveLength(8);
    expect(finalRun?.steps.find((step) => step.title === 'Check 9')?.status).toBe('rejected');
  });

  it('allows a completed run to be replaced', () => {
    const store = useAgentStore.getState();
    expect(store.beginRun('request-6', 'first run', 'session-1', 'server')).toBe(true);
    store.appendDelta('request-6', JSON.stringify({
      summary: 'No command is needed.',
      steps: [{ title: 'Review', description: 'Review the evidence.' }],
    }));
    store.completePlanning('request-6');

    expect(useAgentStore.getState().beginRun(
      'request-7',
      'next run',
      'session-1',
      'server',
    )).toBe(true);
    expect(useAgentStore.getState().run?.requestId).toBe('request-7');
  });
});
