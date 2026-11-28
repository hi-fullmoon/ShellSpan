import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import { PetdexMessageSettings } from '../petdex-message-settings';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import * as petdexMessages from '@/lib/petdex/messages';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { SettingsPanel } from '../settings-panel';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it.each([
  ['zh-CN', '桌面宠物', '实验性集成'],
  ['en-US', 'Desktop pets', 'Experimental integrations'],
] as const)('opens the pet settings through a readable menu in %s', async (locale, title, previousTitle) => {
  useAppStore.setState({ locale, activeSettingsSection: 'general', petdexEnabled: false });
  await initI18n(locale);
  render(<SettingsPanel />);
  const tab = await screen.findByRole('tab', { name: title });
  expect(tab.querySelector('svg')).toBeNull();
  expect(screen.queryByRole('tab', { name: previousTitle })).not.toBeInTheDocument();
  await userEvent.click(tab);
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  const strings = locale === 'zh-CN' ? zhCN : enUS;
  expect(screen.getByText(strings['settings.experimental.description'])).toBeVisible();
  expect(screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.enabled'] })).toBeVisible();
  expect(document.querySelector('[data-slot="petdex-preferences"]')).toHaveAttribute('data-inactive', 'true');
});

it.each(['zh-CN', 'en-US'] as const)('renders default gates, readable labels, keyboard focus and header action in %s', async (locale) => {
  useAppStore.setState({ locale, petdexEnabled: false, petdexMessagesEnabled: false, petdexMessageDetailsEnabled: false, petdexRequestedMessages: null });
  await initI18n(locale);
  const strings = locale === 'zh-CN' ? zhCN : enUS;
  const history = toast.getHistory().length;
  render(<StrictMode><PetdexMessageSettings /></StrictMode>);
  const test = screen.getByRole('button', { name: strings['settings.experimental.petdex.messages.test'] });
  expect(test).toBeDisabled();
  expect(test.closest('[data-slot="settings-group-header"]')).not.toBeNull();
  const message = screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.enabled'] });
  const details = screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.details'] });
  expect(message).not.toBeChecked();
  expect(message).toHaveAccessibleDescription(`${strings['settings.experimental.petdex.messages.description']} ${strings['settings.experimental.petdex.messages.visibility']}`);
  expect(details).not.toBeChecked();
  expect(message).not.toBeDisabled();
  expect(details).toHaveAttribute('aria-describedby', 'petdex-message-risk');
  expect(screen.getByText(strings['settings.experimental.petdex.messages.risk'])).toBeVisible();
  message.focus();
  await userEvent.tab();
  expect(details).toHaveFocus();
  expect(toast.getHistory()).toHaveLength(history);
});

it('discards stale test message toast when messages are turned off mid-flight', async () => {
  useAppStore.setState({
    locale: 'en-US',
    petdexEnabled: true,
    petdexMessagesEnabled: true,
    petdexMessageDetailsEnabled: false,
    petdexRequestedMessages: null,
    petdexConfiguring: false,
  });
  await initI18n('en-US');
  let resolveTest!: (value: petdexMessages.PetdexMessageTestResult) => void;
  vi.spyOn(petdexMessages, 'testPetdexMessage').mockImplementation(
    () => new Promise((resolve) => { resolveTest = resolve; }),
  );
  const historyBefore = toast.getHistory().length;
  render(<PetdexMessageSettings />);

  await userEvent.click(screen.getByRole('button', { name: enUS['settings.experimental.petdex.messages.test'] }));
  act(() => {
    useAppStore.setState({ petdexMessagesEnabled: false });
  });
  await act(async () => {
    resolveTest({
      outcome: 'accepted',
      diagnostic: {
        revision: 5,
        status: 'disabled',
        acceptedCount: 1,
        lastAcceptedAt: 1000,
        usedSlotCount: 1,
        errorReason: null,
        unsupported: false,
        cleanupOutcome: 'notNeeded',
      },
    });
    await Promise.resolve();
  });

  expect(toast.getHistory()).toHaveLength(historyBefore);
});

it('still confirms saved feedback and syncs diagnostic when disabling messages', async () => {
  const diagnostic = {
    revision: 4,
    status: 'connected' as const,
    errorReason: null,
    targetAction: 'idle' as const,
    lastSuccessAt: 1000,
  };
  useAppStore.setState({
    locale: 'en-US',
    petdexEnabled: true,
    petdexBackendEnabled: true,
    petdexMessagesEnabled: true,
    petdexBackendMessages: { petdexMessagesEnabled: true, petdexMessageDetailsEnabled: false },
    petdexMessageDetailsEnabled: false,
    petdexRequestedMessages: null,
    petdexConfiguring: false,
  });
  await initI18n('en-US');
  vi.spyOn(petdexMessages, 'configurePetdexSettings').mockResolvedValue({
    effective: {
      enabled: true,
      categories: { ssh: true, sftp: true, ai: false },
      petdexMessagesEnabled: false,
      petdexMessageDetailsEnabled: false,
      locale: 'en-US',
    },
    diagnostic,
    cleanupOutcome: 'accepted',
    messageDiagnostic: {
      revision: 6,
      status: 'disabled',
      acceptedCount: 1,
      lastAcceptedAt: 1000,
      usedSlotCount: 1,
      errorReason: null,
      unsupported: false,
      cleanupOutcome: 'accepted',
    },
  });
  const onPreferenceSync = vi.fn();
  const onRetrySubscription = vi.fn();
  const toastSpy = vi.spyOn(toast, 'success');
  render(
    <PetdexMessageSettings
      onPreferenceSync={onPreferenceSync}
      onRetrySubscription={onRetrySubscription}
    />,
  );

  await userEvent.click(screen.getByRole('switch', { name: enUS['settings.experimental.petdex.messages.enabled'] }));

  expect(onRetrySubscription).toHaveBeenCalledTimes(1);
  expect(onPreferenceSync).toHaveBeenCalledWith(diagnostic);
  expect(toastSpy).toHaveBeenCalledWith(
    enUS['settings.experimental.petdex.messages.saved'],
    { id: 'petdex-preferences-saved' },
  );
});
