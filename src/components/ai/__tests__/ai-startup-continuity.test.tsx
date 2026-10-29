import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { conversationFoldRecording } from '@/test/fixtures/conversation-fold-runtime';
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
  const { container, rerender } = render(<AiConversation nodes={at(message)} status="running" throughSeq={null} />);
  const element = () => container.querySelector('[data-ai-node-kind="assistantMessage"]');
  const before = element();
  expect(before).toBeInTheDocument();
  rerender(<AiConversation nodes={at(message + 1)} status="running" throughSeq={null} />);
  expect(element()).toBe(before);
  expect(before?.closest('.ai-turn-process')).toBeNull();
  expect(container.querySelectorAll('[data-ai-node-kind="assistantMessage"]')).toHaveLength(1);
  rerender(<AiConversation nodes={at(events.length)} status="completed" throughSeq={null} />);
  expect(element()).toBe(before);
});
