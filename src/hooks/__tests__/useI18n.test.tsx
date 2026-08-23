import React, { act, useMemo } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useI18n } from '@/hooks/useI18n';
import { changeLocale } from '@/locales';
import { useAppStore } from '@/stores/appStore';

const MemoizedLabel: React.FC = () => {
  const { t } = useI18n();
  const label = useMemo(() => t('settings.shortcuts.openWorkbench'), [t]);

  return <span>{label}</span>;
};

const LanguageFixture: React.FC = () => {
  const { ready, setLocale, t } = useI18n();

  if (!ready) return null;

  return (
    <>
      <button type="button" onClick={() => setLocale('en-US')}>
        {t('common.save')}
      </button>
      <span>{t('common.cancel')}</span>
      <MemoizedLabel />
    </>
  );
};

describe('useI18n', () => {
  beforeEach(async () => {
    await changeLocale('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
  });

  it('updates direct and memoized translations immediately when the locale changes', async () => {
    render(<LanguageFixture />);

    expect(await screen.findByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.getByText('取消')).toBeInTheDocument();
    expect(screen.getByText('打开工作台')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }));
    });

    // Locale initialization is promise-based and can finish after React's event
    // act boundary under a saturated full-suite worker. Wait for the observable
    // language change with an explicit gate-sized timeout instead of assuming a
    // particular microtask schedule.
    expect(await screen.findByRole('button', { name: 'Save' }, { timeout: 5_000 }))
      .toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Open Workbench')).toBeInTheDocument();
  });
});
