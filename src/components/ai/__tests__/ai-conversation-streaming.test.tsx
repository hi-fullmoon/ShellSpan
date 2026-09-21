import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { AiConversationNodeSeat } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import { initI18n } from '@/locales';

afterEach(cleanup);

it('preserves the process panel, focus and disclosure state across model requests', async () => {
  await initI18n('en-US');
  const { events } = agentSessionBaselineScenarios['retry-success'];
  const requests = events.flatMap((event, index) => event.type === 'request/header' ? [index] : []);
  expect(requests).toHaveLength(2);
  const processAt = (length: number) => {
    const node = projectAgentChatNodes(events.slice(0, length)).find((node) => node.kind === 'turnProcess');
    if (!node) throw new Error('Expected a projected process panel');
    return node;
  };
  const before = processAt(requests[1]);
  const next = processAt(requests[1] + 1);
  expect(next.answerGeneration).not.toBe(before.answerGeneration);
  const { container, rerender } = render(<AiConversationNodeSeat node={before} />);
  const panel = container.querySelector('.ai-turn-process')!;
  const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  trigger.focus();
  rerender(<AiConversationNodeSeat node={next} />);
  expect(container.querySelector('.ai-turn-process')).toBe(panel);
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(trigger);
  rerender(<AiConversationNodeSeat node={processAt(events.length)} />);
  expect(container.querySelector('.ai-turn-process')).toBe(panel);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

it('lays out every row immediately after history has been paged', async () => {
  await initI18n('en-US');
  const { events } = agentSessionBaselineScenarios.pagination;
  const nodes = projectAgentChatNodes(events);
  const { container } = render(<AiConversation nodes={nodes} status="completed" throughSeq={null} />);
  nodes.forEach((node) => {
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-ai-node-key]'))
      .find((element) => element.dataset.aiNodeKey === node.key)!
      .closest('[data-slot="message-scroller-item"]');
    expect(row).toHaveClass('[content-visibility:visible]', '[contain-intrinsic-size:none]');
  });
});

it('uses the running indicator actual height while following streamed output', async () => {
  await initI18n('zh-CN');
  const { container, rerender } = render(
    <AiConversation nodes={[]} status="running" throughSeq={null} />,
  );
  const indicator = container.querySelector('[data-ai-running-indicator]');
  const row = indicator?.closest('[data-slot="message-scroller-item"]');
  expect(row).toHaveClass('[content-visibility:visible]', '[contain-intrinsic-size:none]');

  rerender(<AiConversation nodes={[]} status="waiting" throughSeq={null} />);
  expect(container.querySelector('[data-ai-running-indicator]')?.closest('[data-slot="message-scroller-item"]'))
    .toHaveClass('[content-visibility:visible]', '[contain-intrinsic-size:none]');
});
