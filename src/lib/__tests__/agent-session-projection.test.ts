import { describe, expect, it } from 'vitest';

import {
  projectAgentActivity,
  projectAgentConversation,
  projectAgentSession,
} from '@/lib/agent-session-projection';
import { agentToolApprovalSnapshot } from '@/lib/agent-tool-approval';
import { agentSessionEventFixture, sessionEvent } from './agent-session-fixture';

describe('Agent Session projections', () => {
  it('replays one ordered event fixture into Conversation and Activity', () => {
    const inputBefore = JSON.stringify(agentSessionEventFixture);
    const session = projectAgentSession(agentSessionEventFixture);

    expect(session.sessionId).toBe('session-fixture');
    expect(session.taskId).toBe('task-fixture');
    expect(session.status).toBe('completed');
    expect(session.permissionMode).toBe('requestApproval');
    expect(session.latestRequestId).toBe('request-1');
    expect(session.conversation.items.filter((item) => item.kind === 'message')).toEqual([
      expect.objectContaining({ role: 'user', content: 'Check nginx now.' }),
      expect.objectContaining({ role: 'assistant', content: 'Checking now.', status: 'completed' }),
    ]);
    expect(session.conversation.items.find((item) => item.kind === 'tool')).toEqual(
      expect.objectContaining({
        callId: 'call-health',
        status: 'completed',
        resultSummary: 'active',
        evidenceRefs: ['evidence-health'],
        approvalRequestId: 'request-1',
        approvalId: 'approval-health',
        approvalExpiresAtUnixMs: 60_000,
        approvalPrompt: 'Approve this command on Production A?',
      }),
    );
    expect(session.conversation.items.filter((item) => item.kind === 'marker').map((item) => item.marker))
      .toEqual(expect.arrayContaining(['contextLimited', 'compaction', 'subagentSettled']));

    expect(session.activity.turns).toHaveLength(1);
    expect(session.activity.turns[0]).toEqual(expect.objectContaining({
      id: 'turn-1',
      status: 'completed',
      durationMs: 190,
    }));
    expect(session.activity.turns[0].steps[0]).toEqual(expect.objectContaining({
      id: 'step-1',
      status: 'completed',
      durationMs: 170,
      request: expect.objectContaining({
        model: 'gpt-test',
        inputTokens: 32_000,
        contextWindow: 64_000,
      }),
      tools: [expect.objectContaining({ callId: 'call-health', status: 'completed' })],
    }));
    expect(session.activity.plan?.steps[0].status).toBe('completed');
    expect(session.activity.context).toEqual(expect.objectContaining({
      surfaceGeneration: 1,
      compactionCount: 1,
    }));
    expect(session.activity.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'session-verifier',
        role: 'verifier',
        descriptorId: 'descriptor-verifier',
        depth: 1,
        status: 'completed',
      }),
    ]));
    expect(session.activity.fleet).toEqual(expect.objectContaining({
      targetsCompleted: 1,
      targets: [expect.objectContaining({ targetId: 'terminal-a', state: 'completed' })],
    }));
    expect(JSON.stringify(agentSessionEventFixture)).toBe(inputBefore);
  });

  it('keeps the individual pure projection functions consistent', () => {
    const session = projectAgentSession(agentSessionEventFixture);
    expect(projectAgentConversation(agentSessionEventFixture)).toEqual(session.conversation);
    expect(projectAgentActivity(agentSessionEventFixture)).toEqual(session.activity);
    expect(projectAgentSession(agentSessionEventFixture)).toEqual(session);
  });

  it('projects queued next-step input as a Marker instead of a chat bubble', () => {
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-steer', goal: 'Inspect safely.' },
      }),
      sessionEvent(1, {
        type: 'agent/inbox/spliced',
        data: {
          operation: 'enqueued',
          lane: 'nextStep',
          messages: [{
            messageId: 'steer-1',
            content: 'Do not restart the service.',
            source: { kind: 'user' },
          }],
        },
      }),
    ];

    const projection = projectAgentConversation(events);
    expect(projection.items).toEqual([
      expect.objectContaining({
        kind: 'marker',
        marker: 'steer',
        detail: 'Do not restart the service.',
      }),
    ]);
  });

  it('shows artifact and recovery boundaries in both Conversation and Activity', () => {
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-recovery', goal: 'Recover safely.' },
      }),
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-recovery' }),
      sessionEvent(2, { type: 'step/start', turnId: 'turn-recovery', stepId: 'step-recovery' }),
      sessionEvent(3, {
        type: 'context/artifact',
        turnId: 'turn-recovery',
        stepId: 'step-recovery',
        data: {
          artifactId: 'artifact-123',
          kind: 'tool-result',
          title: 'Bounded output',
          sizeBytes: 9_000,
          mediaType: 'application/json',
          sha256: 'a'.repeat(64),
          sensitivity: 'sensitiveRedacted',
        },
      }),
      sessionEvent(4, {
        type: 'task/state',
        data: {
          status: 'waiting',
          recovery: {
            status: 'required',
            summary: 'Artifact integrity review is required.',
          },
        },
      }),
    ];

    const projection = projectAgentSession(events);
    expect(projection.conversation.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'marker', marker: 'artifact', detail: 'Bounded output' }),
      expect.objectContaining({ kind: 'marker', marker: 'recovery' }),
    ]));
    expect(projection.activity.context.artifacts[0]).toEqual(expect.objectContaining({
      artifactId: 'artifact-123',
      sha256: 'a'.repeat(64),
      sensitivity: 'sensitiveRedacted',
    }));
    expect(projection.activity.recovery.status).toBe('required');
  });

  it('keeps Step-local call ids distinct across a Session replay', () => {
    const call = {
      callId: 'call-1',
      name: 'inspect',
      arguments: {},
      effect: 'readOnly' as const,
    };
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-calls', goal: 'Inspect twice.' },
      }),
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-calls' }),
      sessionEvent(2, { type: 'step/start', turnId: 'turn-calls', stepId: 'step-a' }),
      sessionEvent(3, {
        type: 'tool/call',
        turnId: 'turn-calls',
        stepId: 'step-a',
        data: { call },
      }),
      sessionEvent(4, {
        type: 'tool/result',
        turnId: 'turn-calls',
        stepId: 'step-a',
        data: { callId: 'call-1', name: 'inspect', status: 'completed', summary: 'first' },
      }),
      sessionEvent(5, {
        type: 'step/end',
        turnId: 'turn-calls',
        stepId: 'step-a',
        data: { reason: 'completed' },
      }),
      sessionEvent(6, { type: 'step/start', turnId: 'turn-calls', stepId: 'step-b' }),
      sessionEvent(7, {
        type: 'tool/call',
        turnId: 'turn-calls',
        stepId: 'step-b',
        data: { call },
      }),
      sessionEvent(8, {
        type: 'tool/result',
        turnId: 'turn-calls',
        stepId: 'step-b',
        data: { callId: 'call-1', name: 'inspect', status: 'failed', summary: 'second' },
      }),
    ];

    const projection = projectAgentSession(events);
    const tools = projection.conversation.items.filter((item) => item.kind === 'tool');
    expect(tools).toEqual([
      expect.objectContaining({ id: 'tool:step-a:call-1', status: 'completed' }),
      expect.objectContaining({ id: 'tool:step-b:call-1', status: 'failed' }),
    ]);
    expect(projection.activity.turns[0].steps.map((step) => step.tools[0].status))
      .toEqual(['completed', 'failed']);
  });

  it('does not advance the Model Surface generation for a failed compaction', () => {
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-compaction', goal: 'Compact safely.' },
      }),
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-1' }),
      sessionEvent(2, {
        type: 'turn/end',
        turnId: 'turn-1',
        data: { reason: 'completed' },
      }),
      sessionEvent(3, {
        type: 'compaction/end',
        turnId: 'turn-2',
        stepId: 'step-2',
        data: {
          surfaceGeneration: 1,
          replacedThroughSeq: 2,
          status: 'failed',
        },
      }),
    ];

    expect(projectAgentActivity(events).context.surfaceGeneration).toBe(0);
  });

  it('projects normalized model usage and finish reason onto the matching request', () => {
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-usage', goal: 'Report usage.' },
      }),
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-usage' }),
      sessionEvent(2, { type: 'step/start', turnId: 'turn-usage', stepId: 'step-usage' }),
      sessionEvent(3, {
        type: 'request/header',
        turnId: 'turn-usage',
        stepId: 'step-usage',
        data: {
          requestId: 'request-usage',
          providerId: 'deepseek',
          model: 'deepseek-v4-flash',
        },
      }),
      sessionEvent(4, {
        type: 'request/usage',
        turnId: 'turn-usage',
        stepId: 'step-usage',
        data: {
          requestId: 'request-usage',
          inputTokens: 21,
          outputTokens: 8,
          totalTokens: 29,
          finishReason: 'stop',
        },
      }),
    ];

    expect(projectAgentActivity(events).turns[0].steps[0].request).toEqual(
      expect.objectContaining({
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
        finishReason: 'stop',
      }),
    );
  });

  it('keeps a tool-call Step at the typed waiting boundary', () => {
    const events = [
      sessionEvent(0, {
        type: 'session/created',
        data: { taskId: 'task-waiting', goal: 'Wait for native tool execution.' },
      }),
      sessionEvent(1, { type: 'turn/start', turnId: 'turn-waiting' }),
      sessionEvent(2, {
        type: 'step/start',
        turnId: 'turn-waiting',
        stepId: 'step-waiting',
      }),
      sessionEvent(3, {
        type: 'step/end',
        turnId: 'turn-waiting',
        stepId: 'step-waiting',
        data: { reason: 'waitingForTool' },
      }),
      sessionEvent(4, {
        type: 'agent/status',
        data: { status: 'waiting', reason: 'waitingForTool' },
      }),
    ];

    const activity = projectAgentActivity(events);
    expect(activity.status).toBe('waiting');
    expect(activity.turns[0].steps[0]).toEqual(expect.objectContaining({
      status: 'waiting',
      endReason: 'waitingForTool',
    }));
  });

  it('fails closed on mixed or non-contiguous event windows', () => {
    const gap = [agentSessionEventFixture[0], { ...agentSessionEventFixture[1], seq: 2 }];
    expect(() => projectAgentSession(gap)).toThrow('ordered and contiguous');

    const mixed = [agentSessionEventFixture[0], { ...agentSessionEventFixture[1], sessionId: 'other' }];
    expect(() => projectAgentSession(mixed)).toThrow('cannot mix session ids');

    const fractionalTime = [{ ...agentSessionEventFixture[0], timeUnixMs: 1.5 }];
    expect(() => projectAgentSession(fractionalTime)).toThrow('invalid timestamp');
  });

  it('projects non-terminal approvals without inventing execution authority', () => {
    const snapshot = agentToolApprovalSnapshot('session-apply', {
      kind: 'tool',
      id: 'tool:step-apply:call-apply',
      callId: 'call-apply',
      name: 'apply_patch',
      title: 'Apply patch',
      arguments: { patch: '*** Begin Patch', preconditions: [] },
      effect: 'stateChange',
      target: {
        kind: 'local',
        targetId: 'target-local',
        sessionId: 'terminal-local',
        label: 'Local',
      },
      status: 'awaitingApproval',
      approvalId: 'approval-apply',
      approvalRequestId: 'request-apply',
      approvalPrompt: 'Approve the exact digest-bound patch?',
      evidenceRefs: [],
      turnId: 'turn-apply',
      stepId: 'step-apply',
    }, 'requestApproval');

    expect(snapshot).toEqual(expect.objectContaining({
      status: 'awaitingApproval',
      riskAssessment: expect.objectContaining({ risk: 'stateChange' }),
      toolCall: expect.objectContaining({
        callId: 'call-apply',
        explanation: 'Approve the exact digest-bound patch?',
        command: expect.stringContaining('*** Begin Patch'),
      }),
    }));
  });
});
