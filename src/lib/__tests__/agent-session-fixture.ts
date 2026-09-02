import {
  AGENT_SESSION_EVENT_VERSION,
  type AgentSessionEvent,
} from '@/types/agent-session';

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
        content: 'Check nginx now.',
        source: { kind: 'user' },
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
        content: 'Check nginx now.',
        source: { kind: 'user' },
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
        content: 'Check nginx now.',
        source: { kind: 'user' },
      },
    },
  }),
  sessionEvent(8, {
    type: 'request/header',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      requestId: 'request-1',
      providerId: 'openai',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      attempt: 1,
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
      surfaceGeneration: 0,
      limited: true,
      omittedMessages: 2,
    },
  }),
  sessionEvent(10, {
    type: 'assistant/chunk',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { requestId: 'request-1', text: 'Checking ' },
  }),
  sessionEvent(11, {
    type: 'assistant/chunk',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { requestId: 'request-1', text: 'now.' },
  }),
  sessionEvent(12, {
    type: 'assistant/message',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      messageId: 'message-assistant',
      content: 'Checking now.',
      toolCalls: [call],
      interrupted: false,
    },
  }),
  sessionEvent(13, {
    type: 'tool/call',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { call },
  }),
  sessionEvent(14, {
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
  sessionEvent(15, {
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
  sessionEvent(16, {
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
  sessionEvent(17, {
    type: 'compaction/summary',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: {
      summary: 'Earlier complete turns were compacted for the model surface.',
      replacedThroughSeq: 4,
      surfaceGeneration: 1,
    },
  }),
  sessionEvent(18, {
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
  sessionEvent(19, {
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
  sessionEvent(20, {
    type: 'subagent/settled',
    data: {
      descriptorId: 'descriptor-verifier',
      settlementId: 'settlement-verifier',
      childSessionId: 'session-verifier',
      status: 'completed',
      summary: 'Independent check confirmed nginx is active.',
    },
  }),
  sessionEvent(21, {
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
  sessionEvent(22, {
    type: 'task/evidence',
    data: {
      evidenceId: 'evidence-health',
      kind: 'terminal-output',
      summary: 'nginx is active',
    },
  }),
  sessionEvent(23, {
    type: 'step/end',
    turnId: 'turn-1',
    stepId: 'step-1',
    data: { reason: 'completed' },
  }),
  sessionEvent(24, {
    type: 'turn/end',
    turnId: 'turn-1',
    data: { reason: 'completed' },
  }),
  sessionEvent(25, {
    type: 'agent/status',
    data: { status: 'completed' },
  }),
  sessionEvent(26, {
    type: 'session/ended',
    data: { status: 'completed' },
  }),
];
