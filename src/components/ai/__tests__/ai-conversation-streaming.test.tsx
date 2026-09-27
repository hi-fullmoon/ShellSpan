import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { AiConversationNodeSeat } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
import type { AgentSessionEvent } from '@/types/agent-session';

afterEach(cleanup);

it('completes the footer without a processing row from recorded turn events', async () => {
  await initI18n('en-US');
  const events = skillsCapture as unknown as AgentSessionEvent[];
  const end = events.findIndex(event => event.type === 'turn/end');
  const message = events.map(event => event.type).lastIndexOf('assistant/message');
  expect(message).toBeLessThan(end);
  const at = (length: number) => projectAgentChatNodes(events.slice(0, length));
  const { container, rerender } = render(
    <AiConversation nodes={at(message + 1)} status="running" throughSeq={events[message].seq} />,
  );
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('.ai-assistant-actions')).toBeNull();
  expect(container.querySelector('[data-ai-node-kind="turnTail"]')).toBeNull();

  const nodes = at(end + 1);
  rerender(<AiConversation nodes={nodes} status="running" throughSeq={events[end].seq} />);
  const footer = container.querySelector('[data-ai-node-kind="turnTail"]');
  expect(footer).toBeInTheDocument();
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('[data-slot="message-scroller-button"] .ai-scroll-loading')).toBeNull();
  rerender(<AiConversation nodes={nodes} status="idle" throughSeq={events[end].seq} />);
  expect(container.querySelector('[data-ai-node-kind="turnTail"]')).toBe(footer);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();

  rerender(<AiConversation nodes={nodes} status="running" pending throughSeq={events[end].seq} />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('[data-slot="message-scroller-button"] .ai-scroll-loading')).toBeInTheDocument();
});

it('keeps standalone message actions when no complete turn boundary is available', async () => {
  await initI18n('en-US');
  const events = skillsCapture as unknown as AgentSessionEvent[];
  const message = events.map(event => event.type).lastIndexOf('assistant/message');
  const nodes = projectAgentChatNodes(events.slice(0, message + 1));
  const { container, rerender } = render(<AiConversation nodes={nodes} status="running" throughSeq={null} />);
  expect(container.querySelector('.ai-assistant-actions')).toBeNull();
  // The same message can be rendered outside its parent turn, e.g. a partial
  // history page. Its fallback copy action must remain available there.
  rerender(<AiConversation nodes={nodes.filter(node => node.kind !== 'turnProcess')} status="idle" throughSeq={null} />);
  expect(container.querySelector('.ai-assistant-actions')).toBeInTheDocument();
  rerender(<AiConversation nodes={nodes} status="failed" throughSeq={null} />);
  expect(container.querySelector('.ai-assistant-actions')).toBeInTheDocument();
});

it('animates the latest-message button only while generating or submitting', async () => {
  await initI18n('en-US');
  const { container, rerender } = render(<AiConversation nodes={[]} status="running" throughSeq={null} />);
  const spinner = () => container.querySelector('[data-slot="message-scroller-button"] .ai-scroll-loading');
  expect(spinner()).toBeInTheDocument();
  for (const status of ['waiting', 'completed', 'failed', 'cancelled'] as const) {
    rerender(<AiConversation nodes={[]} status={status} throughSeq={null} />);
    expect(spinner()).not.toBeInTheDocument();
  }
  rerender(<AiConversation nodes={[]} status="completed" pending throughSeq={null} />);
  expect(spinner()).toBeInTheDocument();
});

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

it('shows processing before the first Agent output and preserves waiting and Ask feedback', async () => {
  await initI18n('zh-CN');
  const { container, rerender } = render(
    <AiConversation nodes={[]} status="running" throughSeq={null} />,
  );
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeInTheDocument();

  rerender(<AiConversation nodes={[]} status="running" pending throughSeq={null} />);
  expect(container.querySelector('[data-ai-running-indicator]')).toBeNull();
  expect(container.querySelectorAll('[data-ai-thinking-indicator]')).toHaveLength(1);
  expect(container.querySelector('[data-ai-thinking-indicator] .shimmer')?.textContent).toBe('处理中');
  expect(container.querySelector('[data-ai-thinking-indicator] [data-slot="spinner"]')).toBeInTheDocument();

  rerender(<AiConversation nodes={[]} status="idle" pending throughSeq={null} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeInTheDocument();

  rerender(<AiConversation nodes={[]} status="failed" throughSeq={null} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();

  rerender(<AiConversation nodes={[]} status="waiting" throughSeq={null} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
  expect(container.querySelector('[data-ai-running-indicator]')?.closest('[data-slot="message-scroller-item"]'))
    .toHaveClass('[content-visibility:visible]', '[contain-intrinsic-size:none]');
  rerender(<AiConversation nodes={[]} status="running" runningIndicator="ask" throughSeq={null} />);
  expect(container.querySelector('[data-ai-thinking-indicator] .shimmer')).toHaveTextContent('思考中…');
  expect(container.querySelector('[data-ai-thinking-indicator] [data-slot="spinner"]')).toBeNull();
  rerender(<AiConversation nodes={[]} status="running" runningIndicator="none" throughSeq={null} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
});

it.each([['en-US', 'Processing'], ['zh-CN', '处理中']] as const)('keeps the processing status consistent through recorded output in %s', async (locale, label) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const events = skillsCapture as unknown as AgentSessionEvent[];
  const firstOutput = events.findIndex((_, index) => projectAgentChatNodes(events.slice(0, index + 1))
    .some(node => node.kind === 'turnProcess' && node.children.some(child => child.kind === 'contextInjection'
      && child.provenance.kind === 'skill-invocation')));
  expect(firstOutput).toBeGreaterThan(0);
  const { container, rerender } = render(<AiConversation
    nodes={projectAgentChatNodes(events.slice(0, firstOutput))}
    status="running" throughSeq={events[firstOutput - 1].seq} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeInTheDocument();
  expect(container.querySelector('[data-ai-thinking-indicator] .shimmer')?.textContent).toBe(label);
  rerender(<AiConversation nodes={projectAgentChatNodes(events.slice(0, firstOutput + 1))}
    status="running" throughSeq={events[firstOutput].seq} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
  const trigger = container.querySelector('.ai-turn-process-trigger');
  expect(trigger).toHaveAttribute('aria-label', label);
  expect(trigger?.querySelector('.shimmer')?.textContent).toBe(label);
  expect(trigger?.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
  fireEvent.click(trigger!);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger!);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  rerender(<AiConversation nodes={projectAgentChatNodes(events)}
    status="running" throughSeq={events[events.length - 1].seq} />);
  expect(container.querySelector('[data-ai-thinking-indicator]')).toBeNull();
});
