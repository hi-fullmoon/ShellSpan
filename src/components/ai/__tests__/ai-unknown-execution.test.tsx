import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AiToolRow } from '../workspace/ai-tool-presentation';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { terminalExecutionRecovery } from '@/lib/ai/terminal-execution-recovery';
import { terminalRecoveryView } from '@/tests/fixtures/terminal-execution-recovery';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import capture from '@/tests/fixtures/terminal-unknown-execution.json';

afterEach(cleanup);

it.each([
  ['zh-CN', '查看详情', '复制命令'], ['en-US', 'View details', 'Copy command'],
] as const)('shows the command inline without a details action before its result in %s', async (locale, detailsLabel, copyLabel) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const events = capture as readonly AgentSessionEvent[];
  const user = userEvent.setup();
  for (const [eventCount, state] of [[1, 'preparing'], [3, 'running']] as const) {
    const tool = projectAgentChatNodes(events.slice(0, eventCount))
      .flatMap(node => node.kind === 'turnProcess' ? node.children : [])
      .find((node): node is AiConversationNodeOf<'tool'> => node.kind === 'tool');
    expect(tool?.state).toBe(state);
    expect(tool?.output).toBeNull();
    const { container, unmount } = render(<AiToolRow node={tool!} onInspect={() => undefined} />);
    const row = screen.getByRole('button');
    row.focus();
    await user.keyboard('{Enter}');
    expect(container.querySelector('.ai-terminal-command')).toBeVisible();
    expect(screen.getByRole('button', { name: copyLabel })).toBeVisible();
    expect(screen.queryByText(detailsLabel)).not.toBeInTheDocument();
    unmount();
  }
});

it.each([
  ['zh-CN', '执行结果未知'], ['en-US', 'Execution outcome unknown'],
] as const)('labels the recorded unknown outcome inline without a confirmation form in %s', async (locale, label) => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const nodes = projectAgentChatNodes(capture as readonly AgentSessionEvent[]);
  const tool = nodes.flatMap(node => node.kind === 'turnProcess' ? node.children : [])
    .find((node): node is AiConversationNodeOf<'tool'> => node.kind === 'tool');
  expect(tool?.state).toBe('uncertain');
  const inspected: AiConversationNodeOf<'tool'>[] = [];
  const { container } = render(<AiToolRow node={tool!} onInspect={(node) => inspected.push(node)} />);
  const row = screen.getByRole('button', { name: new RegExp(label) });
  expect(row).toHaveTextContent(label);
  expect(container.querySelector('[data-tool-state="uncertain"]')).toBeInTheDocument();
  expect(container.querySelector('.ai-state-dot[data-state="failed"]')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.setup().click(row);
  expect(screen.queryByRole('button', { name: locale === 'zh-CN' ? /^打开 .* 的详情$/u : /^Open details for /u })).not.toBeInTheDocument();
  expect(inspected).toEqual([]);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a restored conversation usable while preserving its unknown result', async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  const base = terminalRecoveryView('idle');
  const view = { ...base, nodes: projectAgentChatNodes(capture as readonly AgentSessionEvent[]),
    snapshot: { ...base.snapshot, value: { ...base.snapshot.value, uncertainNativeEffects: true } } };
  expect(terminalExecutionRecovery(view)).toBeNull();
  const submissions: string[] = [];
  const { container } = render(<AiWorkspaceRoot scope="terminal" view={view} canStartAgent
    onSubmit={({ content }) => { submissions.push(content); }}
    composerState={createAiComposerState({ phase: 'idle', runtimeStatus: 'idle', draft: 'Continue with read-only inspection' })} />);
  expect(container.querySelector('.ai-composer-primary')).toBeEnabled();
  expect(container.querySelector('[data-terminal-recovery-notice]')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm execution result' })).toBeNull();
  expect(view.snapshot.value.uncertainNativeEffects).toBe(true);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
  expect(submissions).toEqual(['Continue with read-only inspection']);
});
