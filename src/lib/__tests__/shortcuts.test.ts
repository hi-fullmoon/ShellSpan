import { describe, expect, it } from 'vitest';
import {
  eventMatchesShortcut,
  findShortcutConflict,
  getShortcutKeys,
  shortcutFromBareKeyEvent,
  shortcutFromKeyboardEvent,
} from '../shortcuts';
import { DEFAULT_SHORTCUTS } from '@/stores/appStore';

describe('shortcuts', () => {
  it('normalizes Command and Control to a portable modifier', () => {
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))).toBe('mod+2');
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))).toBe('mod+2');
  });

  it('requires a modifier and ignores modifier-only presses', () => {
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'a' }))).toBeNull();
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('matches all modifiers exactly', () => {
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true }), 'mod+shift+k')).toBe(true);
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true }), 'mod+k')).toBe(false);
  });

  it('treats the ctrl token as literal Control, distinct from mod', () => {
    const ctrlB = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true });
    const metaB = new KeyboardEvent('keydown', { key: 'b', metaKey: true });
    expect(eventMatchesShortcut(ctrlB, 'ctrl+b')).toBe(true);
    expect(eventMatchesShortcut(metaB, 'ctrl+b')).toBe(false);
    // mod still folds both modifiers.
    expect(eventMatchesShortcut(ctrlB, 'mod+b')).toBe(true);
    expect(eventMatchesShortcut(metaB, 'mod+b')).toBe(true);
  });

  it('records a literal Control chord when preserveCtrl is set', () => {
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }), true)).toBe('ctrl+b');
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }), true)).toBe('mod+b');
    expect(shortcutFromKeyboardEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))).toBe('mod+b');
  });

  it('renders the ctrl token as a Ctrl label on every platform', () => {
    expect(getShortcutKeys('ctrl+b', 'macos')).toEqual(['Ctrl', 'B']);
    expect(getShortcutKeys('ctrl+b', 'windows')).toEqual(['Ctrl', 'B']);
  });

  it('formats platform-specific key labels', () => {
    expect(getShortcutKeys('mod+shift+k', 'macos')).toEqual(['⌘', '⇧', 'K']);
    expect(getShortcutKeys('mod+shift+k', 'windows')).toEqual(['Ctrl', 'Shift', 'K']);
  });

  it('safely ignores missing persisted bindings', () => {
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }), undefined)).toBe(false);
    expect(getShortcutKeys(undefined, 'macos')).toEqual([]);
  });
});

describe('shortcutFromBareKeyEvent', () => {
  it('captures a single printable key', () => {
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'h' }))).toBe('h');
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'H', shiftKey: true }))).toBe('h');
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: ' ' }))).toBe('space');
  });

  it('rejects modifiers, modifier-only presses, and non-printable keys', () => {
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }))).toBeNull();
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'h', metaKey: true }))).toBeNull();
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true }))).toBeNull();
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBeNull();
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).toBeNull();
    expect(shortcutFromBareKeyEvent(new KeyboardEvent('keydown', { key: 'Enter' }))).toBeNull();
  });
});

describe('findShortcutConflict', () => {
  const bindings = { ...DEFAULT_SHORTCUTS };

  it('flags a chord shared with a global action from any scope', () => {
    expect(findShortcutConflict(bindings, 'newTerminalTab', 'mod+2')).toBe('openTerminal');
    expect(findShortcutConflict(bindings, 'openSftp', 'mod+2')).toBe('openTerminal');
  });

  it('flags a chord shared within the same section scope', () => {
    expect(findShortcutConflict(bindings, 'closeTerminalTab', 'mod+k')).toBe('newTerminalTab');
  });

  it('allows the same chord in different section scopes', () => {
    // newTerminalTab (terminal) and newSftpConnection (sftp) both use mod+k.
    expect(findShortcutConflict(bindings, 'newSftpConnection', 'mod+k')).toBeNull();
    // The terminal leader may reuse a chord bound in the sftp scope.
    expect(findShortcutConflict(bindings, 'newSftpConnection', 'ctrl+b')).toBeNull();
  });

  it('flags the terminal leader against terminal-scoped chords', () => {
    expect(findShortcutConflict(bindings, 'findTerminal', 'ctrl+b')).toBe('terminalLeader');
  });

  it('flags duplicate leader sub-keys but never against chords', () => {
    expect(findShortcutConflict(bindings, 'terminalFocusRight', 'h')).toBe('terminalFocusLeft');
    expect(findShortcutConflict(bindings, 'terminalFocusLeft', 'ctrl+b')).toBeNull();
    expect(findShortcutConflict(bindings, 'terminalFocusLeft', 'mod+1')).toBeNull();
  });

  it('ignores the action being edited itself', () => {
    expect(findShortcutConflict(bindings, 'terminalFocusLeft', 'h')).toBeNull();
    expect(findShortcutConflict(bindings, 'newTerminalTab', 'mod+k')).toBeNull();
  });
});
