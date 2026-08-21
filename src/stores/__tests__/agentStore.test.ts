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
  });

  it('completes after every pending command is approved or rejected', () => {
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
    const pending = useAgentStore.getState().run?.steps.filter(
      (step) => step.status === 'awaitingApproval',
    ) ?? [];
    useAgentStore.getState().approveStep(pending[0].id);
    expect(useAgentStore.getState().run?.phase).toBe('awaitingApproval');
    useAgentStore.getState().rejectStep(pending[1].id);
    expect(useAgentStore.getState().run?.phase).toBe('completed');
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
});
