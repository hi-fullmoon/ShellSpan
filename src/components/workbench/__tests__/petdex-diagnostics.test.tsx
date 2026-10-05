import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PetdexDiagnostics } from '../petdex-diagnostics';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';

afterEach(cleanup);

describe('Petdex diagnostics with real components and translations', () => {
  it.each(['zh-CN', 'en-US'] as const)('supports keyboard expansion, readable actions and empty history in %s', async (locale) => {
    useAppStore.setState({ locale });
    await initI18n(locale);
    const strings = locale === 'zh-CN' ? zhCN : enUS;
    render(<PetdexDiagnostics snapshot={null} status="disabled" health={null} />);
    const trigger = screen.getByRole('button', { name: strings['settings.experimental.petdex.details'] });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(strings['settings.experimental.petdex.never'])).toBeVisible();
    expect(screen.getByText(strings['settings.experimental.petdex.action.none'])).toBeVisible();
    expect(screen.getByText(strings['settings.experimental.petdex.health.none'])).toBeVisible();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
});
