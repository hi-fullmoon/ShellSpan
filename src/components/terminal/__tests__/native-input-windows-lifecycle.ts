import { terminalRegistry } from '../registry/terminal-registry';
import { terminalInputReadiness } from '../terminal-input-readiness';
import { useTerminalStore } from '@/stores/terminalStore';
import { invokeCreateLocalSession, invokeCloseSession, invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import type { SessionSummary } from '@/types';
import { isCurrentNativeEditorProfile } from './native-editor-profile';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function until(test: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (!await test()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

export async function verifyWindowsNativeLifecycle(parameters: URLSearchParams) {
  const selectedHost = parameters.get('nativeP3');
  assert(selectedHost === 'powerShell7' || selectedHost === 'windowsPowerShell', 'Windows lifecycle requires an exact admitted Windows provider');
  const host = document.createElement('div');
  host.style.cssText = 'width:1100px;height:650px';
  // The shared fixture has a full-height #root; appending after it leaves the
  // terminal outside the hidden body viewport despite a correct xterm buffer.
  (document.getElementById('root') ?? document.body).append(host);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const bounds = host.getBoundingClientRect();
  assert(bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= window.innerHeight + 1,
    'Actual Windows lifecycle terminal is outside the visible fixture viewport');
  const sessions: string[] = [];
  const createdSessions: SessionSummary[] = [];
  const stages: unknown[] = [];
  const connections: unknown[] = [];
  const output: string[] = [];
  let controller: ReturnType<typeof terminalRegistry.create> | undefined;
  let unsubscribe: (() => void) | undefined;
  const add = (session: SessionSummary) => {
    createdSessions.push(session);
    sessions.push(session.sessionId);
    useTerminalStore.getState().addSession(session);
  };
  const text = () => {
    assert(controller, 'Missing actual registry controller');
    const buffer = controller.terminal.buffer.normal;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
  };
  const connected = async (session: SessionSummary, native: boolean) => {
    assert(controller, 'Missing actual registry controller');
    if (native) assert(session.ptyInfo?.inputMode === 'native-inline' && !!session.ptyInfo.nativeDisplayBinding,
      'Actual native session creation returned without a negotiated display binding');
    await controller.whenOutputReady();
    await until(() => !terminalInputReadiness.isPreparing(session.sessionId)
      && useTerminalStore.getState().sessions.find(value => value.sessionId === session.sessionId)?.status === 'connected', 'Actual replacement transport did not connect');
    if (native) await until(async () => {
      const snapshot = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
      return !!snapshot?.promptReady && snapshot.integrationState === 'ready'
        && snapshot.inputMode === 'native-inline' && isCurrentNativeEditorProfile(snapshot.nativePeerProfile, selectedHost);
    }, 'Actual replacement did not negotiate the pinned native editor');
    if (native) {
      assert(session.ptyInfo?.nativeDisplayBinding?.unicodeVersion === '15-graphemes'
        && session.ptyInfo.nativeDisplayBinding.unicodeScope === 'session'
        && controller.terminal.unicode.activeVersion === '15-graphemes', 'Actual private ConPTY did not bind session-scoped grapheme measurement');
    } else assert(controller.terminal.unicode.activeVersion === '6', 'Raw rebind retained the old native Unicode provider');
    const snapshot = (await invokeGetTerminalBrokerSnapshot(session.sessionId)).session;
    assert(snapshot?.geometry.columns === controller.terminal.cols && snapshot.geometry.rows === controller.terminal.rows,
      'Replacement PTY geometry differs from the existing renderer');
    connections.push({ sessionId: session.sessionId, ptyInfo: session.ptyInfo,
      unicodeVersion: controller.terminal.unicode.activeVersion,
      snapshot });
  };
  const send = async (source: string) => {
    assert(controller, 'Missing actual registry controller');
    assert(await controller.writeUserInput(`${source}\r`), 'Ordinary fixture user input was rejected');
  };
  const disconnected = async (session: SessionSummary) => {
    await until(() => useTerminalStore.getState().sessions.find(value => value.sessionId === session.sessionId)?.status === 'disconnected', 'Actual ConPTY child did not reach EOF');
    await until(() => controller?.terminal.options.reflowCursorLine === false, 'Real EOF did not restore the display baseline');
    await until(() => controller?.terminal.unicode.activeVersion === '6', 'Real EOF did not restore the Unicode baseline');
  };
  try {
    const first = await invokeCreateLocalSession(100, 30);
    add(first);
    controller = terminalRegistry.create(first.sessionId,
      (id, event) => useTerminalStore.getState().setStatus(id, event),
      (id, event) => useTerminalStore.getState().setClosed(id, event),
      id => useTerminalStore.getState().sessions.find(value => value.sessionId === id)?.status ?? 'connecting',
      () => {}, first.ptyInfo);
    controller.attach(host);
    unsubscribe = controller.subscribeOutput(chunk => output.push(chunk));
    await connected(first, true);
    const originalSelection = controller.terminal.getSelection;
    const originalOpen = controller.terminal.open;
    const assertPublic = () => {
      assert(controller?.terminal.getSelection === originalSelection && controller.terminal.open === originalOpen, 'Rebind replaced public xterm methods');
    };
    const on = "([string][char]27)+']1337;SetUserVar=ShellSpanNativeInput=MQ=='+([string][char]7)";
    const off = "([string][char]27)+']1337;SetUserVar=ShellSpanNativeInput=MA=='+([string][char]7)";
    // Hold the real foreground program at stdin until the display transition
    // has actually arrived. A fixed sleep can expire before a busy ConPTY read
    // delivers the on marker, coalescing the transition with EOF cleanup.
    await send(`[Console]::WriteLine('OLD_NATIVE_'+'OUTPUT'); [Console]::Write(${on}); [Console]::ReadLine() | Out-Null; [Console]::Write(([string][char]27)+']1337;SetUserVar=ShellSpanNativeInput=MQ'); [Environment]::Exit(0)`);
    await until(() => output.join('').includes('\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07'), 'Actual ordinary output did not deliver the display enter packet');
    await new Promise<void>(resolve => controller!.terminal.write('', resolve));
    assert(controller.terminal.options.reflowCursorLine === false
      && controller.terminal.unicode.activeVersion === '15-graphemes', 'Actual ConPTY enter changed the negotiated measurement or reflow policy');
    assert(await controller.writeUserInput('\r'), 'Actual foreground stdin release was rejected');
    await disconnected(first);
    assert(text().includes('OLD_NATIVE_OUTPUT'), 'Actual EOF lost old output');
    const second = await invokeCreateLocalSession(40, 30, first.sessionId);
    add(second);
    terminalRegistry.rebindSession(first.sessionId, second.sessionId, second.ptyInfo);
    await connected(second, true);
    await send("[Console]::WriteLine('NEW_NATIVE_'+'TEXT')");
    await until(() => text().includes('NEW_NATIVE_TEXT'), 'New native stream was swallowed by old OSC tail');
    assert(text().includes('OLD_NATIVE_OUTPUT'), 'Native/native replacement erased history');
    assertPublic();
    stages.push({ stage: 'native-to-native', text: text() });
    await send("[Console]::WriteLine('UTF8_'+'BEFORE'); $stream=[Console]::OpenStandardOutput(); $stream.Write([byte[]]@(226,130),0,2); $stream.Flush(); [Environment]::Exit(0)");
    await disconnected(second);
    const ordinary = await invokeCreateLocalSession(32, 30, second.sessionId, null);
    add(ordinary);
    assert(ordinary.ptyInfo?.inputMode === 'raw' && !ordinary.ptyInfo.nativeDisplayBinding, 'Explicit non-native transport did not remain raw');
    terminalRegistry.rebindSession(second.sessionId, ordinary.sessionId, ordinary.ptyInfo);
    await connected(ordinary, false);
    await send(`[Console]::Write(${on}); [Console]::WriteLine('RAW_NEW_'+'TEXT'); Start-Sleep -Milliseconds 200; [Console]::Write(${off})`);
    await until(() => text().includes('RAW_NEW_TEXT'), 'Actual raw output disappeared after native/UTF8 EOF');
    assert(controller.inputMode === 'raw' && controller.terminal.options.reflowCursorLine === false, 'Untrusted raw OSC acquired native display behavior');
    const rawSnapshot = (await invokeGetTerminalBrokerSnapshot(ordinary.sessionId)).session;
    assert(rawSnapshot?.inputMode === 'raw' && !rawSnapshot.nativePeerProfile && !rawSnapshot.inputObservation?.activeCommand, 'Raw output fabricated native operation facts');
    assertPublic();
    stages.push({ stage: 'native-to-raw', text: text(), snapshot: rawSnapshot });
    const final = await invokeCreateLocalSession(180, 30, ordinary.sessionId);
    add(final);
    terminalRegistry.rebindSession(ordinary.sessionId, final.sessionId, final.ptyInfo);
    await connected(final, true);
    await send("[Console]::WriteLine('FINAL_NATIVE_'+'TEXT')");
    await until(() => text().split('\n').some(line => line.trim() === 'FINAL_NATIVE_TEXT'), 'Actual raw/native output retained previous connection characters');
    for (const marker of ['OLD_NATIVE_OUTPUT', 'NEW_NATIVE_TEXT', 'UTF8_BEFORE', 'RAW_NEW_TEXT']) assert(text().includes(marker), `Replacement lost history: ${marker}`);
    assertPublic();
    stages.push({ stage: 'raw-to-native', text: text() });
    await fetch(`/__agent-stream-result/${parameters.get('token')}`, { method: 'POST', body: JSON.stringify({
      progress: 'Actual local Windows native/native/raw/native rebind completed without model or Agent commands',
      evidence: { kind: 'actual-windows-registry-lifecycle', selectedHost, connections, stages, output: output.join(''), publicApisUnmodified: true,
        encodingBoundary: 'A real ConPTY program wrote an incomplete UTF8 sequence; ConPTY may normalize it before the backend. This does not claim a raw decoder-tail fault unless independently captured.' },
    }) });
    if (parameters.get('nativeP3Review') === 'true') {
      const response = await fetch(`/__native-p3-review/${parameters.get('token')}`, { method: 'POST' });
      assert(response.ok, 'Actual lifecycle window review was not completed');
    }
  } catch (error) {
    const brokerSnapshots = await Promise.all(sessions.map(async sessionId => {
      try { return { sessionId, session: (await invokeGetTerminalBrokerSnapshot(sessionId)).session }; }
      catch (failure) { return { sessionId, error: failure instanceof Error ? failure.message : String(failure) }; }
    }));
    await fetch(`/__agent-stream-result/${parameters.get('token')}`, { method: 'POST', body: JSON.stringify({
      progress: 'Actual Windows lifecycle failed; diagnostic evidence retained before cleanup',
      evidence: { kind: 'actual-windows-registry-lifecycle-failure', selectedHost, connections, stages, output: output.join(''),
        createdSessions: createdSessions.map(session => ({ sessionId: session.sessionId, ptyInfo: session.ptyInfo })), brokerSnapshots,
        text: controller ? text() : null, displayMode: controller?.terminal.options.reflowCursorLine,
        error: error instanceof Error ? error.message : String(error) },
    }) }).catch(() => {});
    if (parameters.get('nativeP3Review') === 'true') {
      await fetch(`/__native-p3-review/${parameters.get('token')}`, { method: 'POST' }).catch(() => {});
    }
    throw error;
  } finally {
    unsubscribe?.();
    if (controller) terminalRegistry.dispose(controller.sessionId);
    for (const session of sessions) await invokeCloseSession(session).catch(() => {});
    host.remove();
  }
}
