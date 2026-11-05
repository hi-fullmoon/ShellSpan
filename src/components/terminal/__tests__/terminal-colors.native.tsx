import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { invokeCloseSession, invokeCreateLocalSession, invokeLoadPreferences } from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { TerminalPane } from '../terminal-pane';
import { TerminalColorSchemeControl } from '../terminal-color-settings';
import { terminalRegistry } from '../registry/terminal-registry';
import type { TerminalColorOverrides } from '@/lib/terminal/terminal-colors';
import '@/styles/base.css';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

const colors: TerminalColorOverrides = {
  background: '#102030', foreground: '#e0e0e0', cursor: '#aabbcc', cursorAccent: '#112233',
  selectionBackground: '#33445580', selectionForeground: '#ffeedd', selectionInactiveBackground: '#44556680',
  red: '#aabbcc', brightBlue: '#1122ff', searchMatchBackground: '#557799', searchActiveMatchBackground: '#7799bb',
};
const phase = new URLSearchParams(location.search).get('phase');

function NativeSurface() {
  const activeSession = useTerminalStore(state => state.sessions[0]);
  return <div className="flex h-screen flex-col gap-3 p-4">
    <TerminalControllerLayer />
    <TerminalColorSchemeControl />
    <div className="relative flex min-h-0 flex-1 flex-col"><TerminalPane activeSession={activeSession} /></div>
  </div>;
}

async function verify() {
  await useAppStore.getState().hydrateFromDb();
  await initI18n('en-US');
  useAppStore.setState({ locale: 'en-US' });
  if (phase === 'reopen' || phase === 'reset-reopen') {
    const expected = phase === 'reopen' ? colors : {};
    check(JSON.stringify(useAppStore.getState().terminalColorOverrides) === JSON.stringify(expected), `${phase}: colors did not survive application restart`);
    check(useAppStore.getState().terminalColorScheme === 'nord', `${phase}: preset was not preserved`);
    if (phase === 'reset-reopen') return;
  }
  const root = createRoot(document.getElementById('root')!);
  let sessionId: string | undefined;
  try {
    flushSync(() => root.render(<NativeSurface />));
    const summary = await invokeCreateLocalSession(80, 24, undefined, null);
    sessionId = summary.sessionId;
    flushSync(() => useTerminalStore.getState().addSession(summary));
    await eventually(() => Boolean(terminalRegistry.get(summary.sessionId)?.terminal.element), 'Real local terminal did not mount');
    const controller = terminalRegistry.get(summary.sessionId)!;
    const terminal = controller.terminal;
    const current = () => terminal.options.theme;
    if (phase === 'write') {
      flushSync(() => {
        useAppStore.getState().setTerminalColorScheme('nord');
        useAppStore.getState().setTerminalColorOverrides(colors);
      });
      await eventually(() => current()?.background === colors.background && current()?.red === colors.red, 'Open terminal did not apply live colors');
      check(terminalRegistry.get(summary.sessionId)?.terminal === terminal, 'Color edits replaced the open terminal');
      check(terminal.element?.style.backgroundColor === 'rgb(16, 32, 48)', 'Open terminal background was not rendered');
      check(current()?.selectionForeground === colors.selectionForeground && current()?.brightBlue === colors.brightBlue, 'ANSI or selection color was lost');
      flushSync(() => useAppStore.getState().setTerminalColorScheme('app'));
      document.documentElement.dataset.theme = 'dark';
      await eventually(() => current()?.background === colors.background && current()?.red === colors.red, 'App theme refresh lost custom colors');
      flushSync(() => useAppStore.getState().setTerminalColorScheme('nord'));
    } else {
      await eventually(() => current()?.background === colors.background, 'New terminal did not use persisted colors');
      const customize = [...document.querySelectorAll('button')].find(button => button.textContent === 'Customize');
      check(customize, 'Missing Customize entry');
      customize.click();
      await eventually(() => Boolean(document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')), 'Color editor did not open');
      const reset = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Restore defaults');
      check(reset, 'Missing restore defaults action');
      reset.click();
      await eventually(() => current()?.background === '#2e3440' && current()?.red === '#bf616a', 'Restore defaults did not update the open terminal');
      check(terminalRegistry.get(summary.sessionId)?.terminal === terminal, 'Reset replaced the open terminal');
    }
    const expected = phase === 'write' ? colors : {};
    await eventually(async () => {
      const entries = await invokeLoadPreferences();
      const saved = entries.find(([key]) => key === 'terminalColorOverrides');
      return Boolean(saved && JSON.stringify(JSON.parse(saved[1])) === JSON.stringify(expected));
    }, 'Automatic save did not reach the real SQLite database');
  } finally {
    if (sessionId) await invokeCloseSession(sessionId);
    root.unmount();
    terminalRegistry.disposeAll();
  }
}

void verify().then(async () => {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: true, phase }) });
  await invoke('request_app_exit');
}).catch(async (error: unknown) => {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: false, phase, error: String(error) }) });
  await invoke('request_app_exit');
});
