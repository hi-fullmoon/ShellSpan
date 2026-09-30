import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { toast } from 'sonner';
import { afterEach, expect, it } from 'vitest';
import { PetdexMessageSettings } from '../petdex-message-settings';
import { Card } from '@/components/ui/card';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { SettingsPanel } from '../settings-panel';

afterEach(cleanup);
it.each([
  ['zh-CN', '桌面宠物', '实验性集成'],
  ['en-US', 'Desktop pets', 'Experimental integrations'],
] as const)('opens the pet settings through a readable menu in %s', async (locale, title, previousTitle) => {
  useAppStore.setState({ locale, activeSettingsSection: 'general', petdexEnabled: false });
  await initI18n(locale);
  render(<SettingsPanel />);
  const tab = await screen.findByRole('tab', { name: title });
  expect(tab.querySelector('.lucide-paw-print')).not.toBeNull();
  expect(screen.queryByRole('tab', { name: previousTitle })).not.toBeInTheDocument();
  await userEvent.click(tab);
  expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  const strings = locale === 'zh-CN' ? zhCN : enUS;
  expect(screen.getByText(strings['settings.experimental.description'])).toBeVisible();
  expect(screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.enabled'] })).toBeVisible();
});

it.each(['zh-CN', 'en-US'] as const)('renders default gates, readable labels, keyboard focus and accepted wording in %s', async (locale) => {
  useAppStore.setState({ locale, petdexEnabled: false, petdexMessagesEnabled: false, petdexMessageDetailsEnabled: false, petdexRequestedMessages: null });
  await initI18n(locale);
  const strings = locale === 'zh-CN' ? zhCN : enUS;
  const history = toast.getHistory().length;
  render(<StrictMode><Card><PetdexMessageSettings /></Card></StrictMode>);
  const test = screen.getByRole('button', { name: strings['settings.experimental.petdex.messages.test'] });
  expect(test).toBeDisabled();
  expect(test.closest('[data-slot="card-action"]')).not.toBeNull();
  const message = screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.enabled'] });
  const details = screen.getByRole('switch', { name: strings['settings.experimental.petdex.messages.details'] });
  expect(message).not.toBeChecked();
  expect(details).not.toBeChecked();
  expect(message).not.toBeDisabled();
  expect(details).toHaveAttribute('aria-describedby', 'petdex-message-risk');
  expect(screen.getByText(strings['settings.experimental.petdex.messages.risk'])).toBeVisible();
  message.focus();
  await userEvent.tab();
  expect(details).toHaveFocus();
  expect(screen.getAllByRole('definition')).toHaveLength(4);
  expect(toast.getHistory()).toHaveLength(history);
});
