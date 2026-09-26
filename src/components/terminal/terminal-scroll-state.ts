import type { IDisposable, Terminal } from '@xterm/xterm';

interface TerminalScrollSnapshot {
  readonly history: boolean;
  readonly unread: boolean;
}

interface TerminalScrollState {
  getSnapshot: () => TerminalScrollSnapshot;
  subscribe: (listener: () => void) => () => void;
}

const states = new WeakMap<Terminal, TerminalScrollState>();

/** Track output for the lifetime of the terminal, including unmounted panes. */
export function getTerminalScrollState(terminal: Terminal): TerminalScrollState {
  const existing = states.get(terminal);
  if (existing) return existing;

  let snapshot: TerminalScrollSnapshot = { history: false, unread: false };
  const listeners = new Set<() => void>();
  const subscriptions: IDisposable[] = [];
  const state: TerminalScrollState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const update = (output = false) => {
    const buffer = terminal.buffer.active;
    const normal = buffer.type === 'normal';
    const history = normal && buffer.viewportY < buffer.baseY;
    // Alternate-screen applications do not consume unread normal-buffer output.
    const unread = normal ? history && (snapshot.unread || output) : snapshot.unread;
    if (history === snapshot.history && unread === snapshot.unread) return;
    snapshot = { history, unread };
    for (const listener of listeners) listener();
  };

  states.set(terminal, state);
  terminal.loadAddon({
    activate() {
      subscriptions.push(
        terminal.onScroll(() => update()),
        terminal.onWriteParsed(() => update(true)),
        terminal.onResize(() => update()),
        terminal.buffer.onBufferChange(() => update()),
      );
      update();
    },
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
      listeners.clear();
      states.delete(terminal);
    },
  });
  return state;
}
