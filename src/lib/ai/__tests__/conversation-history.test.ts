import { expect, it } from 'vitest';
import { initialConversationHistoryIndex } from '../conversation-history';
import { projectAgentChatNodes } from '../conversation-projection';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';

const nodes = projectAgentChatNodes(taskTokenBudgetEvidence.events);

it('limits initial history while preserving saved reading positions', () => {
  expect(nodes.length).toBeGreaterThan(2);
  expect(initialConversationHistoryIndex(nodes, 2)).toBe(nodes.length - 2);
  expect(initialConversationHistoryIndex(nodes, 80)).toBe(0);
  const anchor = { nodeKey: nodes[0].key, offset: -20, scrollTop: 120, atBottom: false };
  expect(initialConversationHistoryIndex(nodes, 2, anchor)).toBe(0);
  expect(initialConversationHistoryIndex(nodes, 2, { ...anchor, atBottom: true })).toBe(nodes.length - 2);
  expect(initialConversationHistoryIndex(nodes, 2, { ...anchor, nodeKey: 'removed' })).toBe(0);
});
