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
  it.each(['zh-CN', 'en-US'] as const)('supports keyboard expansion, unified connection and message diagnostics in %s', async (locale) => {
    useAppStore.setState({ locale, petdexMessageDiagnostic: null, petdexConfigurationFailed: false });
    await initI18n(locale);
    const strings = locale === 'zh-CN' ? zhCN : enUS;
    render(<PetdexDiagnostics snapshot={null} status="disabled" health={null} />);
    const trigger = screen.getByRole('button', { name: strings['settings.experimental.petdex.details'] });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('definition')).toHaveLength(0);
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(strings['settings.experimental.petdex.never'])).toHaveLength(2);
    expect(screen.getByText(strings['settings.experimental.petdex.action.none'])).toBeVisible();
    expect(screen.getByText(strings['settings.experimental.petdex.health.none'])).toBeVisible();
    expect(screen.getByText('0 / 3')).toBeVisible();
    expect(screen.getAllByRole('definition')).toHaveLength(7);
    await userEvent.keyboard(' ');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
});
