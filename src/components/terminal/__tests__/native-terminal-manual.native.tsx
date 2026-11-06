import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { initI18n } from '@/locales';
import { invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { terminalRegistry } from '../registry/terminal-registry';
import { mountNativeManualView } from './native-terminal-manual-view';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function verify() {
  await initI18n('en-US');
  const window = getCurrentWindow(); await window.show(); await window.setFocus();
  const parameters = new URL(location.href).searchParams;
  const token = parameters.get('token'), marker = parameters.get('manualMarker'), family = parameters.get('manualNativeFamily');
  assert(marker && /^MAC_MANUAL_[a-f0-9]{12}$/.test(marker) && (family === 'bash' || family === 'zsh'), 'Exact owned manual case required');
  // macOS pasteboard input observed through CUA composes the accent before
  // xterm receives it. This case checks exact NFC input and output; it does
  // not claim to exercise a decomposed accent through the pasteboard.
  const expected = `${marker} 中文 é 👩🏽‍💻 edit=BAD`;
  const command = `printf '%s\\n' '${expected}'`;
  const report = (value: unknown) => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(value) });
  const { root, host, button } = mountNativeManualView(document.getElementById('root')!, family, command);
  const session = await invokeCreateLocalSession(100, 30); useTerminalStore.getState().addSession(session);
  const controller = terminalRegistry.create(session.sessionId, (id, event) => useTerminalStore.getState().setStatus(id, event), (id, event) => useTerminalStore.getState().setClosed(id, event), id => useTerminalStore.getState().sessions.find(value => value.sessionId === id)?.status ?? 'connecting', () => {}, session.ptyInfo);
  const input: string[] = []; let raw = '';
  const inputSubscription = controller.terminal.onData(value => input.push(value));
  const outputSubscription = controller.subscribeOutput(value => { assert(raw.length + value.length <= 2 * 1024 * 1024, 'Manual output bound'); raw += value; });
  try {
    controller.attach(host); await controller.whenOutputReady(); controller.focus();
    const deadline = Date.now() + 25_000;
    let initial = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    while (!initial.session?.promptReady || initial.session.integrationState !== 'ready') {
      assert(Date.now() < deadline, 'Actual native terminal did not become ready');
      await new Promise(done => setTimeout(done, 25)); initial = await invokeGetTerminalBrokerSnapshot(session.sessionId);
    }
    assert(initial.session.inputMode === 'native-inline', 'Manual case selected a raw terminal');
    const bounds = host.getBoundingClientRect(); assert(bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.height > 0, 'Manual terminal is outside the viewport');
    await report({ progress: 'Actual native manual terminal ready; awaiting real UI keyboard actions', evidence: { kind: 'actual-native-manual', family, marker, command, expected, initial, physicalActionsPending: true, noModel: true } });
    await new Promise<void>((done, reject) => {
      button.addEventListener('click', () => { void (async () => {
        const rows = Array.from({ length: controller.terminal.buffer.normal.length }, (_, index) => controller.terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
        assert(rows.some(row => row.trim() === expected), 'Actual separate output line is missing; command echo is insufficient');
        const data = input.join('');
        assert(input[0] === `\x1b[200~${command}\x1b[201~` || input[0] === command, 'Actual paste bytes differ from the displayed NFC command');
        assert(data.includes('\x1b[D') || data.includes('\x1bOD'), 'Actual Left input was not observed');
        assert(data.includes('\x7f') || data.includes('\b'), 'Actual erase input was not observed');
        assert(data.includes('\r'), 'Actual Enter input was not observed');
        assert(controller.terminal.getSelection === Terminal.prototype.getSelection && controller.terminal.open === Terminal.prototype.open, 'Public terminal methods were replaced');
        const final = await invokeGetTerminalBrokerSnapshot(session.sessionId);
        assert(!final.session?.inputObservation?.activeCommand && !final.session?.inputObservation?.nativeRecoveryRequired, 'Manual input unexpectedly created an Agent command or recovery gate');
        await report({ progress: 'Actual native manual keyboard editing and separate Unicode output verified', evidence: { kind: 'actual-native-manual', family, marker, command, expected, initial, final, input, raw, rows, physicalActionsPending: false, publicApisUnmodified: true, noModel: true, scope: 'Exact NFC paste, real UI keyboard editing and ordinary output only; no decomposed-accent, complete display, Agent or native submission proof claimed' } }); done();
      })().catch(reject); }, { once: true });
    });
    if (parameters.get('manualReview') === 'true') { const response = await fetch(`/__native-p3-review/${token}`, { method: 'POST' }); assert(response.ok, 'Actual manual window review missing'); }
  } catch (error) {
    const rows = Array.from({ length: controller.terminal.buffer.normal.length }, (_, index) => controller.terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
    await report({ progress: 'Actual native manual input failure retained', evidence: { kind: 'actual-native-manual', failed: true, error: String(error), family, marker, command, expected, input, raw, rows, physicalActionsPending: false, noModel: true } });
    throw error;
  } finally {
    inputSubscription.dispose(); outputSubscription(); terminalRegistry.dispose(session.sessionId); await invokeCloseSession(session.sessionId); root.unmount();
  }
}
void verify().then(() => ({ ok: true }), error => ({ ok: false, error: String(error) })).then(value => fetch(`/__agent-stream-result/${new URL(location.href).searchParams.get('token')}`, { method: 'POST', body: JSON.stringify(value) }));
