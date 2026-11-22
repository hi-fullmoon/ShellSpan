import { describe, expect, it } from 'vitest';
import type { AiConversationNode } from '../conversation-node';
import {
  exportConversationFileName,
  formatConversationMarkdown,
  hasExportableConversationMessages,
} from '../conversation-export';

describe('conversation-export', () => {
  const base = {
    sourceKind: 'agent' as const,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: null,
    firstSeq: 1,
    lastSeq: 1,
    timestamp: '2026-11-22T12:00:00.000Z',
  };

  it('exports only committed user messages and visible assistant prose, omitting internal prompts and reasoning', () => {
    const nodes: AiConversationNode[] = [
      {
        ...base,
        kind: 'systemPrompt',
        key: 'sys:1',
        requestId: 'req-1',
        requestIds: ['req-1'],
        providerId: 'openai',
        model: 'gpt-4o',
        reasoningEffort: null,
        seriesId: 'series-1',
        content: 'SECRET SYSTEM PROMPT',
        toolSchemas: [],
      },
      { ...base, kind: 'userMessage', key: 'user:1', messageId: 'm1', content: 'Check nginx status', delivery: 'committed' },
      { ...base, kind: 'userMessage', key: 'user:pending', messageId: 'm2', content: 'unsent draft', delivery: 'pending' },
      { ...base, kind: 'reasoning', key: 'reason:1', requestId: 'r1', summary: 'internal thought', content: 'internal thought', state: 'completed' },
      {
        ...base,
        kind: 'assistantMessage',
        key: 'asst:1',
        messageId: 'a1',
        requestId: 'r1',
        state: 'completed',
        blocks: [
          { type: 'reasoning', text: 'hidden reasoning block' },
          { type: 'text', text: 'Nginx is active.\n\n```bash\nsystemctl status nginx\n```' },
        ],
      },
    ];

    expect(hasExportableConversationMessages(nodes)).toBe(true);
    const md = formatConversationMarkdown({
      title: 'Prod Nginx Check',
      nodes,
      userLabel: 'User',
      assistantLabel: 'Assistant',
    });
    expect(md).toContain('# Prod Nginx Check');
    expect(md).toContain('## User\n\nCheck nginx status');
    expect(md).toContain('## Assistant\n\nNginx is active.');
    expect(md).not.toContain('SECRET SYSTEM PROMPT');
    expect(md).not.toContain('unsent draft');
    expect(md).not.toContain('internal thought');
    expect(md).not.toContain('hidden reasoning block');
  });

  it('sanitizes export file names and falls back for blank titles', () => {
    expect(exportConversationFileName('prod/web:01 *check*')).toBe('prod-web-01 -check-.md');
    expect(exportConversationFileName('   ')).toBe('shellspan-conversation.md');
  });
});
