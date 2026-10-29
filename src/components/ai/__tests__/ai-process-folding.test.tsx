import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { conversationFoldRecording } from '@/test/fixtures/conversation-fold-runtime';
import { childFailureEvents } from '@/test/fixtures/child-recovery-recording';
import { inboxTimelineEvidence } from '@/test/fixtures/agent-inbox-timeline';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import '../styles/styles.css';

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

function conversation(events: readonly AgentSessionEvent[], status: 'running' | 'completed' = 'running') {
  // Disclosure choices survive remounts; each test owns an independent view scope.
  const nodes = projectAgentChatNodes(events).map(node => ({
    ...node, sessionId: `${node.sessionId}:${expect.getState().currentTestName}`,
  }));
  return <AiConversation nodes={nodes} status={status} throughSeq={events[events.length - 1]?.seq ?? null} />;
}

it('keeps recorded process prose inside the disclosure without separate copy actions', async () => {
  const { events } = conversationFoldRecording.progress;
  const { container } = render(conversation(events));
  const message = screen.getByText('Two candidate project directories. Let me examine both.');
  expect(message.closest('.ai-turn-process-body')).toBeInTheDocument();
  expect(within(message.closest('[role="article"]') as HTMLElement).queryByRole('button', { name: 'Copy' })).toBeNull();
  const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  fireEvent.click(trigger);
  await waitFor(() => expect(message).not.toBeVisible());
  expect(container.querySelectorAll('[data-ai-node-kind="assistantMessage"]')).toHaveLength(0);
  fireEvent.click(trigger);
  expect(await screen.findByText('Two candidate project directories. Let me examine both.')).toBeVisible();
});

it.each(['en-US', 'zh-CN'] as const)('automatically folds a normally completed recorded turn in %s while keeping its answer visible', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { events } = conversationFoldRecording.completed;
  const end = events.findIndex(event => event.type === 'turn/end');
  const { container, rerender } = render(conversation(events.slice(0, end)));
  const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  rerender(conversation(events, 'completed'));
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  expect(screen.getByText(/COMPACT-CHECK-4719/)).toBeVisible();
  expect(container.querySelector('[data-ai-node-kind="assistantMessage"] .ai-assistant-stopped')).toBeNull();
  expect(container.querySelectorAll('[data-ai-node-kind="turnTail"]')).toHaveLength(1);
});

it('preserves an explicit expansion across completion and remount', async () => {
  const { events } = conversationFoldRecording.completed;
  const end = events.findIndex(event => event.type === 'turn/end');
  const view = render(conversation(events.slice(0, end)));
  const trigger = view.container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  view.rerender(conversation(events, 'completed'));
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  view.unmount();
  const history = render(conversation(events, 'completed'));
  expect(history.container.querySelector('.ai-turn-process-trigger')).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(history.container.querySelector('.ai-turn-process-trigger')!);
});

it('keeps focused process controls mounted when completion arrives', async () => {
  const { events } = conversationFoldRecording.completed;
  const end = events.findIndex(event => event.type === 'turn/end');
  const { container, rerender } = render(conversation(events.slice(0, end)));
  const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  const control = container.querySelector<HTMLButtonElement>('.ai-turn-process-body button')!;
  expect(control).toBeInTheDocument();
  control.focus();
  rerender(conversation(events, 'completed'));
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(control).toHaveFocus();
  fireEvent.click(trigger);
});

it('preserves selected process text when completion arrives', () => {
  const { events } = conversationFoldRecording.completed;
  const end = events.findIndex(event => event.type === 'turn/end');
  const { container, rerender } = render(conversation(events.slice(0, end)));
  const body = container.querySelector<HTMLDivElement>('.ai-turn-process-body')!;
  const range = document.createRange();
  range.selectNodeContents(body);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const text = selection.toString();
  expect(text.trim()).not.toBe('');
  try {
    rerender(conversation(events, 'completed'));
    expect(container.querySelector('.ai-turn-process-trigger')).toHaveAttribute('aria-expanded', 'true');
    expect(selection.toString()).toBe(text);
  } finally {
    selection.removeAllRanges();
  }
});

it.each([
  ['failed child', childFailureEvents],
  ['incomplete budget', taskTokenBudgetEvidence.events],
  ['interleaved input', inboxTimelineEvidence.events],
] as const)('keeps %s execution inspectable', (_name, events) => {
  const { container } = render(conversation(events, 'completed'));
  const triggers = container.querySelectorAll<HTMLButtonElement>('.ai-turn-process-trigger');
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toBeDisabled();
  }
});
