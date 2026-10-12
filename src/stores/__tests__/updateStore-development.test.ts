import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUpdateStore } from '../updateStore';
import { useToastStore } from '../toastStore';
import { t } from '@/locales';

beforeEach(() => {
  vi.stubEnv('DEV', true);
  useUpdateStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  useUpdateStore.getState().reset();
  useToastStore.setState({ toasts: [] });
});

it('keeps startup checks idle without notifications in development', async () => {
  const initialState = useUpdateStore.getState();
  const initialToasts = useToastStore.getState();

  await useUpdateStore.getState().runCheck('startup');

  expect(useUpdateStore.getState()).toBe(initialState);
  expect(useToastStore.getState()).toBe(initialToasts);
});

it.each(['idle', 'error', 'downloaded'] as const)(
  'shows one development notice for a manual check from %s',
  async (phase) => {
    useUpdateStore.setState({ phase });
    const initialState = useUpdateStore.getState();

    await useUpdateStore.getState().runCheck('manual');

    expect(useUpdateStore.getState()).toBe(initialState);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: t('update.developmentUnavailable'), variant: 'info' }),
    ]);
  },
);

it('shows one development notice without restarting for installation', async () => {
  useUpdateStore.setState({ phase: 'downloaded' });
  const initialState = useUpdateStore.getState();

  await useUpdateStore.getState().installNow();

  expect(useUpdateStore.getState()).toBe(initialState);
  expect(useToastStore.getState().toasts).toEqual([
    expect.objectContaining({ message: t('update.developmentUnavailable'), variant: 'info' }),
  ]);
});
