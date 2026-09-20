import { describe, expect, it } from 'vitest';
import { chatReferenceFile } from '../chat-reference';
import { projectAgentChatNodes } from '../conversation-projection';
import { agentSessionEventFixture } from '@/test/fixtures/agent-session';
import type { AiSessionSummary } from '../session-adapter';

const summary: AiSessionSummary = {
  id: agentSessionEventFixture[0].sessionId, kind: 'agent', title: 'Check nginx now.',
  updatedAt: new Date(agentSessionEventFixture[0].timeUnixMs).toISOString(), status: 'idle', scopeKey: 'terminal-fixture', archived: false,
};

describe('chat references', () => {
  it('exports projected human and assistant text, excluding internal context and tools', async () => {
    const file = chatReferenceFile(summary, projectAgentChatNodes(agentSessionEventFixture));
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(file);
    });
    expect(file.name).toBe('Check nginx now..txt');
    expect(text).toContain('Check nginx now.');
    expect(text).toContain('Checking now.');
    expect(text).not.toContain('You are the ShellSpan Agent fixture.');
    expect(text).not.toContain('run_terminal_command');
    expect(JSON.parse(text).messages.every((message: { role: string }) => ['user', 'assistant'].includes(message.role))).toBe(true);
  });

  it('rejects a conversation without text instead of attaching an empty reference', () => {
    expect(() => chatReferenceFile(summary, [])).toThrow('CHAT_REFERENCE_EMPTY');
  });
});
