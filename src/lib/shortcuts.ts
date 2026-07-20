import type { Platform } from '@/lib/platform';

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift']);

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const key = event.key.toLowerCase() === ' ' ? 'space' : event.key.toLowerCase();
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  if (parts.length === 0 || key === 'escape') return null;
  return [...parts, key].join('+');
}

export function eventMatchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const eventKey = event.key.toLowerCase() === ' ' ? 'space' : event.key.toLowerCase();

  return (
    key === eventKey &&
    parts.includes('mod') === (event.metaKey || event.ctrlKey) &&
    parts.includes('alt') === event.altKey &&
    parts.includes('shift') === event.shiftKey
  );
}

export function getShortcutKeys(shortcut: string, platform: Platform): string[] {
  const labels: Record<string, string> = {
    mod: platform === 'macos' ? '⌘' : 'Ctrl',
    alt: platform === 'macos' ? '⌥' : 'Alt',
    shift: platform === 'macos' ? '⇧' : 'Shift',
    space: 'Space',
    ',': ',',
  };

  return shortcut.split('+').map((part) => labels[part] ?? part.toUpperCase());
}
