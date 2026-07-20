import { describe, expect, it } from 'vitest';
import { eventMatchesShortcut, getShortcutKeys, shortcutFromKeyboardEvent } from '../shortcuts';

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

  it('formats platform-specific key labels', () => {
    expect(getShortcutKeys('mod+shift+k', 'macos')).toEqual(['⌘', '⇧', 'K']);
    expect(getShortcutKeys('mod+shift+k', 'windows')).toEqual(['Ctrl', 'Shift', 'K']);
  });

  it('safely ignores missing persisted bindings', () => {
    expect(eventMatchesShortcut(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }), undefined)).toBe(false);
    expect(getShortcutKeys(undefined, 'macos')).toEqual([]);
  });
});
