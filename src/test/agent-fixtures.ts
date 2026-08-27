import type {
  AgentActionKindV1,
  AgentActionResultV1,
  AgentEventTypeV1,
  AgentEventV1,
  AgentRunSnapshotV1,
  AgentToolCallSnapshotV1,
} from '@/types/agent';

export function makeAgentSnapshot(
  overrides: Partial<AgentRunSnapshotV1> = {},
): AgentRunSnapshotV1 {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    lastSequence: 5,
    state: 'thinking',
    target: {
      profileId: 'profile-1',
      profileLabel: 'Production',
      host: 'prod.example.test',
      port: 22,
      username: 'operator',
      authMethod: 'key',
      targetDigest: 'sha256-v1:target-fixture',
    },
    provider: {
      providerId: 'provider-1',
      kind: 'openAiCompatible',
      baseUrl: 'https://provider.example.test',
      model: 'fixture-model',
      capabilities: {
        streaming: false,
        strictJsonSchema: true,
        nativeToolCalling: false,
        usageReporting: true,
        responseContinuation: false,
      },
    },
    policy: {
      mode: 'readOnly',
      policyVersion: 'p1-v1',
      toolRegistryVersion: 'p1-v1',
      allowedTools: ['host.inspect', 'shell.execReadOnly'],
    },
    budgets: {
      schemaVersion: 1,
      policy: {
        maxRunSeconds: 600,
        maxModelTurns: 12,
        maxToolCalls: 10,
        toolTimeoutSeconds: 15,
        maxConsecutiveInvalidDecisions: 2,
        maxConsecutiveToolFailures: 2,
        maxPendingPlanItems: 6,
        maxSteeringQueueItems: 8,
        maxUserMessageBytes: 4096,
        stdoutCaptureBytes: 65_536,
        stderrCaptureBytes: 16_384,
        totalReadHardLimitBytes: 8_388_608,
      },
      usage: {
        elapsedMillis: 2_000,
        modelTurnsUsed: 2,
        toolCallsUsed: 1,
        consecutiveInvalidDecisions: 0,
        consecutiveToolFailures: 0,
        steeringQueueItems: 0,
      },
    },
    goal: 'Inspect CPU pressure without changing the host.',
    plan: [
      { id: 'collect', title: 'Collect host facts', status: 'active' },
      { id: 'report', title: 'Report findings', status: 'pending' },
    ],
    toolCalls: [],
    evidence: [],
    queuedSteeringCount: 0,
    ...overrides,
  };
}

export function makeAgentEvent(
  sequence: number,
  type: AgentEventTypeV1 = 'run.stateChanged',
  runId = 'run-1',
): AgentEventV1 {
  return {
    schemaVersion: 1,
    runId,
    sequence,
    occurredAt: 1_000 + sequence,
    type,
    payload: {},
  };
}

export function makeAgentActionResult(
  action: AgentActionKindV1,
  clientActionId = 'action-1',
): AgentActionResultV1 {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    clientActionId,
    action,
    acceptedAt: 2_000,
    resultingSequence: 6,
  };
}

export function makeCompletedToolCall(): AgentToolCallSnapshotV1 {
  return {
    toolCallId: 'tool-1',
    state: 'completed',
    tool: 'shell.execReadOnly',
    arguments: { program: 'df', args: ['-h'] },
    rationale: 'Disk capacity is relevant to the reported pressure.',
    purpose: 'Inspect bounded filesystem usage.',
    successCriteria: 'Return filesystem capacity without modifying the host.',
    proposedAt: 1_000,
    operationId: 'operation-1',
    commandPreview: "'df' '-h'",
    result: {
      schemaVersion: 1,
      runId: 'run-1',
      toolCallId: 'tool-1',
      status: 'completed',
      startedAt: 1_100,
      completedAt: 1_350,
      exitCode: 0,
      stdoutExcerpt: '/dev/root 80%',
      stderrExcerpt: '',
      stdoutBytesCaptured: 13,
      stderrBytesCaptured: 0,
      stdoutBytesRead: 20,
      stderrBytesRead: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    },
    evidenceIds: ['evidence-1'],
  };
}
