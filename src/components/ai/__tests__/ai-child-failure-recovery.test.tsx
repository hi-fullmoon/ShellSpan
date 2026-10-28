import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AiFailureRecoveryAction, AiFailureRecoveryContext } from '../workspace/ai-failure-recovery';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { latestFailureRecovery } from '@/lib/ai/failure-recovery';
import { childFailureRecordedAt, recordedChildFailureView } from '@/test/fixtures/child-recovery-recording';

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('renders one readable child recovery action and blocks repeated submission while busy in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const requested: string[] = [];
  const recovery = latestFailureRecovery(recordedChildFailureView(), childFailureRecordedAt);
  const content = (busy: boolean) => (
    <AiFailureRecoveryContext.Provider value={{ recovery, busy, onRetry: turn => requested.push(turn) }}>
      <AiFailureRecoveryAction turnId="failure-turn" />
    </AiFailureRecoveryContext.Provider>
  );
  const { rerender } = render(content(false));
  const button = screen.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry' });
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(button).toHaveAttribute('data-slot', 'button');
  fireEvent.click(button);
  expect(requested).toEqual(['failure-turn']);
  rerender(content(true));
  const pending = screen.getByRole('button', { name: locale === 'zh-CN' ? '正在重试' : 'Retrying' });
  expect(pending).toBeDisabled();
  fireEvent.click(pending);
  expect(requested).toEqual(['failure-turn']);
});
