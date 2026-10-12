import { afterEach, expect, it, vi } from 'vitest';
import { useUpdateStore } from '../updateStore';
import { useToastStore } from '../toastStore';

afterEach(() => vi.unstubAllEnvs());

it('keeps development update checks and installation idle without notifications', async () => {
  vi.stubEnv('DEV', true);
  useUpdateStore.getState().reset();
  const initialState = useUpdateStore.getState();
  const initialToasts = useToastStore.getState();

  await useUpdateStore.getState().runCheck('startup');
  await useUpdateStore.getState().runCheck('manual');
  await useUpdateStore.getState().installNow();

  expect(useUpdateStore.getState()).toBe(initialState);
  expect(useToastStore.getState()).toBe(initialToasts);
});
