import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiConversationNodeList } from '../workspace/ai-conversation-node-seat';
import { conversationArtifacts } from '@/lib/ai/conversation-artifact';
import { createAgentChatProjector, projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { hasTokenBudgetCheckpoint } from '@/lib/ai/task-token-budget';
import { taskTokenBudgetEvidence, taskTokenBudgetView } from '@/tests/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '../styles/styles.css';

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('omits internal artifact rows while retaining the checkpoint in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const view = taskTokenBudgetView();
  const group = view.nodes.find(node => node.kind === 'runtimeArtifacts');
  expect(group?.kind).toBe('runtimeArtifacts');
  if (group?.kind !== 'runtimeArtifacts') throw new Error('Recorded runtime artifacts are required');
  const { container } = render(<AiConversationNodeList nodes={[group]} />);
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole('button', { name: locale === 'zh-CN' ? '运行记录' : 'Run records' })).toBeNull();
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
