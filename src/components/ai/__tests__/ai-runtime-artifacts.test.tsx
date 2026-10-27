import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { conversationArtifacts } from '@/lib/ai/conversation-artifact';
import { createAgentChatProjector, projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { hasTokenBudgetCheckpoint } from '@/lib/ai/task-token-budget';
import { taskTokenBudgetEvidence, taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import type { AiArtifactNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('collapses recorded internal artifacts without hiding their details in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const view = taskTokenBudgetView();
  const group = view.nodes.find(node => node.kind === 'runtimeArtifacts');
  expect(group?.kind).toBe('runtimeArtifacts');
  if (group?.kind !== 'runtimeArtifacts') throw new Error('Recorded runtime artifacts are required');
  const artifacts = conversationArtifacts(view.nodes);
  const opened: AiArtifactNode[] = [];
  const user = userEvent.setup();
  const { container } = render(<AiConversationNodeList nodes={[group]} onOpenArtifact={artifact => opened.push(artifact)} />);
  const trigger = screen.getByRole('button', { name: locale === 'zh-CN' ? '运行详情' : 'Runtime details' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(locale === 'zh-CN' ? '已生成' : 'Produced')).toBeNull();
  expect(container.querySelector('[data-runtime-artifact-list]')).toBeNull();
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const list = container.querySelector('[data-runtime-artifact-list]') as HTMLElement;
  const entries = within(list).getAllByRole('button');
  expect(entries).toHaveLength(artifacts.length);
  expect(list).toHaveClass('max-h-65', 'overflow-auto');
  await user.click(entries[entries.length - 1]);
  expect(opened).toEqual([artifacts[artifacts.length - 1]]);
  expect(hasTokenBudgetCheckpoint(view)).toBe(true);
});

it('groups incremental replay without changing or losing the committed artifact evidence', () => {
  const project = createAgentChatProjector();
  for (let length = 1; length <= taskTokenBudgetEvidence.events.length; length += 1) {
    const events = taskTokenBudgetEvidence.events.slice(0, length);
    const nodes = project(events);
    const published = events.filter(event => event.type === 'context/artifact');
    expect(conversationArtifacts(nodes)).toHaveLength(new Set(published.map(event => event.data.artifactId)).size);
    expect(nodes).toEqual(projectAgentChatNodes(events));
    expect(nodes.filter(node => node.kind === 'runtimeArtifacts')).toHaveLength(published.length > 0 ? 1 : 0);
  }
});
