import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AiTaskStrip } from '@/components/ai/workspace/ai-task-strip';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import type { AgentSessionPlanStep } from '@/types/agent-session';

const referenceSteps: readonly AgentSessionPlanStep[] = [
  { id: 'inspect', title: '检查服务状态', status: 'inProgress' },
  { id: 'configure', title: '更新配置', status: 'pending' },
  { id: 'restart', title: '重启服务', status: 'pending' },
  { id: 'verify', title: '验证服务', status: 'pending' },
  { id: 'report', title: '整理结果', status: 'pending' },
];

beforeEach(async () => {
  useAppStore.setState({ locale: 'zh-CN' });
  await initI18n('zh-CN');
});

afterEach(cleanup);

describe('AI task strip', () => {
  it('shows the nonzero reference counts while folded and supports keyboard toggling', async () => {
    const user = userEvent.setup();
    render(<AiTaskStrip steps={referenceSteps} />);
    const toggle = screen.getByRole('button', { name: '展开或折叠 5 个任务' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleDescription('1 进行中 · 4 待处理');
    expect(screen.getByText('1 进行中 · 4 待处理')).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('检查服务状态')).toBeVisible();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it.each<{
    locale: Locale;
    summary: string;
    blocked: string;
    failed: string;
  }>([
    { locale: 'zh-CN', summary: '1 已完成 · 1 进行中 · 4 待处理 · 2 已阻塞 · 1 失败', blocked: '已阻塞:', failed: '失败:' },
    { locale: 'en-US', summary: '1 completed · 1 in progress · 4 pending · 2 blocked · 1 failed', blocked: 'Blocked:', failed: 'Failed:' },
  ])('counts blocked and failed separately in $locale', async ({ locale, summary, blocked, failed }) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const user = userEvent.setup();
    render(<AiTaskStrip steps={[
      ...referenceSteps,
      { id: 'done', title: 'Completed work', status: 'completed' },
      { id: 'blocked-1', title: 'Waiting for access', status: 'blocked' },
      { id: 'blocked-2', title: 'Waiting for input', status: 'blocked' },
      { id: 'failed', title: 'Failed check', status: 'failed' },
    ]} />);
    expect(screen.getByRole('button')).toHaveAccessibleDescription(summary);
    expect(screen.getByText(summary)).toBeVisible();
    await user.click(screen.getByRole('button'));

    const blockedRow = screen.getByText('Waiting for access').closest('li')!;
    expect(blockedRow).toHaveAttribute('data-status', 'blocked');
    expect(within(blockedRow).getByText(blocked)).toBeInTheDocument();
    const failedRow = screen.getByText('Failed check').closest('li')!;
    expect(failedRow).toHaveAttribute('data-status', 'failed');
    expect(within(failedRow).getByText(failed)).toBeInTheDocument();
  });

  it('reflects plan changes without losing the expanded state and disappears for an empty plan', async () => {
    const user = userEvent.setup();
    const { rerender, container } = render(<AiTaskStrip steps={referenceSteps} />);
    await user.click(screen.getByRole('button'));
    const longTitle = '验证长任务标题在窄面板中仍可读取完整内容'.repeat(12);
    rerender(<AiTaskStrip steps={[
      { ...referenceSteps[0], status: 'completed' },
      { id: 'long', title: longTitle, detail: '保留真实计划详情', status: 'inProgress' },
    ]} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button')).toHaveAccessibleDescription('1 已完成 · 1 进行中');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('更新配置')).toBeNull();
    expect(screen.getByText(longTitle)).toHaveAttribute('title', `${longTitle}\n保留真实计划详情`);

    rerender(<AiTaskStrip steps={referenceSteps.map((step) => ({ ...step, status: 'completed' }))} />);
    expect(screen.getByRole('button')).toHaveAccessibleDescription('5 已完成');
    rerender(<AiTaskStrip steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
