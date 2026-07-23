import { eventMatchesShortcut, isLeaderShortcutAction } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutAction, ShortcutBindings } from '@/types';
import type { TerminalSplitDirection } from './terminal-split';

// Vim/tmux-style leader key state machine for the terminal input layer.
// Pressing the leader (default Ctrl+B) arms the next keypress: a bound
// sub-key runs its command, any other key is swallowed (tmux semantics).
// The machine disarms after a timeout so a stray leader press does not
// eat future input.

const LEADER_TIMEOUT_MS = 1000;

const FOCUS_DIRECTIONS: Partial<Record<ShortcutAction, TerminalSplitDirection>> = {
  terminalFocusLeft: 'left',
  terminalFocusDown: 'bottom',
  terminalFocusUp: 'top',
  terminalFocusRight: 'right',
};

const SPLIT_DIRECTIONS: Partial<Record<ShortcutAction, TerminalSplitDirection>> = {
  terminalSplitRight: 'right',
  terminalSplitDown: 'bottom',
};

let armed = false;
let disarmTimer: number | null = null;

function disarm(): void {
  armed = false;
  if (disarmTimer !== null) {
    window.clearTimeout(disarmTimer);
    disarmTimer = null;
  }
}

function arm(): void {
  disarm();
  armed = true;
  disarmTimer = window.setTimeout(() => {
    disarmTimer = null;
    armed = false;
  }, LEADER_TIMEOUT_MS);
}

export function resetTerminalLeader(): void {
  disarm();
}

function effectiveShortcuts(): ShortcutBindings {
  return { ...DEFAULT_SHORTCUTS, ...useAppStore.getState().shortcuts };
}

function dispatchLeaderCommand(action: ShortcutAction): void {
  const focusDirection = FOCUS_DIRECTIONS[action];
  if (focusDirection) {
    document.dispatchEvent(new CustomEvent('termbridge:navigate-terminal-pane', {
      detail: { direction: focusDirection },
    }));
    return;
  }
  const splitDirection = SPLIT_DIRECTIONS[action];
  if (splitDirection) {
    document.dispatchEvent(new CustomEvent('termbridge:split-terminal-pane', {
      detail: { direction: splitDirection },
    }));
    return;
  }
  if (action === 'terminalClosePane') {
    document.dispatchEvent(new Event('termbridge:close-terminal-tab'));
  }
}

// Returns true when the keypress is consumed by the leader machine and
// must not reach the pty.
export function handleTerminalLeaderKeydown(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  if (event.repeat) return armed;

  const shortcuts = effectiveShortcuts();

  if (armed) {
    disarm();
    // Modifier combos belong to app shortcuts, not the leader namespace.
    if (event.altKey || event.metaKey) return false;
    const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
    const action = (Object.keys(shortcuts) as ShortcutAction[]).find(
      (candidate) => isLeaderShortcutAction(candidate) && shortcuts[candidate] === key,
    );
    // Unknown command keys are swallowed (tmux-style) so an intended
    // command never leaks into the shell as typed input.
    if (!action) return true;
    dispatchLeaderCommand(action);
    return true;
  }

  if (eventMatchesShortcut(event, shortcuts.terminalLeader)) {
    arm();
    return true;
  }
  return false;
}
