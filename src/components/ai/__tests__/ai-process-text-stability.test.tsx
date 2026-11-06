import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { conversationFoldRecording } from '@/tests/fixtures/conversation-fold-runtime';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import '../styles/styles.css';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

function replay(events: readonly AgentSessionEvent[]) {
  const nodes = projectAgentChatNodes(events).map(node => ({
    ...node, sessionId: `${node.sessionId}:${expect.getState().currentTestName}`,
  }));
  return <AiConversation nodes={nodes} status="running" throughSeq={events[events.length - 1]?.seq ?? null} />;
}

it('keeps the same selected text and message seat when recorded tool deltas and settlement arrive', () => {
  const { events } = conversationFoldRecording.progress;
  const toolDelta = events.map(event => event.type === 'assistant/chunk' && Boolean(event.data.toolCallDelta)).lastIndexOf(true);
  const view = render(replay(events.slice(0, toolDelta)));
  const text = [...view.container.querySelectorAll('p')]
    .find(element => element.textContent === 'Two candidate project directories. Let me examine both.')!;
  expect(text).toBeInTheDocument();
  const seat = text.closest('[data-slot="message-scroller-item"]');
  expect(seat).toHaveClass('ai-conversation-process-prose');
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const selected = selection.toString();
  try {
    for (const length of [toolDelta + 1, toolDelta + 2, events.length]) {
      view.rerender(replay(events.slice(0, length)));
      expect([...view.container.querySelectorAll('p')].find(element => element.textContent === selected)).toBe(text);
      expect(text.closest('[data-slot="message-scroller-item"]')).toBe(seat);
      expect(seat).toHaveClass('ai-conversation-process-prose');
      expect(selection.toString()).toBe(selected);
    }
  } finally { selection.removeAllRanges(); }
});

it('preserves streamed final-answer nodes and their selection when the recorded turn folds', async () => {
  const { events } = conversationFoldRecording.completed;
  const message = events.map(event => event.type).lastIndexOf('assistant/message');
  const view = render(replay(events.slice(0, message)));
  const text = screen.getByText('COMPACT-CHECK-4719');
  const seat = text.closest('[data-slot="message-scroller-item"]');
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    view.rerender(replay(events));
    await waitFor(() => expect(view.container.querySelector('.ai-turn-process-trigger'))
      .toHaveAttribute('aria-expanded', 'false'));
    expect(screen.getByText('COMPACT-CHECK-4719')).toBe(text);
    expect(text.closest('[data-slot="message-scroller-item"]')).toBe(seat);
    expect(selection.toString()).toBe('COMPACT-CHECK-4719');
    expect(text).toBeVisible();
  } finally { selection.removeAllRanges(); }
});

it('restores the same recorded process rows with keyboard disclosure after completion', async () => {
  const { events } = conversationFoldRecording.completed;
  const end = events.findIndex(event => event.type === 'turn/end');
  const view = render(replay(events.slice(0, end)));
  const progress = view.container.querySelector('[data-ai-process-child="tool"] .ai-tool-row')!;
  expect(progress).toBeInTheDocument();
  view.rerender(replay(events));
  const trigger = view.container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  const controlled = trigger.getAttribute('aria-controls')!.split(' ');
  expect(controlled.length).toBeGreaterThan(0);
  for (const id of controlled) expect(document.getElementById(id)).toHaveClass('ai-conversation-row-panel');
  await waitFor(() => expect(progress).not.toBeVisible());
  trigger.focus();
  await userEvent.setup().keyboard('{Enter}');
  await waitFor(() => expect(progress).toBeVisible());
  expect(view.container.querySelector('[data-ai-process-child="tool"] .ai-tool-row')).toBe(progress);
  expect(trigger).toHaveFocus();
  expect(view.container.querySelectorAll('.ai-assistant-actions')).toHaveLength(0);
});
