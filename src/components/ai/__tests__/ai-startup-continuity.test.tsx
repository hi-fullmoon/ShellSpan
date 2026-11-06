import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { taskTokenBudgetView } from '@/tests/fixtures/task-token-budget';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { conversationFoldRecording } from '@/tests/fixtures/conversation-fold-runtime';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { AiConversation } from '../workspace/ai-conversation';

beforeEach(async () => { await initI18n('en-US'); });
afterEach(cleanup);

it('preserves the transcript when a submission adopts its session and resets on navigation', () => {
  const view = taskTokenBudgetView();
  const user = view.nodes.find(node => node.kind === 'userMessage');
  if (!user) throw new Error('The recorded session must contain its user input');
  const context = {};
  const { container, rerender } = render(<AiWorkspaceRoot scope="workbench" view={null}
    submissionContext={context} pendingNodes={[user]}
    composerState={createAiComposerState({ phase: 'submitting' })} />);
  const scroller = container.querySelector('[data-slot="message-scroller"]');
  expect(scroller).toBeInTheDocument();
  // The receipt arrives before the full view, as in the controller.
  rerender(<AiWorkspaceRoot scope="workbench" view={null} submissionContext={context}
    pendingNodes={[user]} composerState={createAiComposerState({ sessionId: view.summary.id, phase: 'submitting' })} />);
  expect(container.querySelector('[data-slot="message-scroller"]')).toBe(scroller);
  rerender(<AiWorkspaceRoot scope="workbench" view={view} submissionContext={context} />);
  expect(container.querySelector('[data-slot="message-scroller"]')).toBe(scroller);
  rerender(<AiWorkspaceRoot scope="workbench" view={taskTokenBudgetView(true)} submissionContext={{}} />);
  expect(container.querySelector('[data-slot="message-scroller"]')).not.toBe(scroller);
});

it('preserves the final reply DOM through the recorded message and turn boundaries', () => {
  const { events } = conversationFoldRecording.completed;
  const message = events.map(event => event.type).lastIndexOf('assistant/message');
  const at = (length: number) => projectAgentChatNodes(events.slice(0, length));
  const replies = at(events.length).filter(node => node.kind === 'assistantMessage');
  const finalReply = replies[replies.length - 1];
  if (!finalReply) throw new Error('The recorded completed turn must contain its final reply');
  const { container, rerender } = render(<AiConversation nodes={at(message)} status="running" throughSeq={null} />);
  const finalElements = () => [...container.querySelectorAll<HTMLElement>('[data-ai-node-kind="assistantMessage"]')]
    .filter(element => element.dataset.aiNodeKey === finalReply.key);
  const element = () => finalElements()[0];
  const before = element();
  expect(before).toBeInTheDocument();
  rerender(<AiConversation nodes={at(message + 1)} status="running" throughSeq={null} />);
  expect(element()).toBe(before);
  expect(before?.closest('[data-ai-process-owner]')).toBeNull();
  expect(finalElements()).toHaveLength(1);
  rerender(<AiConversation nodes={at(events.length)} status="completed" throughSeq={null} />);
  expect(element()).toBe(before);
});
