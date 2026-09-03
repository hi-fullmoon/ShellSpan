import {
  AGENT_SESSION_EVENT_VERSION,
  type AgentSessionEvent,
  type AgentSessionAssistantContentBlock,
  type AgentSessionPermissionMode,
  type AgentSessionRecordedToolCall,
} from '@/types/agent-session';

export const AGENT_BASELINE_FIXTURE_VERSION = 1 as const;
export const AGENT_BASELINE_TIME_UNIX_MS = Date.parse('2026-09-03T00:00:00.000Z');
export const AGENT_BASELINE_PROVIDER = 'deepseek' as const;
export const AGENT_BASELINE_MODEL = 'deepseek-reasoner' as const;
export const AGENT_BASELINE_REASONING_LEVEL = 'medium' as const;
export const AGENT_BASELINE_PERMISSION: AgentSessionPermissionMode = 'requestApproval';

export const AGENT_BASELINE_VISUAL = {
  viewport: { width: 1280, height: 900 },
  surface: { width: 720, height: 900 },
  theme: 'light',
  locale: 'zh-CN',
  fontScale: 1,
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
} as const;

export const AGENT_BASELINE_SYSTEM_PROMPT = [
  'You are ShellSpan Agent running against the frozen Phase 0 fixture.',
  'Use only the declared read-only terminal tools and report durable evidence.',
].join('\n');

export const AGENT_BASELINE_CONTEXT = [
  'Workspace: /workspace/shellspan-fixture',
  'Target: Production A (a.example.com:22)',
  'Permission: requestApproval',
].join('\n');

const TARGET = {
  targetId: 'target-production-a',
  kind: 'remote' as const,
  sessionId: 'terminal-production-a',
  label: 'Production A',
  host: 'a.example.com',
  port: 22,
  username: 'root',
};

const TOOL_SCHEMAS = [{
  name: 'run_terminal_command',
  description: 'Run one command on the frozen SSH target.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      explanation: { type: 'string' },
    },
    required: ['command', 'explanation'],
    additionalProperties: false,
  },
}] as const;

export interface AgentBaselineUsage {
  readonly uncachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

const USER_SOURCE = {
  kind: 'user',
  label: 'User',
  producerId: 'shellspan-user',
} as const;

export interface AgentBaselineModelInput {
  readonly systemPrompt: string;
  readonly context: string;
  readonly provider: typeof AGENT_BASELINE_PROVIDER;
  readonly model: typeof AGENT_BASELINE_MODEL;
  readonly reasoningLevel: typeof AGENT_BASELINE_REASONING_LEVEL;
  readonly permission: AgentSessionPermissionMode;
  readonly toolSchemas: typeof TOOL_SCHEMAS;
}

export interface AgentSessionBaselineScenario {
  readonly fixtureVersion: typeof AGENT_BASELINE_FIXTURE_VERSION;
  readonly id: AgentSessionBaselineScenarioId;
  readonly title: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly modelInput: AgentBaselineModelInput;
  readonly expectedUsage: AgentBaselineUsage | null;
  readonly events: readonly AgentSessionEvent[];
  readonly pages?: Readonly<{
    older: readonly AgentSessionEvent[];
    current: readonly AgentSessionEvent[];
  }>;
}

export type AgentSessionBaselineScenarioId =
  | 'hello'
  | 'direct-answer'
  | 'streaming-reasoning'
  | 'single-tool'
  | 'multiple-tools'
  | 'retry-success'
  | 'provider-error'
  | 'max-tokens'
  | 'cancelled'
  | 'partial-history'
  | 'pagination'
  | 'compaction'
  | 'missing-usage';

type EventDraft = Omit<AgentSessionEvent, 'version' | 'sessionId' | 'seq' | 'timeUnixMs'>;

function modelInput(): AgentBaselineModelInput {
  return {
    systemPrompt: AGENT_BASELINE_SYSTEM_PROMPT,
    context: AGENT_BASELINE_CONTEXT,
    provider: AGENT_BASELINE_PROVIDER,
    model: AGENT_BASELINE_MODEL,
    reasoningLevel: AGENT_BASELINE_REASONING_LEVEL,
    permission: AGENT_BASELINE_PERMISSION,
    toolSchemas: TOOL_SCHEMAS,
  };
}

function commandCall(index: number): AgentSessionRecordedToolCall {
  const suffix = String(index).padStart(2, '0');
  return {
    callId: `call-terminal-${suffix}`,
    providerCallId: `provider-call-${suffix}`,
    name: 'run_terminal_command',
    nativeName: 'run_terminal_command',
    title: index === 1 ? 'Check service health' : 'Read service version',
    arguments: {
      command: index === 1 ? 'systemctl is-active nginx' : 'nginx -v',
      explanation: index === 1 ? 'Confirm nginx is active.' : 'Read the installed nginx version.',
    },
    effect: 'readOnly',
    target: TARGET,
  };
}

function eventsFor(
  scenarioId: AgentSessionBaselineScenarioId,
  build: (push: (event: EventDraft) => void) => void,
): readonly AgentSessionEvent[] {
  const events: AgentSessionEvent[] = [];
  const sessionId = `baseline-${scenarioId}`;
  const push = (draft: EventDraft): void => {
    const seq = events.length;
    events.push({
      version: AGENT_SESSION_EVENT_VERSION,
      sessionId,
      seq,
      timeUnixMs: AGENT_BASELINE_TIME_UNIX_MS + seq * 100,
      ...draft,
    } as AgentSessionEvent);
  };
  build(push);
  return events;
}

function openTurn(
  push: (event: EventDraft) => void,
  scenarioId: AgentSessionBaselineScenarioId,
  prompt: string,
): void {
  const turnId = 'turn-01';
  const stepId = 'step-01';
  push({
    type: 'session/created',
    data: {
      taskId: `task-${scenarioId}`,
      goal: prompt,
      target: TARGET,
      permissionMode: AGENT_BASELINE_PERMISSION,
      successCriteria: ['Return a deterministic fixture answer.'],
    },
  });
  push({ type: 'agent/created', data: { agentId: `agent-${scenarioId}` } });
  push({ type: 'agent/status', data: { status: 'running' } });
  push({ type: 'turn/start', turnId });
  push({ type: 'step/start', turnId, stepId });
  push({
    type: 'user/message',
    turnId,
    stepId,
    data: {
      message: {
        messageId: `message-user-${scenarioId}`,
        clientSubmissionId: `submission-${scenarioId}`,
        content: prompt,
        source: USER_SOURCE,
      },
    },
  });
  push({
    type: 'request/header',
    turnId,
    stepId,
    data: {
      requestId: 'request-01',
      providerId: AGENT_BASELINE_PROVIDER,
      model: AGENT_BASELINE_MODEL,
      reasoningEffort: AGENT_BASELINE_REASONING_LEVEL,
      reason: 'initial',
      series: { seriesId: 'series-01', requestIndex: 0, startsSeries: true },
      systemPrompt: AGENT_BASELINE_SYSTEM_PROMPT,
      toolSchemas: TOOL_SCHEMAS,
      attempt: 1,
    },
  });
  push({
    type: 'request/context',
    turnId,
    stepId,
    data: {
      requestId: 'request-01',
      inputTokens: 120,
      contextWindow: 128_000,
      systemTokens: 48,
      toolSchemaTokens: 32,
      messageTokens: 40,
      surfaceGeneration: 0,
      limited: false,
      omittedMessages: 0,
    },
  });
}

function finishTurn(
  push: (event: EventDraft) => void,
  options: Readonly<{
    content: string;
    reasoning?: string;
    interrupted?: boolean;
    usage?: AgentBaselineUsage;
    finishReason?: 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other';
    requestId?: string;
    endReason?: string;
    status?: 'completed' | 'failed' | 'cancelled';
  }>,
): void {
  const turnId = 'turn-01';
  const stepId = 'step-01';
  const content: AgentSessionAssistantContentBlock[] = [];
  if (options.reasoning) content.push({ type: 'reasoning', text: options.reasoning });
  if (options.content) content.push({ type: 'text', text: options.content });
  const usage = {
    ...(options.usage?.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: options.usage.uncachedInputTokens }),
    ...(options.usage?.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: options.usage.cacheReadTokens }),
    ...(options.usage?.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: options.usage.cacheWriteTokens }),
    ...(options.usage?.outputTokens === undefined
      ? {}
      : { outputTokens: options.usage.outputTokens }),
    ...(options.usage?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: options.usage.reasoningTokens }),
    ...(options.usage?.totalTokens === undefined
      ? {}
      : { totalTokens: options.usage.totalTokens }),
  };
  push({
    type: 'assistant/message',
    turnId,
    stepId,
    data: {
      messageId: 'message-assistant-01',
      content,
      usage,
      stopReason: options.finishReason ?? (options.interrupted ? 'cancelled' : 'stop'),
      interrupted: options.interrupted ?? false,
    },
  });
  if (options.usage) {
    push({
      type: 'request/usage',
      turnId,
      stepId,
      data: {
        requestId: options.requestId ?? 'request-01',
        usage,
        finishReason: options.finishReason ?? 'stop',
      },
    });
  }
  const endReason = options.endReason ?? 'completed';
  const status = options.status ?? 'completed';
  push({ type: 'step/end', turnId, stepId, data: { reason: endReason } });
  push({ type: 'turn/end', turnId, data: { reason: endReason } });
  push({ type: 'agent/status', data: { status } });
  push({ type: 'session/ended', data: { status } });
}

const COMPLETE_USAGE = {
  uncachedInputTokens: 56,
  outputTokens: 24,
  totalTokens: 144,
  cacheReadTokens: 64,
  cacheWriteTokens: 8,
  reasoningTokens: 10,
} as const;

function scenario(
  id: AgentSessionBaselineScenarioId,
  title: string,
  status: AgentSessionBaselineScenario['status'],
  events: readonly AgentSessionEvent[],
  expectedUsage: AgentBaselineUsage | null,
  pages?: AgentSessionBaselineScenario['pages'],
): AgentSessionBaselineScenario {
  return {
    fixtureVersion: AGENT_BASELINE_FIXTURE_VERSION,
    id,
    title,
    sessionId: `baseline-${id}`,
    taskId: `task-${id}`,
    status,
    modelInput: modelInput(),
    expectedUsage,
    events,
    ...(pages ? { pages } : {}),
  };
}

const helloEvents = eventsFor('hello', (push) => {
  openTurn(push, 'hello', 'hello');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', reasoningDelta: 'Read the frozen context. ' },
  });
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', reasoningDelta: 'Answer directly.' },
  });
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: 'Hello! How can I help?' },
  });
  finishTurn(push, {
    reasoning: 'Read the frozen context. Answer directly.',
    content: 'Hello! How can I help?',
    usage: COMPLETE_USAGE,
  });
});

const directEvents = eventsFor('direct-answer', (push) => {
  openTurn(push, 'direct-answer', 'hello');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: 'Hello! How can I help?' },
  });
  finishTurn(push, { content: 'Hello! How can I help?', usage: COMPLETE_USAGE });
});

const streamingReasoningEvents = eventsFor('streaming-reasoning', (push) => {
  openTurn(push, 'streaming-reasoning', 'hello');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', reasoningDelta: 'Read the frozen context. ' },
  });
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', reasoningDelta: 'Prepare a concise answer.' },
  });
});

function toolEvents(id: 'single-tool' | 'multiple-tools', count: 1 | 2): readonly AgentSessionEvent[] {
  return eventsFor(id, (push) => {
    openTurn(push, id, 'Check nginx and report the result.');
    const calls = Array.from({ length: count }, (_, index) => commandCall(index + 1));
    push({
      type: 'assistant/message', turnId: 'turn-01', stepId: 'step-01',
      data: {
        messageId: 'message-assistant-tools',
        content: calls.map((call) => ({ type: 'toolCall' as const, call })),
        usage: {},
        stopReason: 'toolCalls',
        interrupted: false,
      },
    });
    for (const [index, call] of calls.entries()) {
      push({ type: 'tool/call', turnId: 'turn-01', stepId: 'step-01', data: { call } });
      push({
        type: 'tool/execution', turnId: 'turn-01', stepId: 'step-01',
        data: { callId: call.callId, status: 'dispatched', idempotency: 'yes' },
      });
      push({
        type: 'tool/result', turnId: 'turn-01', stepId: 'step-01',
        data: {
          callId: call.callId,
          name: call.name,
          status: 'completed',
          summary: index === 0 ? 'active' : 'nginx/1.26.2',
          data: { exitCode: 0, output: index === 0 ? 'active' : 'nginx version: nginx/1.26.2' },
          durationMs: 200 + index * 50,
          evidenceRefs: [`evidence-terminal-${String(index + 1).padStart(2, '0')}`],
        },
      });
    }
    finishTurn(push, {
      content: count === 1 ? 'nginx is active.' : 'nginx is active and the installed version is 1.26.2.',
      usage: COMPLETE_USAGE,
    });
  });
}

const retryEvents = eventsFor('retry-success', (push) => {
  openTurn(push, 'retry-success', 'hello');
  push({
    type: 'request/retry', turnId: 'turn-01', stepId: 'step-01',
    data: {
      requestId: 'request-02',
      previousRequestId: 'request-01',
      attempt: 2,
      reason: 'fixture transport reset',
    },
  });
  push({
    type: 'request/header', turnId: 'turn-01', stepId: 'step-01',
    data: {
      requestId: 'request-02',
      providerId: AGENT_BASELINE_PROVIDER,
      model: AGENT_BASELINE_MODEL,
      reasoningEffort: AGENT_BASELINE_REASONING_LEVEL,
      reason: 'retry',
      series: { seriesId: 'series-01', requestIndex: 1, startsSeries: false },
      systemPrompt: AGENT_BASELINE_SYSTEM_PROMPT,
      toolSchemas: TOOL_SCHEMAS,
      attempt: 2,
    },
  });
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-02', textDelta: 'Hello after retry.' },
  });
  finishTurn(push, {
    content: 'Hello after retry.',
    usage: COMPLETE_USAGE,
    requestId: 'request-02',
  });
});

const providerErrorEvents = eventsFor('provider-error', (push) => {
  openTurn(push, 'provider-error', 'hello');
  push({ type: 'step/end', turnId: 'turn-01', stepId: 'step-01', data: { reason: 'provider error' } });
  push({ type: 'turn/end', turnId: 'turn-01', data: { reason: 'provider error' } });
  push({ type: 'agent/status', data: { status: 'failed', reason: 'Fixture provider unavailable.' } });
  push({ type: 'session/ended', data: { status: 'failed', reason: 'Fixture provider unavailable.' } });
});

const maxTokenEvents = eventsFor('max-tokens', (push) => {
  openTurn(push, 'max-tokens', 'List one hundred items.');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: '1. First item. 2. Second item. 3. This item was cut' },
  });
  finishTurn(push, {
    content: '1. First item. 2. Second item. 3. This item was cut',
    interrupted: true,
    usage: { uncachedInputTokens: 120, cacheReadTokens: 0, outputTokens: 64, totalTokens: 184 },
    finishReason: 'length',
    endReason: 'max tokens',
  });
});

const cancelledEvents = eventsFor('cancelled', (push) => {
  openTurn(push, 'cancelled', 'Write a long report.');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: 'The report begins with' },
  });
  finishTurn(push, {
    content: 'The report begins with',
    interrupted: true,
    endReason: 'cancelled by user',
    status: 'cancelled',
  });
});

function twoTurnHistory(id: 'partial-history' | 'pagination'): readonly AgentSessionEvent[] {
  return eventsFor(id, (push) => {
    openTurn(push, id, 'First page question.');
    push({
      type: 'assistant/message', turnId: 'turn-01', stepId: 'step-01',
      data: {
        messageId: 'message-assistant-01',
        content: [{ type: 'text', text: 'First page answer.' }],
        usage: COMPLETE_USAGE,
        stopReason: 'stop',
        interrupted: false,
      },
    });
    push({
      type: 'request/usage', turnId: 'turn-01', stepId: 'step-01',
      data: {
        requestId: 'request-01',
        usage: COMPLETE_USAGE,
        finishReason: 'stop',
      },
    });
    push({ type: 'step/end', turnId: 'turn-01', stepId: 'step-01', data: { reason: 'completed' } });
    push({ type: 'turn/end', turnId: 'turn-01', data: { reason: 'completed' } });
    push({ type: 'turn/start', turnId: 'turn-02' });
    push({ type: 'step/start', turnId: 'turn-02', stepId: 'step-02' });
    push({
      type: 'user/message', turnId: 'turn-02', stepId: 'step-02',
      data: {
        message: {
          messageId: `message-user-${id}-02`,
          clientSubmissionId: `submission-${id}-02`,
          content: 'Second page question.',
          source: USER_SOURCE,
        },
      },
    });
    push({
      type: 'request/header', turnId: 'turn-02', stepId: 'step-02',
      data: {
        requestId: 'request-02',
        providerId: AGENT_BASELINE_PROVIDER,
        model: AGENT_BASELINE_MODEL,
        reasoningEffort: AGENT_BASELINE_REASONING_LEVEL,
        reason: 'toolContinuation',
        series: { seriesId: 'series-02', requestIndex: 0, startsSeries: true },
        systemPrompt: AGENT_BASELINE_SYSTEM_PROMPT,
        toolSchemas: TOOL_SCHEMAS,
        attempt: 1,
      },
    });
    push({
      type: 'assistant/message', turnId: 'turn-02', stepId: 'step-02',
      data: {
        messageId: 'message-assistant-02',
        content: [{ type: 'text', text: 'Second page answer.' }],
        usage: {},
        stopReason: 'stop',
        interrupted: false,
      },
    });
    push({ type: 'step/end', turnId: 'turn-02', stepId: 'step-02', data: { reason: 'completed' } });
    push({ type: 'turn/end', turnId: 'turn-02', data: { reason: 'completed' } });
    push({ type: 'agent/status', data: { status: 'completed' } });
    push({ type: 'session/ended', data: { status: 'completed' } });
  });
}

const partialFullEvents = twoTurnHistory('partial-history');
const partialEvents = partialFullEvents.slice(13);
const paginationEvents = twoTurnHistory('pagination');
const paginationSplit = 12;

const compactionBaseEvents = eventsFor('compaction', (push) => {
  openTurn(push, 'compaction', 'hello after compaction');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: 'Hello after compaction.' },
  });
  finishTurn(push, { content: 'Hello after compaction.', usage: COMPLETE_USAGE });
});
const compactionTerminalIndex = compactionBaseEvents.findIndex((event) => (
  event.type === 'agent/status' && event.data.status === 'completed'
));
const compactionEvents = [
  ...compactionBaseEvents.slice(0, compactionTerminalIndex),
  {
    type: 'compaction/start' as const,
    data: { reason: 'fixture context pressure' },
  },
  {
    type: 'compaction/summary' as const,
    data: { summary: 'Earlier context was compacted.', replacedThroughSeq: 6, surfaceGeneration: 1 },
  },
  {
    type: 'compaction/end' as const,
    data: { surfaceGeneration: 1, replacedThroughSeq: 6, status: 'completed' as const },
  },
  ...compactionBaseEvents.slice(compactionTerminalIndex),
].map((event, seq) => ({
  ...event,
  version: AGENT_SESSION_EVENT_VERSION,
  sessionId: 'baseline-compaction',
  seq,
  timeUnixMs: AGENT_BASELINE_TIME_UNIX_MS + seq * 100,
})) as readonly AgentSessionEvent[];

const missingUsageEvents = eventsFor('missing-usage', (push) => {
  openTurn(push, 'missing-usage', 'hello');
  push({
    type: 'assistant/chunk', turnId: 'turn-01', stepId: 'step-01',
    data: { requestId: 'request-01', textDelta: 'Hello without provider usage.' },
  });
  finishTurn(push, { content: 'Hello without provider usage.' });
});

export const agentSessionBaselineScenarios: Readonly<Record<
  AgentSessionBaselineScenarioId,
  AgentSessionBaselineScenario
>> = {
  hello: scenario('hello', 'Hello with context and reasoning', 'completed', helloEvents, COMPLETE_USAGE),
  'direct-answer': scenario('direct-answer', 'Direct answer without reasoning', 'completed', directEvents, COMPLETE_USAGE),
  'streaming-reasoning': scenario(
    'streaming-reasoning', 'Streaming reasoning', 'running', streamingReasoningEvents, null,
  ),
  'single-tool': scenario('single-tool', 'Single tool call and result', 'completed', toolEvents('single-tool', 1), COMPLETE_USAGE),
  'multiple-tools': scenario('multiple-tools', 'Multiple tool calls', 'completed', toolEvents('multiple-tools', 2), COMPLETE_USAGE),
  'retry-success': scenario('retry-success', 'Retry then success', 'completed', retryEvents, COMPLETE_USAGE),
  'provider-error': scenario('provider-error', 'Provider error', 'failed', providerErrorEvents, null),
  'max-tokens': scenario(
    'max-tokens', 'Maximum output tokens', 'completed', maxTokenEvents,
    { uncachedInputTokens: 120, cacheReadTokens: 0, outputTokens: 64, totalTokens: 184 },
  ),
  cancelled: scenario('cancelled', 'Cancelled response', 'cancelled', cancelledEvents, null),
  'partial-history': scenario(
    'partial-history', 'Partial history window', 'completed', partialEvents, COMPLETE_USAGE,
    { older: partialFullEvents.slice(0, 12), current: partialEvents },
  ),
  pagination: scenario(
    'pagination', 'Pagination prepend', 'completed', paginationEvents, COMPLETE_USAGE,
    { older: paginationEvents.slice(0, paginationSplit), current: paginationEvents.slice(paginationSplit) },
  ),
  compaction: scenario(
    'compaction', 'Compacted conversation', 'completed', compactionEvents, COMPLETE_USAGE,
  ),
  'missing-usage': scenario('missing-usage', 'Provider omitted usage', 'completed', missingUsageEvents, null),
};

export const agentSessionBaselineScenarioIds = Object.freeze(
  Object.keys(agentSessionBaselineScenarios) as AgentSessionBaselineScenarioId[],
);

export function agentSessionBaselineScenario(
  id: string | null | undefined,
): AgentSessionBaselineScenario {
  if (id && id in agentSessionBaselineScenarios) {
    return agentSessionBaselineScenarios[id as AgentSessionBaselineScenarioId];
  }
  return agentSessionBaselineScenarios.hello;
}
