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

    // react-intl-universal 的 init() 是同步应用语言包的（仅返回已 resolve 的
    // Promise），await act 排空微任务后英文文案必然已渲染；用同步 getBy 断言，
    // 避免高负载下 waitFor 默认 1s 超时造成的偶发失败
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Open Workbench')).toBeInTheDocument();
  });
});
