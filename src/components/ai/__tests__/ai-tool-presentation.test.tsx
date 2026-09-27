import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiToolExpandedContent, AiToolRow, classifyAiTool } from '@/components/ai/workspace/ai-tool-presentation';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AgentSessionEvent } from '@/types/agent-session';

const command = 'powershell $f="$env:USERPROFILE\\todo.html"; $c=Get-Content $f; Write-Output $c';
const node: AiConversationNodeOf<'tool'> = {
  kind: 'tool', key: 'tool:long-command', sourceKind: 'agent',
  sessionId: 'tool-presentation', turnId: 'turn-1', stepId: 'step-1',
  firstSeq: 1, lastSeq: 2, timestamp: '2026-09-19T00:00:00.000Z',
  callId: 'long-command', name: 'run_terminal_command', nativeName: null, title: null,
  summary: 'Read the file', state: 'succeeded', effect: 'readOnly', durationMs: 1,
  evidenceRefs: [], detailRef: { kind: 'agentTool', sessionId: 'tool-presentation', callId: 'long-command' },
  input: { command }, output: 'File contents', error: null,
  target: null, idempotency: null, approval: null,
};

beforeEach(async () => {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('AI tool presentation', () => {
  it.each(['zh-CN', 'en-US'] as const)('localizes the captured skill tool title in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const nodes = projectAgentChatNodes(skillsCapture as unknown as readonly AgentSessionEvent[]);
    const skill = nodes.flatMap((item) => item.kind === 'turnProcess' ? item.children : [])
      .find((item): item is AiConversationNodeOf<'tool'> => item.kind === 'tool' && item.name === 'skill');
    expect(skill).toBeDefined();
    render(<AiToolRow node={skill!} />);
    const title = locale === 'zh-CN' ? '加载技能' : 'Load Skill';
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByRole('button', { name: new RegExp(`^${title}:`) })).toBeVisible();
    if (locale === 'zh-CN') expect(screen.queryByText('Load Skill')).not.toBeInTheDocument();
  });

  it.each(['zh-CN', 'en-US'] as const)('shows system-trash recovery without promising in-app undo in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const trashNode: AiConversationNodeOf<'tool'> = {
      ...node, name: 'trash_file', effect: 'destructive',
      input: { path: 'old-config.json' },
      output: { path: 'old-config.json', trashed: true, recovery: 'systemTrash' },
    };
    render(<AiToolRow node={trashNode} />);
    const label = locale === 'zh-CN' ? '移入系统回收站' : 'Move to system trash';
    const row = screen.getByRole('button', { name: new RegExp(label) });
    expect(row).toHaveTextContent('old-config.json');
    await userEvent.setup().click(row);
    expect(screen.getByText(locale === 'zh-CN'
      ? '已移入系统回收站。请在系统回收站中恢复；当前不支持应用内一键撤销。'
      : 'Moved to the system trash. Restore it there; in-app undo is not available.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /撤销删除|Undo deletion/u })).not.toBeInTheDocument();
  });

  it('does not report recovery success when trashing fails', () => {
    render(<AiToolExpandedContent node={{ ...node, name: 'trash_file', state: 'failed', output: 'trash unavailable', error: 'trash unavailable' }} />);
    expect(screen.queryByText(/Moved to the system trash/u)).not.toBeInTheDocument();
    expect(screen.getByText('trash unavailable')).toBeVisible();
  });

  it('explains a protected operation denial while retaining the original diagnostic', async () => {
    const error = 'AGENT_CRITICAL_OPERATION_DENIED: protected system resource';
    render(<AiToolRow node={{ ...node, state: 'failed', error, output: error }} />);
    const row = screen.getByRole('button', { name: /Not executed: this action affects protected system resources/u });
    expect(row).not.toHaveTextContent('AGENT_CRITICAL_OPERATION_DENIED');
    await userEvent.setup().click(row);
    expect(screen.getByText(error)).toBeVisible();
  });

  it('explains a changed automatic review without implying a shell fallback', () => {
    const error = 'AUTO_REVIEW_CHANGED: reviewed root identity changed';
    render(<AiToolRow node={{ ...node, state: 'failed', error, output: error }} />);
    expect(screen.getByRole('button', { name: /no ordinary shell fallback was run/u })).toBeVisible();
  });
  it.each([
    { locale: 'zh-CN' as const, label: '查看详情', accessibleName: '打开 run_terminal_command 的详情' },
    { locale: 'en-US' as const, label: 'View details', accessibleName: 'Open details for run_terminal_command' },
  ])('labels the tool details action clearly in $locale', async ({ locale, label, accessibleName }) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const opened: AiConversationNodeOf<'tool'>[] = [];
    render(<AiToolRow node={node} onInspect={(tool) => opened.push(tool)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    const details = screen.getByRole('button', { name: accessibleName });
    expect(details).toHaveTextContent(label);
    expect(details).toHaveClass('ml-1', 'self-start');
    await user.click(details);
    expect(opened).toEqual([node]);
  });

  it('explains rejected historical input while preserving the diagnostic in details', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    const diagnostic = 'ephemeralInputUnavailable: no input was executed; historical input is unavailable.';
    const rejected: AiConversationNodeOf<'tool'> = { ...node, state: 'rejected', error: diagnostic, output: diagnostic };
    render(<AiToolRow node={rejected} />);
    const row = screen.getByRole('button', { name: /未执行：Agent 使用了已省略的历史输入，需要重新生成命令。/u });
    expect(row).not.toHaveTextContent('ephemeralInputUnavailable');
    await userEvent.setup().click(row);
    expect(screen.getByText(diagnostic)).toBeInTheDocument();
  });

  it('shows update_plan as a localized task plan with a list icon', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const planNode: AiConversationNodeOf<'tool'> = {
      ...node,
      key: 'tool:plan',
      callId: 'plan',
      name: 'update_plan',
      title: 'Update task plan',
      summary: 'Updated task plan: 2 pending, 1 in progress',
      input: { steps: [] },
    };

    expect(classifyAiTool('update_plan')).toBe('plan');
    expect(classifyAiTool('provider.tool', 'update_plan')).toBe('plan');
    const { container } = render(<AiToolRow node={planNode} />);
    expect(container.querySelector('[data-tool-variant="plan"]')).toBeInTheDocument();
    expect(container.querySelector('.lucide-list-todo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^更新任务计划:/u })).toBeInTheDocument();
  });

  it('expands a truncated command with one click and allows it to be collapsed', async () => {
    const user = userEvent.setup();
    const { container } = render(<AiToolExpandedContent node={node} compact />);
    const toggle = screen.getByRole('button', { name: 'Show full command' });

    expect(toggle).toHaveTextContent(command);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.ai-terminal-command')).toBe(toggle);
    const header = container.querySelector('.ai-terminal-header');
    const stateDot = header?.querySelector('.ai-state-dot');
    expect(header).toHaveClass('items-start');
    expect(stateDot).toHaveClass('mt-1.5');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse command' })).toHaveAttribute('aria-expanded', 'true');
    expect(header).toHaveClass('items-start');
    expect(stateDot).toHaveClass('mt-1.5');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Show full command' })).toHaveAttribute('aria-expanded', 'false');
    expect(header).toHaveClass('items-start');
    expect(stateDot).toHaveClass('mt-1.5');
  });

  it.each(['run_terminal_command', 'read_file'])('keeps one output copy action in the %s header', (name) => {
    const { container, rerender } = render(<AiToolExpandedContent node={{ ...node, name }} compact />);
    const copy = screen.getByRole('button', { name: 'Copy output' });
    expect(container.querySelectorAll('.ai-tool-copy-button')).toHaveLength(1);
    expect(copy.closest('.ai-terminal-header, .ai-block-banner')).toHaveClass('pr-1', 'pl-3.5');
    expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();

    rerender(<AiToolExpandedContent node={{ ...node, name }} showCopyActions={false} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name, output: '' }} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
    rerender(<AiToolExpandedContent node={{ ...node, name, state: 'running' }} />);
    expect(container.querySelector('.ai-tool-copy-button')).not.toBeInTheDocument();
  });

  it('shows a leading icon on the inspect action and still opens tool details', async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    render(<AiToolRow node={node} onInspect={onInspect} />);

    await user.click(screen.getByRole('button', { name: /^Command:/u }));
    const inspect = screen.getByRole('button', { name: 'Open details for run_terminal_command' });
    expect(inspect.querySelector('svg[data-icon="inline-start"]')).toBeInTheDocument();
    expect(inspect).toHaveClass('gap-1');

    await user.click(inspect);
    expect(onInspect).toHaveBeenCalledExactlyOnceWith(node);
  });
});
