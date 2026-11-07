import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { initI18n, t } from '@/locales';
import { readClipboardText, writeClipboardText } from '@/lib/clipboard';
import { invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalRegistry } from '../registry/terminal-registry';
import { mountNativeManualView } from './native-terminal-manual-view';
import { nativeManualInputPlan } from './native-manual-input-plan';
import { installTerminalPasteHandler } from '../terminal-clipboard';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function verify() {
  await initI18n('en-US');
  const window = getCurrentWindow(); await window.show(); await window.setFocus();
  const parameters = new URL(location.href).searchParams;
  const token = parameters.get('token'), marker = parameters.get('manualMarker'), family = parameters.get('manualNativeFamily');
  assert(marker && /^MAC_MANUAL_[a-f0-9]{12}$/.test(marker) && (family === 'bash' || family === 'zsh'), 'Exact owned manual case required');
  const form=parameters.get('manualForm')??'nfc';assert(form==='nfc'||form==='nfd','Exact manual Unicode form required');
  const {expected,command}=nativeManualInputPlan(marker,form);
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(value) });
  const { root, host, button, copyButton } = mountNativeManualView(document.getElementById('root')!, family, command, form === 'nfd' ? t('ai.workspace.tool.copyCommand') : undefined);
  let clipboardPrepared = false;
  const session = await invokeCreateLocalSession(100, 30); useTerminalStore.getState().addSession(session);
  const controller = terminalRegistry.create(session.sessionId, (id, event) => useTerminalStore.getState().setStatus(id, event), (id, event) => useTerminalStore.getState().setClosed(id, event), id => useTerminalStore.getState().sessions.find(value => value.sessionId === id)?.status ?? 'connecting', () => {}, session.ptyInfo);
  const input: string[] = [], pasteEvents: string[] = []; let raw = '', pasteReadFailed = false;
  const inputSubscription = controller.terminal.onData(value => input.push(value));
  const outputSubscription = controller.subscribeOutput(value => { assert(raw.length + value.length <= 2 * 1024 * 1024, 'Manual output bound'); raw += value; });
  let disposePaste: (() => void) | undefined;
  const observePaste = (event: ClipboardEvent): void => { pasteEvents.push(event.clipboardData?.getData('text/plain') ?? ''); };
  try {
    controller.attach(host); await controller.whenOutputReady(); controller.focus();
    assert(controller.terminal.element, 'Actual terminal paste host missing');
    controller.terminal.element.addEventListener('paste', observePaste, true);
    disposePaste = installTerminalPasteHandler(controller.terminal, text => controller.terminal.paste(text), () => { pasteReadFailed = true; });
    const deadline = Date.now() + 25_000;
    let initial = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    while (!initial.session?.promptReady || initial.session.integrationState !== 'ready') {
      assert(Date.now() < deadline, 'Actual native terminal did not become ready');
      await new Promise(done => setTimeout(done, 25)); initial = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    }
    assert(initial.session.inputMode === 'native-inline', 'Manual case selected a raw terminal');
    const bounds = host.getBoundingClientRect(); assert(bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.height > 0, 'Manual terminal is outside the viewport');
    await report({ progress: 'Actual native manual terminal ready; awaiting real UI keyboard actions', evidence: { kind: 'actual-native-manual', family, marker, form, command, expected, initial, physicalActionsPending: true, noModel: true } });
    await new Promise<void>((done, reject) => {
      copyButton?.addEventListener('click', () => { void (async () => {
        copyButton.disabled = true;
        await writeClipboardText(command);
        const actual = await readClipboardText();
        assert(actual === command, 'Native system clipboard readback differs from the exact command before paste');
        clipboardPrepared = true;
        await report({ progress: 'Exact command written to and read back from the real system clipboard; awaiting physical paste and editing', evidence: { kind: 'actual-native-manual', family, marker, form, command, expected, initial, clipboardPrepared, physicalActionsPending: true, noModel: true } });
        controller.focus();
      })().catch(reject); }, { once: true });
      button.addEventListener('click', () => { void (async () => {
        assert(!pasteReadFailed, 'Actual native clipboard read failed');
        const rows = Array.from({ length: controller.terminal.buffer.normal.length }, (_, index) => controller.terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
        const data = input.join('');
        assert(input[0] === `\x1b[200~${command}\x1b[201~` || input[0] === command, `Actual paste bytes differ from the displayed ${form.toUpperCase()} command`);
        assert(rows.some(row => row.trim() === expected), 'Actual separate output line is missing; command echo is insufficient');
        assert(data.includes('\x1b[D') || data.includes('\x1bOD'), 'Actual Left input was not observed');
        assert(data.includes('\x7f') || data.includes('\b'), 'Actual erase input was not observed');
        assert(data.includes('\r'), 'Actual Enter input was not observed');
        assert(controller.terminal.getSelection === Terminal.prototype.getSelection && controller.terminal.open === Terminal.prototype.open, 'Public terminal methods were replaced');
        const final = await invokeGetTerminalBrokerSnapshot(session.sessionId);
        assert(!final.session?.inputObservation?.activeCommand && !final.session?.inputObservation?.nativeRecoveryRequired, 'Manual input unexpectedly created an Agent command or recovery gate');
        await report({ progress: 'Actual native manual keyboard editing and separate Unicode output verified', evidence: { kind: 'actual-native-manual', family, marker, form, command, expected, initial, final, input, raw, rows, pasteEvents, clipboardPrepared, pasteReadFailed, physicalActionsPending: false, publicApisUnmodified: true, noModel: true, scope: `Exact ${form.toUpperCase()} paste, real UI keyboard editing and ordinary output only; no combined-emoji glyph, complete display, Agent or native submission proof claimed` } }); done();
      })().catch(reject); }, { once: true });
    });
    if (parameters.get('manualReview') === 'true') { const response = await fetch(`/__native-p3-review/${token}`, { method: 'POST' }); assert(response.ok, 'Actual manual window review missing'); }
  } catch (error) {
    const rows = Array.from({ length: controller.terminal.buffer.normal.length }, (_, index) => controller.terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
    await report({ progress: 'Actual native manual input failure retained', evidence: { kind: 'actual-native-manual', failed: true, error: String(error), family, marker, form, command, expected, input, raw, rows, pasteEvents, clipboardPrepared, pasteReadFailed, physicalActionsPending: false, noModel: true } });
    throw error;
  } finally {
    controller.terminal.element?.removeEventListener('paste', observePaste, true); disposePaste?.(); inputSubscription.dispose(); outputSubscription(); terminalRegistry.dispose(session.sessionId); await invokeCloseSession(session.sessionId); root.unmount();
  }
}
void verify().then(() => ({ ok: true }), error => ({ ok: false, error: String(error) })).then(value => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, { method: 'POST', body: JSON.stringify(value) }));
