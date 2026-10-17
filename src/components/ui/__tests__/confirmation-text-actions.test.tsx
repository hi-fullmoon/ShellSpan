import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationDialog } from '../confirmation-dialog';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';

afterEach(cleanup);

it.each(['zh-CN', 'en-US'] as const)('keeps Agent confirmation actions text-only in idle and pending states in %s', async locale => {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const props = { open: true, onOpenChange: () => {}, title: 'Confirm', description: 'Details', confirmLabel: 'Continue', onConfirm: () => {} };
  const { rerender } = render(<ConfirmationDialog {...props} />);
  const buttons = () => within(screen.getByRole('alertdialog')).getAllByRole('button');
  for (const button of buttons()) expect(button.querySelector('svg')).toBeNull();
  for (const confirmPending of [false, true]) {
    rerender(<ConfirmationDialog {...props} textOnlyActions confirmPending={confirmPending} />);
    for (const button of buttons()) {
      expect(button.querySelector('svg')).toBeNull();
      if (confirmPending) expect(button).toBeDisabled();
    }
  }
});
