import { getCurrentWindow } from '@tauri-apps/api/window';
import { resolveResource } from '@tauri-apps/api/path';
import { terminalRegistry } from '../registry/terminal-registry';
import { terminalInputReadiness } from '../terminal-input-readiness';
import { useTerminalStore } from '@/stores/terminalStore';
import { initI18n } from '@/locales';
import { invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot, invokeReadTextFile } from '@/lib/ipc/tauri';
import {isCurrentNativeEditorProfile} from './native-editor-profile';
import {nativeFileCoreSetup,readNativeFileLoadedCore} from './native-file-chain-approval';
import {createNativePackageHost,nativePackageViewport} from './native-package-viewport';
import '@/styles/base.css';

declare const __PACKAGE_REPORT__: string;
declare const __PACKAGE_INSTALL_ROOT__: string;
declare const __PACKAGE_MANIFEST_SHA__: string;
declare const __PACKAGE_VALIDATION_ONLY__: boolean;
declare const __PACKAGE_NATIVE_SHA__: string|null;
declare const __PACKAGE_SHELL_KIND__: string;
declare const __PACKAGE_SHELL_VERSION__: string;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
async function until(test: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000;
  while (!await test()) { assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 25)); }
}

async function verify() {
  await initI18n('en-US');
  await getCurrentWindow().show(); await getCurrentWindow().setFocus();
  const resourcePath = await resolveResource('native-input/generated/resource-manifest.json');
  assert(normalize(resourcePath).startsWith(normalize(__PACKAGE_INSTALL_ROOT__) + '/'), 'Resource resolver escaped this owned installation');
  const text = await invokeReadTextFile(resourcePath);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
  assert(sha256 === __PACKAGE_MANIFEST_SHA__, 'Installed resource manifest differs from the packaged input');
  const manifest: unknown = JSON.parse(text);
  assert(manifest && typeof manifest === 'object' && 'targets' in manifest && Array.isArray(manifest.targets)
    && 'unsupportedHost' in manifest && manifest.unsupportedHost === !__PACKAGE_VALIDATION_ONLY__ && 'validationOnly' in manifest && manifest.validationOnly === __PACKAGE_VALIDATION_ONLY__
    && (__PACKAGE_VALIDATION_ONLY__?manifest.targets.includes('editors-windows-x64.json'):manifest.targets.length===0),'Installed package admission manifest differs');
  const host = createNativePackageHost();
  const session = await invokeCreateLocalSession(100, 30); useTerminalStore.getState().addSession(session);
  const controller = terminalRegistry.create(session.sessionId, (id, event) => useTerminalStore.getState().setStatus(id, event),
    (id, event) => useTerminalStore.getState().setClosed(id, event), id => useTerminalStore.getState().sessions.find(value => value.sessionId === id)?.status ?? 'connecting', () => {}, session.ptyInfo);
  try {
    assert(session.ptyInfo?.inputMode === (__PACKAGE_VALIDATION_ONLY__?'native-inline':'raw'), 'Installed package mode differs from its explicit validation scope');
    controller.attach(host); await controller.whenOutputReady();
    await until(() => !terminalInputReadiness.isPreparing(session.sessionId)
      && useTerminalStore.getState().sessions.find(value => value.sessionId === session.sessionId)?.status === 'connected', 'Installed raw terminal did not become ready');
    const lines = () => Array.from({ length: controller.terminal.buffer.normal.length }, (_, index) => controller.terminal.buffer.normal.getLine(index)?.translateToString(true)?.trim() ?? '');
    if(__PACKAGE_VALIDATION_ONLY__)await until(async()=>{const s=(await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;return !!s?.promptReady&&isCurrentNativeEditorProfile(s.nativePeerProfile,s.integrationShell??null);},'Installed validation native provider did not bind');
    let raw='';const unsubscribe=controller.subscribeOutput(value=>{if(raw.length<524288)raw+=value;});
    const source = (__PACKAGE_VALIDATION_ONLY__?nativeFileCoreSetup+'; ':'')+"[Console]::WriteLine('PACKAGE_USER_'+'OK')";
    assert(await controller.writeUserInput(source + '\r'), 'Ordinary raw user input was blocked');
    await until(() => lines().includes('PACKAGE_USER_OK'), 'Installed ordinary command did not produce an intact output line');
    assert(lines().filter(line => line === 'PACKAGE_USER_OK').length === 1, 'Ordinary command output was duplicated');
    const snapshot = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    if(__PACKAGE_VALIDATION_ONLY__)assert(snapshot.session?.nativePeerProfile?.shell===__PACKAGE_SHELL_KIND__&&snapshot.session.nativePeerProfile.shellVersion===__PACKAGE_SHELL_VERSION__,'Installed native provider bound a different host or version');
    assert(snapshot.session?.inputMode === (__PACKAGE_VALIDATION_ONLY__?'native-inline':'raw') && !snapshot.session.inputObservation?.activeCommand, 'Ordinary editing changed its mode or created an Agent operation');
    const loadedCore=__PACKAGE_VALIDATION_ONLY__?readNativeFileLoadedCore(raw):null;unsubscribe();if(__PACKAGE_VALIDATION_ONLY__)assert(loadedCore?.sha256===__PACKAGE_NATIVE_SHA__,'Installed runtime did not load the candidate native DLL');
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const viewport = nativePackageViewport(host, controller.terminal.element);
    const capture = await fetch(__PACKAGE_REPORT__ + '/capture', { method: 'POST' });
    assert(capture.ok, `Owned package screenshot failed: ${await capture.clone().text()}`);
    const windowEvidence: unknown = await capture.json();
    return { resourcePath, manifest, manifestSha256: sha256, session, snapshot, source, loadedCore,viewport,validationOnly:__PACKAGE_VALIDATION_ONLY__,rendered: lines().join('\n'), windowEvidence,
      scope: 'Actual installed default or explicit validation-only resource binding and ordinary user editing; no model/Agent command or full A06 claim' };
  } finally { terminalRegistry.dispose(session.sessionId); await invokeCloseSession(session.sessionId); host.remove(); }
}
void verify().then(evidence => ({ ok: true, evidence }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  .then(value => fetch(__PACKAGE_REPORT__, { method: 'POST', body: JSON.stringify(value) }));
