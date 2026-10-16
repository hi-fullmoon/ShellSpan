import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiFailureRecoveryAction, AiFailureRecoveryContext } from '../workspace/ai-failure-recovery';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

describe('failed model recovery actions', () => {
  it.each(['zh-CN', 'en-US'] as const)('localizes recovery, blocks cooldown and keeps old turns inactive in %s', async locale => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const retried: string[] = [];
    const context = { recovery: { turnId: 'latest', kind: 'retry' as const }, busy: false, onRetry: (id: string) => retried.push(id) };
    const { rerender } = render(<AiFailureRecoveryContext.Provider value={context}>
      <AiFailureRecoveryAction turnId="old" /><AiFailureRecoveryAction turnId="latest" />
    </AiFailureRecoveryContext.Provider>);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    expect(retried).toEqual(['latest']);
    rerender(<AiFailureRecoveryContext.Provider value={{ ...context, busy: true }}><AiFailureRecoveryAction turnId="latest" /></AiFailureRecoveryContext.Provider>);
    const busy = screen.getByRole('button', { name: t('ai.error.recovery.retrying') });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('svg')).toBeNull();
    fireEvent.click(busy);
    expect(retried).toHaveLength(1);
    rerender(<AiFailureRecoveryContext.Provider value={{ ...context, recovery: { ...context.recovery, retryAt: Date.now() + 60_000 } }}><AiFailureRecoveryAction turnId="latest" /></AiFailureRecoveryContext.Provider>);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveTextContent(locale === 'zh-CN' ? '秒后可重试' : 'Retry in');
    fireEvent.click(screen.getByRole('button'));
    expect(retried).toEqual(['latest']);
  });

  it('offers configuration recovery and tool verification without retrying', async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
    let opened = 0;
    const { rerender } = render(<AiFailureRecoveryContext.Provider value={{ recovery: { turnId: 'latest', kind: 'settings' }, busy: false, onSettings: () => { opened++; } }}><AiFailureRecoveryAction turnId="latest" /></AiFailureRecoveryContext.Provider>);
    expect(screen.getByRole('button').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check configuration' }));
    expect(opened).toBe(1);
    rerender(<AiFailureRecoveryContext.Provider value={{ recovery: { turnId: 'latest', kind: 'verify' }, busy: false }}><AiFailureRecoveryAction turnId="latest" /></AiFailureRecoveryContext.Provider>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(t('ai.error.recovery.verify'))).toBeVisible();
  });
});
