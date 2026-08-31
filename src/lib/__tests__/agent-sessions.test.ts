import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentConversationData,
  hydrateAgentSession,
  persistAgentRunState,
} from '@/lib/agent-sessions';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import type { AiSessionFile } from '@/types/ai';
import type { PersistedAgentStateEnvelope } from '@/types/agent';

const tauri = vi.hoisted(() => ({
  appendAgentState: vi.fn(async (
    _conversationId: string,
    _startedAt: string,
    _state: unknown,
  ) => {}),
  clearLane: vi.fn(async (
    _conversationId: string,
    _startedAt: string,
    _lane: string,
  ) => {}),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAppendAiSessionAgentState: tauri.appendAgentState,
  invokeClearAiSessionLane: tauri.clearLane,
}));

const target = {
  kind: 'remote' as const,
  sessionId: 'session-agent',
  host: 'example.test',
  port: 22,
  username: 'root',
};

function beginRun(requestId: string, conversationId: string): void {
  useAgentStore.getState().beginRun({
    requestId,
    conversationId,
    conversationStartedAt: '2026-08-28T00:00:00.000Z',
    goal: 'Inspect service',
    providerId: 'openai',
    target,
    targetTitle: 'Agent target',
    permissionMode: 'requestApproval',
    rolloutStage: 'preview',
  });
}

function persistedEnvelopes(): PersistedAgentStateEnvelope[] {
  return tauri.appendAgentState.mock.calls.map((call) => (
    call[2] as PersistedAgentStateEnvelope
  ));
}

function replayPersistedContent(
  current: string,
  envelope: PersistedAgentStateEnvelope,
  messageId: string,
): string {
  if (envelope.kind !== 'patch') return current;
  let currentBytes = new TextEncoder().encode(current);
  for (const message of envelope.messages ?? []) {
    if (message.id !== messageId || message.appendContent === undefined) continue;
    const appendedBytes = new TextEncoder().encode(message.appendContent);
    const offset = message.contentOffsetBytes;
    if (offset === undefined) throw new Error('new content patch is missing its offset');
    const available = currentBytes.byteLength - offset;
    if (available < 0) throw new Error('content patch has a gap');
    const overlap = Math.min(available, appendedBytes.byteLength);
    expect(Array.from(currentBytes.slice(offset, offset + overlap))).toEqual(
      Array.from(appendedBytes.slice(0, overlap)),
    );
    if (available >= appendedBytes.byteLength) continue;
    const missing = appendedBytes.slice(overlap);
    const combined = new Uint8Array(currentBytes.byteLength + missing.byteLength);
    combined.set(currentBytes);
    combined.set(missing, currentBytes.byteLength);
    currentBytes = combined;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(currentBytes);
}

describe('Agent session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.appendAgentState.mockReset();
    tauri.appendAgentState.mockResolvedValue(undefined);
    tauri.clearLane.mockReset();
    tauri.clearLane.mockResolvedValue(undefined);
    useAgentStore.setState({
      messages: [],
      runs: {},
      tools: {},
      activeRequestId: undefined,
    });
  });

  it('deeply redacts a run snapshot and strips actionable approval ids before IPC', async () => {
    beginRun('request-agent', 'conversation-agent');
    useAgentStore.getState().registerTool({
      toolCall: {
        requestId: 'request-agent',
        callId: 'call-agent',
        name: 'run_terminal_command',
        command: 'curl --api-key nested-command-secret https://example.test',
        explanation: 'Inspect the endpoint.',
        target,
      },
      permissionMode: 'requestApproval',
      riskAssessment: { risk: 'stateChange', reason: 'unrecognizedStateChange' },
      decision: { requiresApproval: true, reason: 'modeRequiresApproval' },
      status: 'awaitingApproval',
      approval: {
        requestId: 'request-agent',
        callId: 'call-agent',
        approvalId: 'actionable-approval',
      },
    });

    await persistAgentRunState('request-agent');

    expect(tauri.appendAgentState).toHaveBeenCalledTimes(1);
    const persisted = tauri.appendAgentState.mock.calls[0][2];
    const encoded = JSON.stringify(persisted);
    expect(persisted).toMatchObject({ kind: 'checkpoint', version: 1 });
    expect(encoded).not.toContain('nested-command-secret');
    expect(encoded).not.toContain('actionable-approval');
    expect(useAgentStore.getState().tools[
      agentToolKey('request-agent', 'call-agent')
    ].toolCall.command).toContain('nested-command-secret');
  });

  it('uses the backend redaction form as the persisted content-offset baseline', async () => {
    const requestId = 'request-redaction-offset';
    beginRun(requestId, 'conversation-redaction-offset');
    useAgentStore.getState().appendText(requestId, 'password=super-secret');

    await persistAgentRunState(requestId);

    const [checkpoint] = persistedEnvelopes();
    expect(checkpoint).toMatchObject({
      kind: 'checkpoint',
      state: {
        messages: [{ role: 'user' }, { content: '' }],
      },
    });
    expect(JSON.stringify(checkpoint)).not.toContain('super-secret');

    useAgentStore.getState().finishRun(requestId, 'completed');
    await persistAgentRunState(requestId);

    expect(persistedEnvelopes()[1]).toMatchObject({
      kind: 'patch',
      messages: [{ appendContent: '[REDACTED]', contentOffsetBytes: 0 }],
    });
    expect(JSON.stringify(persistedEnvelopes())).not.toContain('super-secret');
  });

  it('withholds an unstable streaming tail until split credentials are redacted', async () => {
    const requestId = 'request-split-secret';
    beginRun(requestId, 'conversation-split-secret');
    await persistAgentRunState(requestId);

    useAgentStore.getState().appendText(requestId, 'https://alice:s3cr3t');
    await persistAgentRunState(requestId);
    useAgentStore.getState().appendText(requestId, '@example.test');
    await persistAgentRunState(requestId);

    expect(JSON.stringify(persistedEnvelopes())).not.toContain('s3cr3t');
    useAgentStore.getState().finishRun(requestId, 'completed');
    await persistAgentRunState(requestId);

    const encoded = JSON.stringify(persistedEnvelopes());
    expect(encoded).not.toContain('s3cr3t');
    expect(encoded).not.toContain('alice');
    expect(encoded).toContain('[REDACTED]');
  });

  it('persists streaming text and growing tool ids as incremental patches', async () => {
    beginRun('request-incremental', 'conversation-incremental');
    await persistAgentRunState('request-incremental');

    useAgentStore.getState().appendText('request-incremental', 'first chunk');
    await persistAgentRunState('request-incremental');
    useAgentStore.getState().appendText('request-incremental', ' + second chunk');
    await persistAgentRunState('request-incremental');

    useAgentStore.getState().registerTool({
      toolCall: {
        requestId: 'request-incremental',
        callId: 'call-incremental',
        name: 'run_terminal_command',
        command: 'uptime',
        explanation: 'Inspect uptime.',
        target,
      },
      permissionMode: 'requestApproval',
      riskAssessment: { risk: 'readOnly', reason: 'readOnlyAllowlist' },
      decision: { requiresApproval: true, reason: 'modeRequiresApproval' },
      status: 'awaitingApproval',
    });
    await persistAgentRunState('request-incremental');

    const envelopes = persistedEnvelopes();
    expect(envelopes[0]).toMatchObject({ kind: 'checkpoint', version: 1 });
    expect(envelopes[1]).toMatchObject({
      kind: 'patch',
      requestId: 'request-incremental',
      messages: [{
        id: 'agent-assistant-request-incremental',
        appendContent: 'first chunk',
        contentOffsetBytes: 0,
      }],
    });
    expect(envelopes[2]).toMatchObject({
      kind: 'patch',
      messages: [{
        appendContent: ' + second chunk',
        contentOffsetBytes: new TextEncoder().encode('first chunk').byteLength,
      }],
    });
    expect(JSON.stringify(envelopes[2])).not.toContain('first chunk');

    const toolPatch = envelopes[3];
    expect(toolPatch).toMatchObject({
      kind: 'patch',
      run: { appendToolCallIds: ['call-incremental'] },
      tools: [{ toolCall: { callId: 'call-incremental' } }],
    });
    if (toolPatch.kind !== 'patch') throw new Error('expected Agent patch');
    expect(toolPatch.run?.set).not.toHaveProperty('toolCallIds');
    expect(toolPatch.messages?.some((message) => (
      message.appendToolCallIds?.includes('call-incremental')
    ))).toBe(true);
  });

  it('emits byte offsets that make an ambiguous append retry idempotent', async () => {
    const requestId = 'request-idempotent';
    const messageId = `agent-assistant-${requestId}`;
    const prefix = '前缀';
    const durablyWritten = '已写入';
    const resumed = '，继续';
    beginRun(requestId, 'conversation-idempotent');
    useAgentStore.getState().appendText(requestId, prefix);
    await persistAgentRunState(requestId);

    let durableContent = prefix;
    let rejectAfterDurableWrite = true;
    tauri.appendAgentState.mockImplementation(async (
      _conversationId: string,
      _startedAt: string,
      state: unknown,
    ) => {
      durableContent = replayPersistedContent(
        durableContent,
        state as PersistedAgentStateEnvelope,
        messageId,
      );
      if (rejectAfterDurableWrite) {
        rejectAfterDurableWrite = false;
        throw new Error('IPC response lost after durable append');
      }
    });

    useAgentStore.getState().appendText(requestId, durablyWritten);
    await expect(persistAgentRunState(requestId)).rejects.toThrow('IPC response lost');
    expect(durableContent).toBe(prefix + durablyWritten);

    useAgentStore.getState().appendText(requestId, resumed);
    await persistAgentRunState(requestId);

    const [failedPatch, retryPatch] = persistedEnvelopes().slice(1);
    const prefixBytes = new TextEncoder().encode(prefix).byteLength;
    expect(failedPatch).toMatchObject({
      kind: 'patch',
      messages: [{ appendContent: durablyWritten, contentOffsetBytes: prefixBytes }],
    });
    expect(retryPatch).toMatchObject({
      kind: 'patch',
      messages: [{
        appendContent: durablyWritten + resumed,
        contentOffsetBytes: prefixBytes,
      }],
    });
    expect(durableContent).toBe(prefix + durablyWritten + resumed);
  });

  it('keeps write amplification linear for a session larger than 1 MiB', async () => {
    const requestId = 'request-long';
    beginRun(requestId, 'conversation-long');
    await persistAgentRunState(requestId);

    const chunk = 'x'.repeat(16 * 1024);
    for (let index = 0; index < 72; index += 1) {
      useAgentStore.getState().appendText(requestId, chunk);
      await persistAgentRunState(requestId);
    }
    useAgentStore.getState().finishRun(requestId, 'completed');
    await persistAgentRunState(requestId);

    const envelopes = persistedEnvelopes();
    const encodedSizes = envelopes.map((envelope) => (
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength
    ));
    const totalEncodedBytes = encodedSizes.reduce((total, size) => total + size, 0);
    const finalMessage = useAgentStore.getState().messages.find((message) => (
      message.id === `agent-assistant-${requestId}`
    ));
    expect(finalMessage?.content.length).toBeGreaterThan(1024 * 1024);
    expect(envelopes.slice(1).every((envelope) => envelope.kind === 'patch')).toBe(true);
    expect(Math.max(...encodedSizes)).toBeLessThan(32 * 1024);
    expect(totalEncodedBytes).toBeLessThan((finalMessage?.content.length ?? 0) * 1.1);
  });

  it('hydrates legacy full snapshots as cancelled and never creates an active request', () => {
    const session: AiSessionFile = {
      conversation: {
        id: 'conversation-agent',
        startedAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:01:00.000Z',
        title: 'Agent target',
        archived: true,
        host: 'example.test',
        port: 22,
        username: 'root',
      },
      messages: [],
      agentStates: [{
        run: {
          requestId: 'request-agent',
          conversationId: 'conversation-agent',
          conversationStartedAt: '2026-08-28T00:00:00.000Z',
          goal: 'Inspect service',
          providerId: 'openai',
          target,
          targetTitle: 'Agent target',
          permissionMode: 'fullAccess',
          rolloutStage: 'preview',
          toolCallIds: [],
          phase: 'analyzing',
          status: 'running',
          stopRequested: false,
        },
        messages: [],
        tools: [],
      }],
    };

    hydrateAgentSession(session);

    expect(useAgentStore.getState().activeRequestId).toBeUndefined();
    expect(useAgentStore.getState().runs['request-agent']).toMatchObject({
      status: 'cancelled',
      permissionMode: 'fullAccess',
    });
  });

  it('clears the persisted Agent lane before clearing only that conversation in memory', async () => {
    beginRun('request-agent', 'conversation-agent');
    useAgentStore.getState().cancelRun('request-agent');

    await clearAgentConversationData(
      'conversation-agent',
      '2026-08-28T00:00:00.000Z',
    );

    expect(tauri.clearLane).toHaveBeenCalledWith(
      'conversation-agent',
      '2026-08-28T00:00:00.000Z',
      'agent',
    );
    expect(useAgentStore.getState().messages).toEqual([]);
  });
});
