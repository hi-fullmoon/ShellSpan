import {getCurrentWindow} from '@tauri-apps/api/window';
import {invokeStoreProfilePassword, invokeRetrieveProfilePassword, invokeDeleteProfilePassword, invokeListAiRoutes} from '@/lib/ipc/tauri';
import {credentialLifecycleReference, runCredentialLifecycle} from './native-credential-lifecycle-plan';

export async function verifyNativeCredentialLifecycle() {
  const token = new URL(location.href).searchParams.get('token');
  if (!token) throw Error('Owned credential lifecycle token required');
  const reference = credentialLifecycleReference(token), app = getCurrentWindow();
  const visibility = {visible: await app.isVisible(), focused: await app.isFocused()};
  if (visibility.visible || visibility.focused) throw Error('E07 API-only App must remain hidden and unfocused');
  const routes = await invokeListAiRoutes();if (routes.routes.length || routes.defaultSelection) throw Error('E07 API-only App requires an empty owned route store');
  const checkpoint = async (phase: string) => {
    const response = await fetch(`/__native-e07-credential/${token}`, {method: 'POST', body: JSON.stringify({reference, phase})});
    if (!response.ok) throw Error('E07 owned metadata checkpoint refused');
  };
  let result: Awaited<ReturnType<typeof runCredentialLifecycle>> | undefined;
  try {
    result = await runCredentialLifecycle(reference, {retrieve: invokeRetrieveProfilePassword, store: invokeStoreProfilePassword, delete: invokeDeleteProfilePassword}, checkpoint, () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      try { return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''); } finally { bytes.fill(0); }
    });
    const after = {visible: await app.isVisible(), focused: await app.isFocused()};
    if (after.visible || after.focused) throw Error('E07 API-only App changed its visibility/focus');
    await fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify({evidence: {kind: 'actual-native-credential-lifecycle', reference, result, visibility, after, terminalCreated: false, modelRequests: 0, screenshotRequested: false, scope: 'One fresh owned Windows profile-password CredentialRef through normal Tauri APIs only;not full E07 lifecycle/platform or B07/App visual acceptance.'}, progress: 'Owned normal API credential stored,roundtrip checked,deleted twice and absence confirmed.'})});
  } catch {
    await fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify({evidence: {kind: 'actual-native-credential-lifecycle-failure', failed: true, reference, result, visibility, error: 'E07 normal API lifecycle did not complete', terminalCreated: false, modelRequests: 0}, progress: 'E07 credential lifecycle failure retained;only the fresh owned reference may be cleaned.'})});
    throw Error('E07 normal API lifecycle did not complete');
  }
}
