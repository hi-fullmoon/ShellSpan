import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initI18n } from '@/locales';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
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

it('preserves the message DOM when the projection classifies text as process output', () => {
  const nodes = projectAgentChatNodes(skillsCapture as unknown as AgentSessionEvent[]);
  const message = nodes.find(node => node.kind === 'assistantMessage');
  const process = nodes.find(node => node.kind === 'turnProcess' && node.turnId === message?.turnId);
  if (!message || !process || process.kind !== 'turnProcess') {
    throw new Error('The recorded session must contain assistant text and its process');
  }
  const { container, rerender } = render(<AiConversation nodes={nodes} status="running" throughSeq={null} />);
  const element = () => Array.from(container.querySelectorAll<HTMLElement>('[data-ai-node-key]'))
    .find(node => node.dataset.aiNodeKey === message.key);
  const before = element();
  expect(before).toBeInTheDocument();
  // Exercise both supported projection placements using the same recorded
  // content and identity, without inventing model responses or tool results.
  const classified: AiConversationNode[] = nodes.filter(node => node !== message).map(node => node !== process
    ? node : { ...process, children: [...process.children, message],
      childKeys: [...process.childKeys, message.key] });
  rerender(<AiConversation nodes={classified} status="running" throughSeq={null} />);
  expect(element()).toBe(before);
  expect(before?.closest('.ai-turn-process')).toBeNull();
  expect(container.querySelectorAll(`[data-ai-node-key="${message.key}"]`)).toHaveLength(1);
  rerender(<AiConversation nodes={nodes} status="completed" throughSeq={null} />);
  expect(element()).toBe(before);
});
