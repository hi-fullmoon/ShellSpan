import {getCurrentWindow} from '@tauri-apps/api/window';
import {invokeListAiRoutes, invokeSaveAiRoutes, invokeGetAiRouteApiKey} from '@/lib/ipc/tauri';
import {assertOwnedAiReference, isMissingAiCredential, ownedAiCredentialRoute} from './native-ai-credential-plan';
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
export async function verifyNativeAiCredential() {
  const params = new URL(location.href).searchParams, token = params.get('token'), mode = params.get('nativeAiCredentialMode');
  assert(token && (mode === 'provision' || mode === 'verify-absence'), 'Owned AI credential mode required');
  const endpoint = `/__native-e07-ai-credential/${token}`, calls: string[] = [];
  const post = async (action: string, value: unknown = {}) => { const response = await fetch(endpoint + '/' + action, {method: 'POST', body: JSON.stringify(value)});assert(response.ok, 'Owned AI credential checkpoint refused');return response.json() as Promise<Record<string, unknown>>; };
  let reference: string | undefined;
  try {
    const app = getCurrentWindow(), visibility = {visible: await app.isVisible(), focused: await app.isFocused()};assert(!visibility.visible && !visibility.focused, 'AI credential API App must remain hidden/unfocused');
    const config = await post('config');assert(config.mode === mode && typeof config.runId === 'string', 'Owned AI credential configuration differs');
    const route = ownedAiCredentialRoute(config.runId);calls.push('ai_list_routes');const before = await invokeListAiRoutes();
    if (mode === 'provision') {
      assert(before.routes.length === 0 && !before.defaultSelection, 'AI credential source must be an empty owned route store');await post('baseline');
      const bytes = crypto.getRandomValues(new Uint8Array(32));let secret: string | undefined;
      try {
        secret = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');calls.push('ai_save_routes');
        const saved = await invokeSaveAiRoutes({routes: [route], expectedRevision: before.revision, secrets: {[route.id]: secret}}), created = saved.routes.find(value => value.id === route.id);
        assert(saved.routes.length === 1 && created?.auth.kind === 'keychain' && !saved.defaultSelection, 'Normal AI save did not return exactly the owned credential route');reference = created.auth.reference;assertOwnedAiReference(reference);
        calls.push('ai_get_route_api_key');assert(await invokeGetAiRouteApiKey(route.id) === secret, 'Normal AI credential readback differs');
      } finally { bytes.fill(0);secret = undefined; }
      await post('receipt', {reference, readbackMatches: true});
    } else {
      assertOwnedAiReference(config.expectedReference);reference = config.expectedReference;
      assert(before.routes.length === 1 && before.routes[0].id === route.id && before.routes[0].auth.kind === 'keychain' && before.routes[0].auth.reference === reference, 'Absence query must address the original owned committed reference');
      let missing = false;calls.push('ai_get_route_api_key');try { await invokeGetAiRouteApiKey(route.id); } catch (error) { missing = isMissingAiCredential(error); }assert(missing, 'Normal AI API did not confirm exact MISSING_CREDENTIAL');await post('absence', {reference, missing: true});
      calls.push('ai_save_routes');const cleared = await invokeSaveAiRoutes({routes: [], expectedRevision: before.revision});assert(cleared.routes.length === 0 && !cleared.defaultSelection, 'Owned route metadata was not cleared normally');
      calls.push('ai_list_routes');const after = await invokeListAiRoutes();assert(after.routes.length === 0 && !after.defaultSelection && after.revision === cleared.revision, 'Normal metadata cleanup did not remain stable');await post('cleared', {reference});
    }
    const afterVisibility = {visible: await app.isVisible(), focused: await app.isFocused()};assert(!afterVisibility.visible && !afterVisibility.focused, 'AI credential API App changed visibility/focus');
    await fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify({evidence: {kind: 'actual-native-ai-credential-' + mode, mode, reference, calls, visibility, afterVisibility, normalApiReadbackOrAbsenceVerified: true, secretExported: false, terminalCreated: false, modelRequests: 0, providerNetworkRequested: false, screenshotRequested: false}, progress: 'Owned AI credential normal API ' + mode + ' completed without model or terminal.'})});
  } catch {
    await fetch(`/__agent-stream-result/${token}`, {method: 'POST', body: JSON.stringify({evidence: {kind: 'actual-native-ai-credential-failure', failed: true, mode, reference, calls, error: 'E07 owned AI credential API phase failed', secretExported: false, terminalCreated: false, modelRequests: 0}, progress: 'Owned AI credential phase failure retained; only independently owned new references may be cleaned.'})});throw Error('E07 owned AI credential API phase failed');
  }
}
