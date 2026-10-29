import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { AiSkillStaleNotice } from '../workspace/use-skill-completion';
import { AiTrashRecoveryNotice } from '../workspace/ai-tool-presentation';
import { AiQueueNotice } from '../workspace/ai-queue-notice';

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('uses a neutral queue failure surface in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { rerender } = render(<AiQueueNotice conflict={false} error={null} />);
  const notice = screen.getByRole('alert');
  expect(notice).toHaveClass('bg-card', 'ai-queue-failure-notice');
  expect(notice).not.toHaveClass('bg-destructive/5', 'border-destructive/20');
  expect(notice).toHaveTextContent(t('ai.workspace.queue.failure'));
  expect(notice.querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
  rerender(<AiQueueNotice conflict error={null} />);
  expect(notice).toHaveClass('bg-app-warning/10', 'border-app-warning/40');
  expect(notice).not.toHaveClass('ai-queue-failure-notice');
});

it.each(['zh-CN', 'en-US'] as const)('keeps informational and warning callouts compact and localized in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const { container } = render(<>
    <AiSkillStaleNotice />
    <AiTrashRecoveryNotice />
    <AgentPermissionSelector sessionId="" mode="fullAccess" disabled />
  </>);
  const notices = container.querySelectorAll('[data-slot="alert"]');
  expect(notices).toHaveLength(3);
  for (const notice of notices) {
    expect(notice).toHaveAttribute('data-size', 'sm');
    expect(notice).toHaveClass('has-[>svg]:gap-x-1');
    expect(notice.querySelector(':scope > svg')).toHaveAttribute('aria-hidden', 'true');
  }
  for (const key of ['ai.workspace.skills.stale', 'agent.permission.fullAccessActive'] as const) {
    expect(screen.getByText(t(key)).closest('[data-slot="alert"]')).toHaveClass('bg-app-warning/10', 'border-app-warning/40');
  }
  expect(screen.getByText(t('ai.workspace.tool.trashRecovery')).closest('[data-slot="alert"]'))
    .toHaveClass('bg-primary/10', 'border-primary/30');
});
