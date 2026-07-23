import type { Platform } from '@/lib/platform';
import type { ShortcutAction, ShortcutBindings } from '@/types';

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift']);

export type ShortcutScope = 'global' | 'terminal' | 'sftp';

export const SHORTCUT_SCOPES: Record<ShortcutAction, ShortcutScope> = {
  openWorkbench: 'global',
  openTerminal: 'global',
  openSftp: 'global',
  openSettings: 'global',
  newTerminalTab: 'terminal',
  closeTerminalTab: 'terminal',
  nextTerminalTab: 'terminal',
  previousTerminalTab: 'terminal',
  findTerminal: 'terminal',
  newSftpConnection: 'sftp',
  terminalLeader: 'terminal',
  terminalFocusLeft: 'terminal',
  terminalFocusDown: 'terminal',
  terminalFocusUp: 'terminal',
  terminalFocusRight: 'terminal',
  terminalSplitRight: 'terminal',
  terminalSplitDown: 'terminal',
  terminalClosePane: 'terminal',
};

// Actions resolved as the key after the leader prefix (e.g. Ctrl+B then H).
// Their bindings are bare keys living in the leader namespace, not chords.
export const LEADER_SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'terminalFocusLeft',
  'terminalFocusDown',
  'terminalFocusUp',
  'terminalFocusRight',
  'terminalSplitRight',
  'terminalSplitDown',
  'terminalClosePane',
];

export function isLeaderShortcutAction(action: ShortcutAction): boolean {
  return LEADER_SHORTCUT_ACTIONS.includes(action);
}

export function findShortcutConflict(
  bindings: ShortcutBindings,
  action: ShortcutAction,
  candidate: string,
): ShortcutAction | null {
  const candidateIsLeaderKey = isLeaderShortcutAction(action);
  for (const other of Object.keys(bindings) as ShortcutAction[]) {
    if (other === action || bindings[other] !== candidate) continue;
    const otherIsLeaderKey = isLeaderShortcutAction(other);
    // Leader sub-keys share one namespace; a chord never collides with them.
    if (candidateIsLeaderKey || otherIsLeaderKey) {
      if (candidateIsLeaderKey && otherIsLeaderKey) return other;
      continue;
    }
    // Chords collide only within the same scope, or against a global one.
    if (
      SHORTCUT_SCOPES[action] === 'global'
      || SHORTCUT_SCOPES[other] === 'global'
      || SHORTCUT_SCOPES[action] === SHORTCUT_SCOPES[other]
    ) {
      return other;
    }
  }
  return null;
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent, preserveCtrl = false): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const key = event.key.toLowerCase() === ' ' ? 'space' : event.key.toLowerCase();
  const parts: string[] = [];
  // 'mod' folds Cmd (macOS) and Ctrl (elsewhere) into one portable token.
  // Callers that need a literal Control binding (e.g. the terminal leader,
  // which must stay off the Cmd namespace) pass preserveCtrl.
  if (event.metaKey || event.ctrlKey) {
    parts.push(preserveCtrl && !event.metaKey ? 'ctrl' : 'mod');
  }
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  if (parts.length === 0 || key === 'escape') return null;
  return [...parts, key].join('+');
}

// Captures a leader sub-key binding: a single printable key without
// ctrl/alt/meta (shift folds into the key itself, e.g. Shift+H records "h").
export function shortcutFromBareKeyEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key.length !== 1) return null;
  return event.key === ' ' ? 'space' : event.key.toLowerCase();
}

export function eventMatchesShortcut(event: KeyboardEvent, shortcut?: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const eventKey = event.key.toLowerCase() === ' ' ? 'space' : event.key.toLowerCase();

  // 'ctrl' requires literally Control (no Cmd); 'mod' accepts either.
  const modifierMatch = parts.includes('ctrl')
    ? event.ctrlKey && !event.metaKey
    : parts.includes('mod')
      ? event.metaKey || event.ctrlKey
      : !event.metaKey && !event.ctrlKey;

  return (
    key === eventKey &&
    modifierMatch &&
    parts.includes('alt') === event.altKey &&
    parts.includes('shift') === event.shiftKey
  );
}

export function getShortcutKeys(shortcut: string | undefined, platform: Platform): string[] {
  if (!shortcut) return [];
  const labels: Record<string, string> = {
    mod: platform === 'macos' ? '⌘' : 'Ctrl',
    ctrl: 'Ctrl',
    alt: platform === 'macos' ? '⌥' : 'Alt',
    shift: platform === 'macos' ? '⇧' : 'Shift',
    space: 'Space',
    ',': ',',
  };

  return shortcut.split('+').map((part) => labels[part] ?? part.toUpperCase());
}
