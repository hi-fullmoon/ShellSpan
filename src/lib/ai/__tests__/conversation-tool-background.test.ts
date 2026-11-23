import { describe, expect, it } from 'vitest';

import type { AiToolNode } from '@/lib/ai/conversation-node';
import { linkBackgroundJobTools } from '@/lib/ai/conversation-tool';

function toolNode(overrides: Partial<AiToolNode> & Pick<AiToolNode, 'key' | 'name' | 'firstSeq' | 'lastSeq'>): AiToolNode {
  return {
    kind: 'tool',
    sourceKind: 'agent',
    sessionId: 'session-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    callId: overrides.key,
    timestamp: '2026-11-23T05:00:00.000Z',
    nativeName: null,
    title: null,
    summary: overrides.name,
    state: 'succeeded',
    effect: 'readOnly',
    durationMs: 100,
    detailRef: { kind: 'agentTool', sessionId: 'session-1', callId: overrides.key },
    evidenceRefs: [],
    input: {},
    output: null,
    error: null,
    target: null,
    idempotency: null,
    approval: null,
    ...overrides,
  };
}

describe('linkBackgroundJobTools', () => {
  it('aggregates multiple observations onto the matching background launch and links each observer', () => {
    const launch = toolNode({
      key: 'launch-1',
      name: 'run_terminal_command',
      firstSeq: 1,
      lastSeq: 2,
      input: { command: 'find .', background: true },
      output: {
        channel: 'terminal',
        execution: 'running',
        exitCode: 0,
        combinedOutput: '',
        processHandle: 'job-abc',
        job: { processHandle: 'job-abc', state: 'running', exitCode: null },
      },
    });
    const poll1 = toolNode({
      key: 'wait-1',
      name: 'wait_process',
      firstSeq: 3,
      lastSeq: 4,
      input: { processHandle: 'job-abc' },
      output: {
        processHandle: 'job-abc',
        state: 'running',
        exitCode: null,
        stdout: 'chunk-1\n',
        stderr: '',
      },
    });
    const poll2 = toolNode({
      key: 'wait-2',
      name: 'wait_process',
      firstSeq: 5,
      lastSeq: 6,
      input: { processHandle: 'job-abc' },
      output: {
        processHandle: 'job-abc',
        state: 'exited',
        exitCode: 0,
        job: { processHandle: 'job-abc', state: 'exited', exitCode: 0 },
        stdout: 'chunk-2\n',
        stderr: '',
      },
    });

    const linked = linkBackgroundJobTools([launch, poll1, poll2]) as AiToolNode[];
    expect(linked[0].backgroundJob).toEqual({
      processHandle: 'job-abc',
      state: 'exited',
      exitCode: 0,
      output: 'chunk-1\nchunk-2\n',
      observing: false,
      latestObserverToolKey: 'wait-2',
      observationCount: 2,
    });
    expect(linked[1].linkedBackgroundJob).toEqual({
      launchToolKey: 'launch-1',
      processHandle: 'job-abc',
      action: 'wait',
      observedState: 'running',
      exitCode: null,
    });
    expect(linked[2].linkedBackgroundJob).toEqual({
      launchToolKey: 'launch-1',
      processHandle: 'job-abc',
      action: 'wait',
      observedState: 'exited',
      exitCode: 0,
    });
  });

  it('tracks kill_process stop requests and ignores unrelated handles', () => {
    const launch = toolNode({
      key: 'launch-proc',
      name: 'run_terminal_command',
      firstSeq: 1,
      lastSeq: 2,
      input: { command: 'node server.js', background: true },
      output: { channel: 'direct', state: 'running', processHandle: 'proc-1', exitCode: null, stdout: '', stderr: '' },
    });
    const unrelated = toolNode({
      key: 'wait-other',
      name: 'wait_process',
      firstSeq: 3,
      lastSeq: 4,
      input: { processHandle: 'proc-999' },
      output: { processHandle: 'proc-999', state: 'exited', exitCode: 0 },
    });
    const stop = toolNode({
      key: 'kill-1',
      name: 'kill_process',
      firstSeq: 5,
      lastSeq: 6,
      input: { processHandle: 'proc-1', signal: 'terminate' },
      output: { processHandle: 'proc-1', state: 'exited', exitCode: 143, stopRequested: true },
    });

    const linked = linkBackgroundJobTools([launch, unrelated, stop]) as AiToolNode[];
    expect(linked[0].backgroundJob).toMatchObject({
      processHandle: 'proc-1',
      state: 'exited',
      exitCode: 143,
      stopRequested: true,
      observationCount: 1,
    });
    expect(linked[1].linkedBackgroundJob).toBeUndefined();
    expect(linked[2].linkedBackgroundJob).toEqual({
      launchToolKey: 'launch-proc',
      processHandle: 'proc-1',
      action: 'kill',
      observedState: 'exited',
      exitCode: 143,
    });
  });
});
