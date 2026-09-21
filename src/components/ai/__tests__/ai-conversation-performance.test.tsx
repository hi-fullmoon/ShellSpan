import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiConversation } from '../workspace/ai-conversation';
import { AiConversationNodeSeat, aiConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import { createAgentChatProjector, projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import { initI18n } from '@/locales';

afterEach(cleanup);

it('does not rerender the transcript when only its parent updates', async () => {
  await initI18n('en-US');
  const nodes = projectAgentChatNodes(taskTokenBudgetEvidence.events);
  let renders = 0;
  const renderers = {
    ...aiConversationNodeRenderers,
    userMessage: (props: { node: AiConversationNodeOf<'userMessage'> }) => {
      renders += 1;
      return <aiConversationNodeRenderers.userMessage {...props} />;
    },
  };
  const props = { nodes, renderers, status: 'completed' as const, throughSeq: null };
  const { container, rerender } = render(<AiConversation {...props} />);
  expect(renders).toBeGreaterThan(0);
  const before = renders;
  const row = container.querySelector('[data-ai-node-key]');
  rerender(<AiConversation {...props} />);
  expect(renders).toBe(before);
  expect(container.querySelector('[data-ai-node-key]')).toBe(row);
});

it('skips unchanged tools inside an updating process without losing focus', async () => {
  await initI18n('en-US');
  const events = skillsCapture as unknown as readonly AgentSessionEvent[];
  const project = createAgentChatProjector();
  let pair: { before: AiConversationNodeOf<'turnProcess'>; after: AiConversationNodeOf<'turnProcess'> } | undefined;
  let previous: AiConversationNodeOf<'turnProcess'> | undefined;
  for (let length = 1; length <= events.length; length += 1) {
    const current = project(events.slice(0, length)).find((node) => node.kind === 'turnProcess');
    if (previous && current && current !== previous && current.status === 'running') {
      const tools = previous.children.filter((node) => node.kind === 'tool');
      const nextTools = current.children.filter((node) => node.kind === 'tool');
      if (tools.length > 0 && tools.length === nextTools.length
        && tools.every((tool, index) => tool === nextTools[index])) {
        pair = { before: previous, after: current };
        break;
      }
    }
    previous = current;
  }
  expect(pair).toBeDefined();
  let toolRenders = 0;
  const renderers = {
    ...aiConversationNodeRenderers,
    tool: (props: { node: AiConversationNodeOf<'tool'> }) => {
      toolRenders += 1;
      return <aiConversationNodeRenderers.tool {...props} />;
    },
  };
  const { container, rerender } = render(<AiConversationNodeSeat node={pair!.before} renderers={renderers} />);
  expect(toolRenders).toBeGreaterThan(0);
  const before = toolRenders;
  const trigger = container.querySelector<HTMLButtonElement>('.ai-turn-process-trigger')!;
  trigger.focus();
  rerender(<AiConversationNodeSeat node={pair!.after} renderers={renderers} />);
  expect(toolRenders).toBe(before);
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
});
