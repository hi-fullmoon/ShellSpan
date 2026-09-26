import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Workbench from '../index';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainStore } from '@/stores/keychainStore';
import { initI18n } from '@/locales';
import { invokeListKeyCredentials, isTauriRuntime } from '@/lib/ipc/tauri';

// Run only through scripts/verify-credential-refresh.mjs in a real Tauri window.
// No IPC, store action or credential response is replaced by a test double.
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function verify(): Promise<void> {
  assert(isTauriRuntime(), 'This regression requires the native Tauri runtime');
  await initI18n('en-US');
  useAppStore.setState({ locale: 'en-US', activeWorkbenchTab: 'keychain' });
  await useProfileStore.getState().hydrateFromDb();
  await useKeychainStore.getState().hydrate();
  assert(useKeychainStore.getState().initialized, 'Initial credential load failed');

  const container = document.getElementById('root');
  assert(container, 'Missing test root');
  const root = createRoot(container);
  const name = `credential-refresh-${crypto.randomUUID()}`;
  let profileId: string | undefined;
  const shows = (label: string): boolean =>
    [...container.querySelectorAll('.grid span')].some((element) => element.textContent === label);
  try {
    flushSync(() => root.render(<Workbench />));
    flushSync(() => useAppStore.getState().setActiveWorkbenchTab('connections'));
    // This follows the same persistence path as submitting the connection form.
    const profile = await useProfileStore.getState().addProfile({
      name,
      host: '127.0.0.1',
      port: 22,
      username: 'credential-refresh-regression',
      authMethod: 'password',
      password: crypto.randomUUID(),
    });
    profileId = profile.id;
    assert((await invokeListKeyCredentials()).some((key) => key.id === profileId),
      'New connection did not persist credential metadata');
    assert(!useKeychainStore.getState().keys.some((key) => key.id === profileId),
      'Precondition failed: credential cache must still be stale before switching');

    flushSync(() => useAppStore.getState().setActiveWorkbenchTab('keychain'));
    await eventually(() => shows(name), 'Returning to credentials did not display the new credential');
    assert(useKeychainStore.getState().keys.some((key) => key.id === profileId),
      'Successful refresh did not update the credential store');

    const renamed = `${name}-renamed`;
    await useProfileStore.getState().updateProfile(profileId, { name: renamed });
    await eventually(() => [...container.querySelectorAll('p[title]')]
      .some((element) => element.getAttribute('title') === `Used by: ${renamed}`),
    'Editing a connection while credentials are visible left the old association');

    await useProfileStore.getState().removeProfile(profileId);
    await eventually(() => !shows(name)
      && !useKeychainStore.getState().keys.some((key) => key.id === profileId),
    'Removing a connection left its credential visible');
    assert(!(await invokeListKeyCredentials()).some((key) => key.id === profileId),
      'Credential metadata was not cleaned up');
    profileId = undefined;
  } finally {
    root.unmount();
    // Cleanup uses the production action to remove both metadata and keychain secrets.
    if (profileId) await useProfileStore.getState().removeProfile(profileId);
  }
}

void verify().then(
  () => ({ ok: true }),
  (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'Native regression failed' }),
).then(async (result) => {
  await fetch(`/__credential-refresh-result/${new URLSearchParams(location.search).get('token')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
});
