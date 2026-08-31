import { describe, expect, it } from 'vitest';
import {
  AGENT_TERMINAL_CONTEXT_OMISSION_MARKER,
  AI_HISTORY_MAX_MESSAGE_BYTES,
  AI_HISTORY_OMISSION_MARKER,
  AI_REQUEST_MAX_MESSAGE_BYTES,
  AI_REQUEST_MAX_MESSAGES_BYTES,
  aiUtf8ByteLength,
  boundAiHistory,
  buildBoundedAgentUserMessage,
  isAiMessageContentWithinLimit,
} from '@/lib/ai-request-budget';
import type { AiMessageInput } from '@/types/ai';

interface Candidate extends AiMessageInput {
  requestId: string;
}

const toMessage = ({ role, content }: Candidate): AiMessageInput => ({ role, content });

describe('AI request history budget', () => {
  it('UTF-8 safely truncates one long historical response while preserving both ends', () => {
    const longResponse = `HEAD-${'你😀'.repeat(20_000)}-TAIL`;
    const candidates: Candidate[] = [
      { requestId: 'latest', role: 'user', content: 'What happened?' },
      { requestId: 'latest', role: 'assistant', content: longResponse },
    ];
    const current: AiMessageInput = { role: 'user', content: 'What should I do next?' };

    const result = boundAiHistory(candidates, toMessage, [current]);
    const assistant = result.messages[1];

    expect(assistant.content).toMatch(/^HEAD-/);
    expect(assistant.content).toContain(AI_HISTORY_OMISSION_MARKER.trim());
    expect(assistant.content).toMatch(/-TAIL$/);
    expect(assistant.content).not.toContain('\uFFFD');
    expect(aiUtf8ByteLength(assistant.content)).toBeLessThanOrEqual(
      AI_HISTORY_MAX_MESSAGE_BYTES,
    );
    expect(result.byteLength + aiUtf8ByteLength(current.content)).toBeLessThanOrEqual(
      AI_REQUEST_MAX_MESSAGES_BYTES,
    );
    expect(result.metadata).toMatchObject({
      omittedTurns: 0,
      omittedMessages: 0,
      truncatedMessages: 1,
    });
    expect(candidates[1].content).toBe(longResponse);
  });

  it('keeps the newest complete request turns and omits older turns as units', () => {
    const candidates = Array.from({ length: 8 }, (_, index): Candidate[] => ([
      { requestId: `request-${index}`, role: 'user', content: `question-${index}` },
      { requestId: `request-${index}`, role: 'assistant', content: `answer-${index}` },
    ])).flat();

    const result = boundAiHistory(candidates, toMessage);

    expect(result.messages).toHaveLength(12);
    expect(result.messages[0].content).toBe('question-2');
    expect(result.messages[1].content).toBe('answer-2');
    expect(result.messages[result.messages.length - 1]?.content).toBe('answer-7');
    expect(result.metadata).toMatchObject({
      omittedTurns: 2,
      omittedMessages: 4,
      truncatedMessages: 0,
    });
  });

  it('reserves the current message byte budget and never sends a partial older turn', () => {
    const candidates: Candidate[] = [
      { requestId: 'older', role: 'user', content: 'o'.repeat(10) },
      { requestId: 'older', role: 'assistant', content: 'a'.repeat(10) },
      { requestId: 'latest', role: 'user', content: 'q'.repeat(20) },
      { requestId: 'latest', role: 'assistant', content: 'r'.repeat(20) },
    ];
    const current: AiMessageInput = { role: 'user', content: 'n'.repeat(30) };

    const result = boundAiHistory(candidates, toMessage, [current], {
      maxHistoryBytes: 70,
      maxRequestBytes: 80,
      maxHistoryMessageBytes: 64,
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      'q'.repeat(20),
      'r'.repeat(20),
    ]);
    expect(result.byteLength).toBe(40);
    expect(result.metadata).toMatchObject({ omittedTurns: 1, omittedMessages: 2 });
  });

  it('stays within the exact 256 KiB total when the current message uses 128 KiB', () => {
    const candidates: Candidate[] = [
      { requestId: 'latest', role: 'user', content: 'u'.repeat(128 * 1024) },
      { requestId: 'latest', role: 'assistant', content: 'a'.repeat(128 * 1024) },
    ];
    const current: AiMessageInput = {
      role: 'user',
      content: 'n'.repeat(AI_REQUEST_MAX_MESSAGE_BYTES),
    };

    const result = boundAiHistory(candidates, toMessage, [current]);
    const totalBytes = result.byteLength + aiUtf8ByteLength(current.content);

    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((message) => (
      aiUtf8ByteLength(message.content) <= AI_HISTORY_MAX_MESSAGE_BYTES
    ))).toBe(true);
    expect(totalBytes).toBeLessThanOrEqual(AI_REQUEST_MAX_MESSAGES_BYTES);
    expect(result.metadata.truncatedMessages).toBe(2);
  });

  it('matches the Rust per-message limit using UTF-8 bytes', () => {
    expect(isAiMessageContentWithinLimit('x'.repeat(AI_REQUEST_MAX_MESSAGE_BYTES))).toBe(true);
    expect(isAiMessageContentWithinLimit('x'.repeat(AI_REQUEST_MAX_MESSAGE_BYTES + 1))).toBe(false);
    expect(isAiMessageContentWithinLimit('你'.repeat(43_690))).toBe(true);
    expect(isAiMessageContentWithinLimit('你'.repeat(43_691))).toBe(false);
  });
});

describe('Agent current-message budget', () => {
  it('budgets the final JSON serialization and keeps the newest terminal context', () => {
    const context = {
      label: 'root@server',
      content: `${'path="C:\\\\tmp" 你😀\n'.repeat(12_000)}latest-result`,
    };

    const result = buildBoundedAgentUserMessage('Diagnose the failure', context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byteLength).toBeLessThanOrEqual(AI_REQUEST_MAX_MESSAGE_BYTES);
    expect(result.terminalContextTruncated).toBe(true);
    expect(result.message.content).toMatch(/^Diagnose the failure/);
    expect(result.message.content).toContain(AGENT_TERMINAL_CONTEXT_OMISSION_MARKER.trim());
    expect(result.message.content).toContain('latest-result');
    expect(result.message.content).not.toContain('\uFFFD');
  });

  it('never silently truncates an oversized user goal', () => {
    const goal = '你'.repeat(Math.floor(AI_REQUEST_MAX_MESSAGE_BYTES / 3) + 1);

    const result = buildBoundedAgentUserMessage(goal, {
      label: 'root@server',
      content: 'terminal output',
    });

    expect(result).toEqual({
      ok: false,
      byteLength: aiUtf8ByteLength(goal),
      maxBytes: AI_REQUEST_MAX_MESSAGE_BYTES,
    });
  });

  it('keeps a small terminal context intact', () => {
    const result = buildBoundedAgentUserMessage('Check nginx', {
      label: 'root@server',
      content: 'active (running)',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terminalContextTruncated).toBe(false);
    expect(result.message.content).toContain('active (running)');
    expect(result.message.content).toContain('<terminal_context_json>');
  });
});
