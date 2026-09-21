import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useConversationHistory } from '../workspace/use-conversation-history';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import type { AiConversationNode } from '@/lib/ai/conversation-node';

// Use actual runtime nodes with a small page to exercise every boundary.
const nodes = projectAgentChatNodes(taskTokenBudgetEvidence.events);

it('bounds a live conversation that grows from empty without remounting its prefix on detach', () => {
  const { result, rerender } = renderHook(({ current }) => useConversationHistory(current, 2), {
    initialProps: { current: [] as readonly AiConversationNode[] },
  });
  for (let count = 1; count <= nodes.length; count += 1) {
    rerender({ current: nodes.slice(0, count) });
    expect(result.current.nodes).toEqual(nodes.slice(Math.max(0, count - 2), count));
  }
  const firstKey = result.current.nodes[0].key;
  act(() => result.current.saveAnchor({ nodeKey: firstKey, offset: 0, scrollTop: 0, atBottom: false }));
  expect(result.current.nodes[0].key).toBe(firstKey);
});

it('preserves a reader and explicitly expanded history until following resumes', () => {
  const { result, rerender } = renderHook(({ current }) => useConversationHistory(current, 2), {
    initialProps: { current: nodes.slice(0, 3) as readonly AiConversationNode[] },
  });
  const firstKey = result.current.nodes[0].key;
  act(() => result.current.saveAnchor({ nodeKey: firstKey, offset: 0, scrollTop: 0, atBottom: false }));
  rerender({ current: nodes });
  expect(result.current.nodes[0].key).toBe(firstKey);
  act(() => result.current.revealOlder());
  expect(result.current.nodes).toEqual(nodes);
  // A programmatic scroll caused by prepending must not immediately undo it.
  act(() => result.current.saveAnchor({ nodeKey: nodes[0].key, offset: 0, scrollTop: 0, atBottom: true }));
  expect(result.current.nodes).toEqual(nodes);
  act(() => result.current.resumeFollowing());
  expect(result.current.nodes).toEqual(nodes.slice(-2));
});

it('preserves older nodes delivered by the external loader', () => {
  const { result, rerender } = renderHook(({ current }) => useConversationHistory(current, 2), {
    initialProps: { current: nodes.slice(-2) as readonly AiConversationNode[] },
  });
  act(() => result.current.revealOlder());
  rerender({ current: nodes });
  expect(result.current.nodes).toEqual(nodes);
});
