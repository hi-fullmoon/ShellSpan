import { invokeListAiRoutes, invokeResolveAiSelection, invokeTestAiConnection } from '@/lib/ipc/tauri';
import { modelDefinitionOf } from '@/lib/ai/provider-contract';
import type { AiProviderConnectionConfig, AiConnectionTestResult } from '@/types/ai';
import {nativePackageEndpoint} from './native-package-endpoint';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

let stage: 'listRoutes' | 'resolveSelection' | 'testConnection' | 'verifyUnchanged' = 'listRoutes';
let connectionApiInvocations = 0;

async function verify() {
  const before = await invokeListAiRoutes();
  const selection = before.defaultSelection;
  assert(selection, 'The isolated model preflight has no default selection');
  const route = before.routes.find(route => route.id === selection.routeId);
  assert(route && route.auth.kind === 'keychain', 'Expected the existing keychain-backed route');
  stage = 'resolveSelection';
  const resolved = await invokeResolveAiSelection(selection, route.revision);
  const provider: Omit<AiProviderConnectionConfig, 'routeRevision' | 'apiKey'> = {
    id: route.id, kind: resolved.kind,
    baseUrl: route.baseUrl, model: selection.modelId, profile: resolved.profile,
    requiresApiKey: true, retryPolicy: route.retryPolicy,
    modelDefinition: modelDefinitionOf(resolved),
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
  // No raw-key getter or route-save command. The real backend uses the existing
  // reference and returns only its bounded, response-text-free connection result.
  stage = 'testConnection';
  connectionApiInvocations += 1;
  const result: AiConnectionTestResult = await invokeTestAiConnection(provider, AbortSignal.timeout(35_000));
  stage = 'verifyUnchanged';
  const after = await invokeListAiRoutes();
  assert(JSON.stringify(before) === JSON.stringify(after), 'Model preflight changed isolated route metadata');
  const evidence = {
    kind: 'actual-native-model-connection-preflight', result,
    routeMetadataUnchanged: true, credentialValueRequestedByFrontend: false,
    credentialSavedOrDeleted: false, modelConnectionAttempts: 1,
    agentCreated: false, terminalCreated: false, terminalCommandsSent: 0,
    scope: 'Normal native backend bounded model connection only; not E06 Agent/terminal execution or production admission',
  };
  const status = document.getElementById('status');
  if (status) status.textContent = result.type === 'success'
    ? 'Model connection succeeded. No Agent or terminal commands were executed.'
    : `Model connection failed: ${result.kind}. No Agent or terminal commands were executed.`;
  return { ok: result.type === 'success', ...(result.type === 'success' ? {} : { error: `MODEL_PREFLIGHT_${result.kind.toUpperCase()}` }), evidence };
}

void verify().catch((error: unknown) => {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const code = /^([A-Z][A-Z0-9_]{1,80})(?::|$)/u.exec(text)?.[1]
    ?? (/^invalid args /u.test(text) ? 'INVALID_IPC_ARGUMENTS' : 'UNCLASSIFIED');
  return { ok: false, error: `MODEL_PREFLIGHT_${stage}_${code}`, evidence: {
    kind: 'actual-native-model-connection-preflight-failure', stage, code, connectionApiInvocations,
    credentialValueRequestedByFrontend: false, credentialSavedOrDeleted: false,
    scope: 'Bounded failure code only; no arbitrary provider body, URL, credential or model response',
  } };
})
  .then(result => fetch(nativePackageEndpoint(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`), { method: 'POST', body: JSON.stringify(result) }));
