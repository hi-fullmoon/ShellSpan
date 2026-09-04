import {
  AGENT_SESSION_EVENT_VERSION,
  type AgentSessionEvent,
} from '@/types/agent-session';

const USER_SOURCE = {
  kind: 'user',
  label: 'User',
  producerId: 'shellspan-user',
} as const;

const REQUEST_HEADER = {
  providerId: 'openai',
  model: 'gpt-test',
  reasoningEffort: 'medium',
  reason: 'initial',
  series: { seriesId: 'series-fixture', requestIndex: 0, startsSeries: true },
  systemPrompt: 'You are the ShellSpan Agent fixture.',
  toolSchemas: [{
    name: 'run_terminal_command',
    description: 'Run a command on the frozen fixture target.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }],
  attempt: 1,
} as const;

type EnvelopeKey = 'version' | 'sessionId' | 'seq' | 'timeUnixMs';
type EventDraft<Type extends AgentSessionEvent['type']> = Omit<
  Extract<AgentSessionEvent, { type: Type }>,
  EnvelopeKey
>;

export function sessionEvent<Type extends AgentSessionEvent['type']>(
  seq: number,
  draft: EventDraft<Type>,
): Extract<AgentSessionEvent, { type: Type }> {
  return {
    version: AGENT_SESSION_EVENT_VERSION,
    sessionId: 'session-fixture',
    seq,
    timeUnixMs: 1_000 + seq * 10,
    ...draft,
  } as Extract<AgentSessionEvent, { type: Type }>;
}

const call = {
  callId: 'call-health',
  name: 'run_terminal_command',
  title: 'Check service health',
  arguments: {
    command: 'systemctl is-active nginx',
    explanation: 'Confirm nginx is active on the frozen target.',
  },
  effect: 'readOnly' as const,
  target: {
    targetId: 'terminal-a',
    kind: 'remote' as const,
    sessionId: 'terminal-a',
    label: 'Production A',
    host: 'a.example.com',
    port: 22,
    username: 'root',
  },
};

export const agentSessionEventFixture: readonly AgentSessionEvent[] = [
  sessionEvent(0, {
    type: 'session/created',
    data: {
      taskId: 'task-fixture',
      goal: 'Check nginx and report evidence.',
      target: call.target,
      permissionMode: 'requestApproval',
      successCriteria: ['Record native command evidence.'],
    },
  }),
  sessionEvent(1, {
    type: 'agent/created',
    data: { agentId: 'session-fixture' },
  }),
  sessionEvent(2, {
    type: 'agent/status',
    data: { status: 'running' },
  }),
  sessionEvent(3, {
    type: 'agent/inbox/spliced',
    data: {
      operation: 'enqueued',
      lane: 'nextTurn',
      messages: [{
        messageId: 'message-user',
        clientSubmissionId: 'submission-user',
        content: 'Check nginx now.',
        source: USER_SOURCE,
      }],
    },
  }),
  sessionEvent(4, {
    type: 'agent/inbox/spliced',
    data: {
      operation: 'claimed',
      lane: 'nextTurn',
      messages: [{
        messageId: 'message-user',
        clientSubmissionId: 'submission-user',
        content: 'Check nginx now.',
        source: USER_SOURCE,
      }],
    },
  }),
  sessionEvent(5, { type: 'turn/start', turnId: 'turn-1' }),
  sessionEvent(6, { type: 'step/start', turnId: 'turn-1', stepId: 'step-1' }),
  sessionEvent(7, {
    type: 'user/message',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      message: {
        messageId: 'message-user',
        clientSubmissionId: 'submission-user',
        content: 'Check nginx now.',
        source: USER_SOURCE,
      },
    },
  }),
  sessionEvent(8, {
    type: 'request/header',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      ...REQUEST_HEADER,
    },
  }),
  sessionEvent(9, {
    type: 'request/context',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      inputTokens: 32_000,
      contextWindow: 64_000,
      systemTokens: 1_200,
      toolSchemaTokens: 6_800,
      messageTokens: 24_000,
      surfaceGeneration: 0,
      limited: true,
      omittedMessages: 2,
    },
  }),
  sessionEvent(10, {
    type: 'request/retry',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      previousRequestId: 'request-initial',
      attempt: 2,
      reason: 'transient provider failure',
    },
  }),
  sessionEvent(11, {
    type: 'assistant/chunk',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { requestId: 'request-1', textDelta: 'Checking ' },
  }),
  sessionEvent(12, {
    type: 'assistant/chunk',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { requestId: 'request-1', textDelta: 'now.' },
  }),
  sessionEvent(13, {
    type: 'assistant/message',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      messageId: 'message-assistant',
      content: [
        { type: 'text', text: 'Checking now.' },
        { type: 'toolCall', call },
      ],
      usage: {},
      stopReason: 'toolCalls',
      interrupted: false,
    },
  }),
  sessionEvent(14, {
    type: 'tool/call',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { call },
  }),
  sessionEvent(15, {
    type: 'tool/approval',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      callId: call.callId,
      approvalId: 'approval-health',
      status: 'requested',
      risk: 'readOnly',
      reason: 'modeRequiresApproval',
      expiresAtUnixMs: 60_000,
      prompt: 'Approve this command on Production A?',
    },
  }),
  sessionEvent(16, {
    type: 'tool/approval',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      callId: call.callId,
      approvalId: 'approval-health',
      status: 'approved',
      risk: 'readOnly',
      reason: 'approvedOnce',
      expiresAtUnixMs: 60_000,
      prompt: 'Approve this command on Production A?',
    },
  }),
  sessionEvent(17, {
    type: 'tool/execution',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      callId: call.callId,
      status: 'dispatched',
      idempotency: 'yes',
    },
  }),
  sessionEvent(18, {
    type: 'tool/result',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      callId: call.callId,
      name: call.name,
      status: 'completed',
      summary: 'active',
      data: { exitCode: 0, output: 'active' },
      durationMs: 220,
      evidenceRefs: ['evidence-health'],
    },
  }),
  sessionEvent(19, {
    type: 'context/artifact',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      artifactId: 'artifact-output',
      kind: 'terminal-output',
      title: 'nginx status',
      sizeBytes: 6,
    },
  }),
  sessionEvent(20, {
    type: 'task/state',
    data: {
      status: 'waiting',
      phase: 'recovery',
      progress: 0.5,
      recovery: {
        status: 'required',
        summary: 'Confirm the durable tool result before continuing.',
      },
    },
  }),
  sessionEvent(21, {
    type: 'compaction/summary',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      summary: 'Earlier complete turns were compacted for the model surface.',
      replacedThroughSeq: 4,
      surfaceGeneration: 1,
    },
  }),
  sessionEvent(22, {
    type: 'task/plan',
    data: {
      version: 1,
      steps: [{
        id: 'plan-check',
        title: 'Check nginx',
        status: 'completed',
        evidenceRefs: ['evidence-health'],
      }],
    },
  }),
  sessionEvent(23, {
    type: 'subagent/descriptor',
    data: {
      descriptorId: 'descriptor-verifier',
      childSessionId: 'session-verifier',
      parentSessionId: 'session-fixture',
      parentTaskId: 'task-fixture',
      role: 'verifier',
      continuable: false,
      depth: 1,
      inheritance: { mode: 'safePrefix', parentThroughSeq: 12 },
      capabilityScope: {
        toolNames: ['read_file', 'list_directory', 'search_text'],
        effects: ['none', 'readOnly', 'sensitiveRead'],
        targetIds: ['terminal-a'],
      },
      targetScope: [call.target],
      budget: {
        maxStepsPerTurn: 4,
        maxTurns: 1,
        maxToolCalls: 16,
        maxTokens: 64000,
        timeoutMs: 60000,
      },
    },
  }),
  sessionEvent(24, {
    type: 'subagent/settled',
    data: {
      descriptorId: 'descriptor-verifier',
      settlementId: 'settlement-verifier',
      childSessionId: 'session-verifier',
      status: 'completed',
      summary: 'Independent check confirmed nginx is active.',
    },
  }),
  sessionEvent(25, {
    type: 'task/state',
    data: {
      status: 'verified',
      phase: 'completed',
      progress: 1,
      recovery: { status: 'none' },
      fleet: {
        fleetId: 'fleet-fixture',
        status: 'completed',
        wave: 1,
        totalWaves: 1,
        targetsCompleted: 1,
        targetsTotal: 1,
        canarySize: 1,
        waveSize: 1,
        failureThreshold: 0,
        failures: 0,
        targets: [{
          targetId: 'terminal-a',
          taskId: 'fleet-task-a',
          goal: 'Check nginx and report evidence.',
          wave: 1,
          state: 'completed',
          childSessionIds: ['session-verifier'],
          evidenceRefs: ['evidence-health'],
        }],
      },
    },
  }),
  sessionEvent(26, {
    type: 'task/evidence',
    data: {
      evidenceId: 'evidence-health',
      kind: 'terminal-output',
      summary: 'nginx is active',
    },
  }),
  sessionEvent(27, {
    type: 'step/end',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { reason: 'completed' },
  }),
  sessionEvent(28, {
    type: 'turn/end',
    turnId: 'turn-1',
    data: { reason: 'completed' },
  }),
  sessionEvent(29, {
    type: 'agent/status',
    data: { status: 'completed' },
  }),
  sessionEvent(30, {
    type: 'session/ended',
    data: { status: 'completed' },
  }),
];

export const agentSessionRunningEventFixture = agentSessionEventFixture.slice(0, 12);

export const agentSessionWaitingApprovalEventFixture = agentSessionEventFixture.slice(0, 16);

const remainingEventFamilyFixture: readonly AgentSessionEvent[] = [
  sessionEvent(0, {
    type: 'request/usage',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      usage: {
        uncachedInputTokens: 32_000,
        cacheReadTokens: 0,
        outputTokens: 12,
        totalTokens: 32_012,
      },
      finishReason: 'stop',
    },
  }),
  sessionEvent(1, {
    type: 'compaction/start',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { reason: 'fixture coverage' },
  }),
  sessionEvent(2, {
    type: 'compaction/end',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      surfaceGeneration: 2,
      replacedThroughSeq: 12,
      status: 'completed',
    },
  }),
  sessionEvent(3, {
    type: 'subagent/message',
    data: {
      descriptorId: 'descriptor-verifier',
      childSessionId: 'session-verifier',
      direction: 'outbound',
      route: 'followup',
      summary: 'Verify the durable result.',
    },
  }),
  sessionEvent(4, {
    type: 'subagent/detached',
    data: {
      descriptorId: 'descriptor-verifier',
      childSessionId: 'session-verifier',
      reason: 'fixture completed',
    },
  }),
  sessionEvent(5, {
    type: 'task/linked',
    data: { taskId: 'task-fixture', goal: 'Check nginx and report evidence.' },
  }),
  sessionEvent(6, {
    type: 'agent/inbox/spliced',
    data: {
      operation: 'discarded',
      lane: 'nextStep',
      messages: [{
        messageId: 'discarded-steer',
        content: 'Obsolete steering input.',
        source: USER_SOURCE,
      }],
    },
  }),
  sessionEvent(7, {
    type: 'agent/inbox/item_updated',
    data: {
      itemId: 'discarded-steer',
      lane: 'nextStep',
      content: 'Updated steering input.',
      previousRevision: 0,
      clientOperationId: 'fixture-update',
    },
  }),
  sessionEvent(8, {
    type: 'agent/inbox/item_removed',
    data: {
      itemId: 'discarded-steer',
      lane: 'nextStep',
      previousRevision: 0,
      clientOperationId: 'fixture-remove',
    },
  }),
  sessionEvent(9, {
    type: 'agent/inbox/reordered',
    data: {
      lane: 'nextTurn',
      orderedItemIds: [],
      previousRevision: 0,
      clientOperationId: 'fixture-reorder',
    },
  }),
  sessionEvent(10, {
    type: 'session/renamed',
    data: {
      title: 'Manual fixture title',
      previousRevision: 0,
      clientOperationId: 'fixture-rename',
    },
  }),
];

export const agentSessionAllEventFamiliesFixture: readonly AgentSessionEvent[] = [
  ...agentSessionEventFixture.slice(0, -4),
  ...remainingEventFamilyFixture,
  ...agentSessionEventFixture.slice(-4),
].flatMap((event): AgentSessionEvent[] => {
  if (event.type !== 'request/header') return [event];
  const { systemPrompt: _prompt, toolSchemas: _tools, ...data } = event.data;
  return [event, {
    ...event,
    type: 'request/start',
    data: { ...data, headerRequestId: data.requestId },
  }];
}).map((event, seq) => ({
  ...event,
  seq,
  timeUnixMs: 1_000 + seq * 10,
}));

export const agentSessionFailedEventFixture: readonly AgentSessionEvent[] = [
  sessionEvent(0, {
    type: 'session/created',
    data: {
      taskId: 'task-failed',
      goal: 'Inspect the failed deployment.',
      target: call.target,
      permissionMode: 'requestApproval',
      successCriteria: ['Explain the failure.'],
    },
  }),
  sessionEvent(1, { type: 'agent/status', data: { status: 'running' } }),
  sessionEvent(2, { type: 'turn/start', turnId: 'turn-failed' }),
  sessionEvent(3, { type: 'step/start', turnId: 'turn-failed', stepId: 'step-failed' }),
  sessionEvent(4, {
    type: 'user/message',
    turnId: 'turn-failed',
    stepId: 'step-failed',
    data: {
      message: {
        messageId: 'message-failed',
        content: 'Why did deployment fail?',
        source: USER_SOURCE,
      },
    },
  }),
  sessionEvent(5, {
    type: 'request/header',
    turnId: 'turn-failed',
    stepId: 'step-failed',
    data: { requestId: 'request-failed', ...REQUEST_HEADER },
  }),
  sessionEvent(6, {
    type: 'assistant/chunk',
    turnId: 'turn-failed',
    stepId: 'step-failed',
    data: { requestId: 'request-failed', textDelta: 'The deployment check failed.' },
  }),
  sessionEvent(7, {
    type: 'step/end',
    turnId: 'turn-failed',
    stepId: 'step-failed',
    data: { reason: 'provider error' },
  }),
  sessionEvent(8, {
    type: 'turn/end',
    turnId: 'turn-failed',
    data: { reason: 'provider error' },
  }),
  sessionEvent(9, {
    type: 'agent/status',
    data: { status: 'failed', reason: 'Provider connection failed.' },
  }),
  sessionEvent(10, {
    type: 'session/ended',
    data: { status: 'failed', reason: 'Provider connection failed.' },
  }),
];
