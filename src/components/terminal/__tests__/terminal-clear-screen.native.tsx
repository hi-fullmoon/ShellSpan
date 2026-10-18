import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { TerminalPane } from '../terminal-pane';
import { terminalRegistry } from '../registry/terminal-registry';
import { clearTerminalScreen } from '../terminal-content-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { invokeCreateLocalSession, invokeCloseSession } from '@/lib/ipc/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { initI18n, t } from '@/locales';
import '@/styles/base.css';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function progress(message: string) {
  const token = new URL(location.href).searchParams.get('token');
  await fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify({ progress: message }) });
}

function NativeTerminal({ observeIntegration = true }: { observeIntegration?: boolean }) {
  const session = useTerminalStore(state => state.sessions.find(item => item.sessionId === state.activeSessionId) ?? null);
  return <TooltipProvider>{observeIntegration && <TerminalControllerLayer />}<TerminalPane activeSession={session} /><Toaster /></TooltipProvider>;
}

async function verify() {
  await initI18n('zh-CN');
  const host = document.getElementById('root');
  assert(host, 'Missing native test root');
  const root = createRoot(host);
  let id: string | undefined;
  let closed = false;
  try {
    useAppStore.getState().setActiveSection('terminal');
    flushSync(() => root.render(<NativeTerminal />));
    const session = await invokeCreateLocalSession(100, 25);
    id = session.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(session));
    await eventually(() => useTerminalStore.getState().sessions.some(item => item.sessionId === id && item.status === 'connected' && (item.promptReady || item.integrationState === 'unavailable')), 'Real terminal never became ready');
    const controller = terminalRegistry.get(id);
    assert(controller, 'Missing production terminal controller');
    const live = useTerminalStore.getState().sessions.find(item => item.sessionId === id);
    await progress(`Native shell connected: integration=${live?.integrationState}, promptReady=${live?.promptReady}.`);
    const terminal = controller.terminal;
    await eventually(() => Boolean(terminal.element?.querySelector('.xterm-screen')), 'Production terminal never attached to its rendered host');
    let output = '';
    const unsubscribe = controller.subscribeOutput(chunk => { output += chunk; });
    try {
      // Keep commands from this temporary test session out of user history.
      assert(await controller.writeUserInput('unset HISTFILE\r'), 'Real shell rejected test-session history isolation');
      const marker = `clear-native-${crypto.randomUUID()}`;
      // Key input follows xterm -> production controller -> typed IPC -> native
      // user-input admission -> PTY. No substitute onData transport is installed.
      terminal.input(`printf '%s%s\\n' '${marker.slice(0, 12)}' '${marker.slice(12)}'\r`, true);
      await eventually(() => output.includes(marker), 'Production input path did not execute the real PTY command');
      const visible = () => {
        const b = terminal.buffer.active;
        return Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '').join('\n');
      };
      const selectCurrentLine = () => {
        const b = terminal.buffer.active;
        terminal.select(0, b.baseY + b.cursorY, Math.max(1, Math.min(8, b.cursorX)));
        assert(terminal.hasSelection(), 'Selection regression requires a real xterm selection');
        return JSON.stringify({ text: terminal.getSelection(), position: terminal.getSelectionPosition() });
      };
      const selection = () => JSON.stringify({ text: terminal.getSelection(), position: terminal.getSelectionPosition() });
      if (live?.integrationState !== 'ready') {
        assert(live?.integrationReason === 'unsupportedShell', 'Unsupported-shell regression requires a genuinely unsupported native shell');
        terminal.input("PS1='clear-prompt-first\nclear-prompt-last$ '\r", true);
        await eventually(() => visible().split('\n').some(line => line.trimEnd() === 'clear-prompt-last$'), 'Unsupported shell did not display its real multiline prompt');
        terminal.input("echo 'first-unsubmitted\nsecond-unsubmitted", true);
        await eventually(() => visible().includes('second-unsubmitted'), 'Unsupported shell did not echo multiline input');
        const snapshot = () => {
          const b = terminal.buffer.active;
          return JSON.stringify({ x: b.cursorX, y: b.cursorY, base: b.baseY, viewport: b.viewportY,
            lines: Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(false)) });
        };
        const before = snapshot();
        const unsupportedSelection = selectCurrentLine();
        assert(await clearTerminalScreen(terminal, id) === 'unavailable', 'Unsupported shell must explicitly reject unsafe clearing');
        assert(selection() === unsupportedSelection, 'Unsupported clearing removed or changed the selection');
        assert(snapshot() === before, 'Without a trustworthy editing boundary, clearing must preserve the full multiline prompt and input');
        const screen = terminal.element?.querySelector('.xterm-screen');
        assert(screen, 'Missing rendered terminal screen');
        screen.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 100, button: 2 }));
        await eventually(() => Boolean(document.querySelector('[role="menu"]')), 'Production terminal menu did not open');
        const clearItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent === t('terminal.menu.clearScreen'));
        assert(clearItem, 'Missing production clear-screen menu action');
        clearItem.click();
        await eventually(() => Array.from(document.querySelectorAll('[data-sonner-toast]')).some(item => item.textContent?.includes(t('terminal.menu.clearUnavailable'))), 'Unsupported clear-screen action did not render its explanatory Toast');
        assert(snapshot() === before, 'Production menu changed unsupported-shell input');
        assert(selection() === unsupportedSelection, 'Rejected production menu action removed the selection');
        terminal.input("'\r", true);
        await eventually(() => visible().split('\n').some(line => line === 'second-unsubmitted'), 'Preserving the display changed the submitted multiline command');
        terminal.input(`printf '\\033[2J\\033[10;1H'; printf '%0*d' ${terminal.cols} 0; sleep 2; printf Z; sleep 1\r`, true);
        await eventually(() => terminal.buffer.active.cursorX === terminal.cols, 'Real foreground output never reached the pending-wrap boundary');
        const margin = snapshot();
        await clearTerminalScreen(terminal, id);
        assert(snapshot() === margin, 'Clearing changed the real foreground program or its pending-wrap state');
        await eventually(() => terminal.buffer.active.getLine(terminal.buffer.active.baseY + 10)?.translateToString(true) === 'Z', 'Output after clearing overwrote the last column instead of wrapping');
        terminal.input("printf '\\033[?1049hALTERNATE-NATIVE'; sleep 1; printf '\\033[?1049l'\r", true);
        await eventually(() => terminal.buffer.active.type === 'alternate' && visible().includes('ALTERNATE-NATIVE'), 'Real foreground program did not enter the alternate screen');
        const alternate = snapshot();
        const alternateSelection = selectCurrentLine();
        assert(await clearTerminalScreen(terminal, id) === 'blocked', 'Alternate-screen clearing must be blocked');
        assert(selection() === alternateSelection, 'Blocked alternate-screen clearing removed the selection');
        assert(snapshot() === alternate, 'Clearing modified the real alternate-screen program');
        await eventually(() => terminal.buffer.active.type === 'normal', 'Real alternate-screen program did not restore its display');
        await progress('Unsupported native shell preserved multiline input, pending wrap and foreground output.');
        return;
      }
      await eventually(() => Boolean(useTerminalStore.getState().sessions.find(item => item.sessionId === id)?.promptReady), 'Shell did not return to its real prompt');
      if (session.title === 'zsh') {
        // Keep the user's actual Zsh prompt/theme and production ZLE hooks.
        // Themes can recompute PS1 in precmd, so do not substitute shell state.
        terminal.input("echo 'retained-zsh-input'", true);
        await eventually(() => visible().includes('retained-zsh-input'), 'Real Zsh did not echo editing input');
        const endX = terminal.buffer.active.cursorX;
        terminal.input('\u001b[D\u001b[D', true);
        await eventually(() => terminal.buffer.active.cursorX === endX - 2, 'Real Zsh did not move the editing cursor');
        selectCurrentLine();
        assert(await clearTerminalScreen(terminal, id) === 'requested', 'Production Zsh redraw was rejected');
        assert(!terminal.hasSelection(), 'Successful Zsh clearing retained the selection');
        await eventually(() => !visible().includes(marker) && visible().includes('retained-zsh-input'), 'Real Zsh redraw lost editing input or retained previous output');
        assert(terminal.buffer.active.cursorX === endX - 2, 'Zsh redraw moved the editing cursor within the command');
        terminal.input('X\r', true);
        await eventually(() => visible().split('\n').includes('retained-zsh-inpuXt'), 'Real Zsh executed different input after clearing');
        await progress('Native Zsh prompt redraw, cursor editing and real command execution passed.');
        return;
      }
      terminal.input("PS1=$'clear-prompt-first\\nclear-prompt-last$ '; PS2='native-cont> '\r", true);
      await eventually(() => visible().split('\n').some(line => line.trimEnd() === 'clear-prompt-last$'), 'Real shell did not display the two-line prompt');
      terminal.input("printf 'clear-history-%s\\n' {1..80}\r", true);
      await eventually(() => visible().includes('clear-history-80') && visible().split('\n').some(line => line.trimEnd() === 'clear-prompt-last$'), 'Real shell did not produce scrollback');
      terminal.input("echo 'retained-native-input'", true);
      await eventually(() => visible().includes('retained-native-input'), 'PTY did not echo unsubmitted input');
      const endX = terminal.buffer.active.cursorX;
      terminal.input('\u001b[D\u001b[D', true);
      await eventually(() => terminal.buffer.active.cursorX === endX - 2, 'Real shell did not move the editing cursor');
      const history = () => {
        const b = terminal.buffer.active;
        return Array.from({ length: b.baseY }, (_, i) => b.getLine(i)?.translateToString(false));
      };
      const beforeHistory = JSON.stringify(history());
      assert(terminal.buffer.active.baseY > 0, 'Native clear-screen test requires real scrollback');
      terminal.scrollToTop();
      assert(terminal.buffer.active.viewportY < terminal.buffer.active.baseY, 'History-view regression requires a scrolled viewport');
      const beforeBlocked = visible();
      const blockedSelection = selectCurrentLine();
      const releaseInput = controller.suppressUserInput();
      try {
        assert(await clearTerminalScreen(terminal, id) === 'blocked', 'Clearing bypassed production input suppression');
        assert(visible() === beforeBlocked, 'Rejected clear-screen input changed the display');
        assert(selection() === blockedSelection, 'Production input rejection removed or changed the selection');
        assert(terminal.buffer.active.viewportY === 0, 'Rejected clear-screen input moved the history viewport');
      } finally { releaseInput(); }
      assert(await clearTerminalScreen(terminal, id) === 'requested', 'Production controller rejected shell redraw');
      assert(!terminal.hasSelection(), 'Successful clearing retained the selection');
      assert(terminal.buffer.active.viewportY === terminal.buffer.active.baseY, 'Successful clearing did not return from history to the live prompt');
      try {
        await eventually(() => !visible().includes(marker) && visible().includes('retained-native-input'), 'Clearing lost the prompt or unsubmitted input');
        assert(visible().includes('clear-prompt-first') && visible().includes('clear-prompt-last$'), 'Clearing truncated the real multiline prompt');
        assert(terminal.buffer.active.cursorX === endX - 2, 'Clearing moved the editing cursor within the command');
        assert(JSON.stringify(history()) === beforeHistory, 'Clearing the screen modified scrollback');
      } catch (error) {
        const live = useTerminalStore.getState().sessions.find(item => item.sessionId === id);
        throw new Error(`${String(error)}; rows=${terminal.rows}; cursor=${terminal.buffer.active.cursorX},${terminal.buffer.active.cursorY}; integration=${live?.integrationState}; promptReady=${live?.promptReady}; screen=${visible()}`);
      }
      terminal.input('X\r', true);
      await eventually(() => {
        const b = terminal.buffer.active;
        return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true)).includes('retained-native-inpuXt');
      }, 'Clearing changed the command executed by the real shell');
      await eventually(() => visible().split('\n').some(line => line.trimEnd() === 'clear-prompt-last$'), 'Shell did not return to its prompt');
      const longInput = `echo '${'wrapped-input-'.repeat(Math.ceil(terminal.cols / 4))}'`;
      terminal.input(longInput, true);
      await eventually(() => visible().replace(/\n/g, '').includes(longInput), 'Real shell did not echo the wrapped editing buffer');
      assert(await clearTerminalScreen(terminal, id) === 'requested', 'Automatic wrapping was incorrectly treated as submitted multiline input');
      await eventually(() => visible().replace(/\n/g, '').includes(longInput), 'Clearing truncated a wrapped command');
      terminal.input('\u0015', true);
      await eventually(() => !controller.hasPendingUserInput(), 'Clearing the current editing line did not update input tracking');
      terminal.input("echo 'first-multiline\nsecond-multiline", true);
      await eventually(() => visible().includes('second-multiline'), 'Real shell did not enter continuation editing');
      const continuation = visible();
      assert(await clearTerminalScreen(terminal, id) === 'unavailable', 'Unsubmitted continuation lines must not be erased by shell redraw');
      assert(visible() === continuation, 'Clearing changed the complete unsubmitted multiline command');
      terminal.input('\u0015', true);
      await eventually(() => !visible().includes('second-multiline'), 'Real shell did not clear the current continuation line');
      assert(controller.hasUnconfirmedLineBreak(), 'Ctrl+U incorrectly forgot accepted continuation lines');
      const afterKill = visible();
      assert(await clearTerminalScreen(terminal, id) === 'unavailable', 'Ctrl+U must not make a continuation command safe to erase');
      assert(visible() === afterKill, 'Clearing after Ctrl+U changed continuation input');
      terminal.input("'\r", true);
      await eventually(() => visible().split('\n').includes('first-multiline'), 'Clearing changed the multiline command executed by the real shell');
      await eventually(() => visible().split('\n').some(line => line.trimEnd() === 'clear-prompt-last$') && !controller.hasUnconfirmedLineBreak(), 'A completed command did not receive a fresh native prompt confirmation');
      terminal.input('if true;\n', true);
      await eventually(() => terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY)?.translateToString(true).trimEnd() === 'native-cont>', 'Real shell did not enter control-flow continuation');
      assert(controller.hasUnconfirmedLineBreak(), 'Control-flow continuation was not tracked');
      const controlFlow = visible();
      assert(await clearTerminalScreen(terminal, id) === 'unavailable', 'Shell syntax must not be guessed from terminal cells or the local input parser');
      assert(visible() === controlFlow, 'Clearing erased an unfinished control-flow command');
      terminal.input('then echo control-flow-native; fi\r', true);
      await eventually(() => visible().split('\n').includes('control-flow-native'), 'The real control-flow command changed after clearing');
      await eventually(() => !controller.hasUnconfirmedLineBreak(), 'Write-failure regression requires a confirmed idle prompt');
      // Suspend native event observation to exercise the real close/write race:
      // the UI retains its last connected snapshot while the backend is gone.
      // The production input writer and native IPC remain unchanged.
      flushSync(() => root.render(<NativeTerminal observeIntegration={false} />));
      for (const type of ['data', 'status', 'closed'] as const) {
        controller.unlisten[type]?.();
        controller.unlisten[type] = undefined;
      }
      await invokeCloseSession(id);
      closed = true;
      const failedSelection = selectCurrentLine();
      let writeFailure: unknown;
      try { await clearTerminalScreen(terminal, id); }
      catch (error) { writeFailure = error; }
      assert(writeFailure === 'TERMINAL_BROKER_STALE_TRANSPORT' || writeFailure === 'TERMINAL_BROKER_TRANSPORT_NOT_FOUND',
        `Closed native backend did not produce the expected real IPC write failure: ${String(writeFailure)}`);
      assert(selection() === failedSelection, 'Failed native IPC clearing removed or changed the selection');
      await progress('Native input, multiline prompt, cursor editing, wrapped input and independent scrollback passed.');
    } finally { unsubscribe(); }
  } finally {
    if (id) {
      try { if (!closed) await invokeCloseSession(id); }
      finally { terminalRegistry.dispose(id); useTerminalStore.getState().removeSession(id); }
    }
    root.unmount();
  }
}
const token = new URL(location.href).searchParams.get('token');
void verify().then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
  error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
})).then(result => fetch(`/__agent-stream-result/${token}`, { method: 'POST', body: JSON.stringify(result) }));
