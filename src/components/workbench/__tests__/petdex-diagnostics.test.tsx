import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PetdexDiagnostics } from '../petdex-diagnostics';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import * as petdexMessages from '@/lib/petdex/messages';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('Petdex diagnostics with real components and translations', () => {
  it.each(['zh-CN', 'en-US'] as const)('supports keyboard expansion, unified connection and message diagnostics in %s', async (locale) => {
    useAppStore.setState({ locale, petdexEnabled: false, petdexMessagesEnabled: false, petdexMessageDiagnostic: null, petdexConfigurationFailed: false });
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

  it('skips interval polling while collapsed and disabled, then polls when expanded', async () => {
    useAppStore.setState({ locale: 'en-US', petdexEnabled: false, petdexMessagesEnabled: false, petdexMessageDiagnostic: null, petdexConfigurationFailed: false });
    await initI18n('en-US');
    const getDiag = vi.spyOn(petdexMessages, 'getPetdexMessageDiagnostic').mockResolvedValue({
      revision: 1,
      status: 'disabled',
      acceptedCount: 0,
      lastAcceptedAt: null,
      usedSlotCount: 0,
      errorReason: null,
      unsupported: false,
      cleanupOutcome: 'notNeeded',
    });
    vi.useFakeTimers();
    render(<PetdexDiagnostics snapshot={null} status="disabled" health={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getDiag).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getDiag).toHaveBeenCalledTimes(1);

    const trigger = screen.getByRole('button', { name: enUS['settings.experimental.petdex.details'] });
    await act(async () => {
      trigger.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getDiag).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getDiag).toHaveBeenCalledTimes(3);
  });
});
