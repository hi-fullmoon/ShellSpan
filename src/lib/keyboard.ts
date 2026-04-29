export type ShortcutAction =
  | 'closeDialog'
  | 'newConnection'
  | 'openSettings'
  | 'closeSession'
  | 'nextTab'
  | 'prevTab'
  | 'togglePrimarySidebar'
  | 'toggleSecondarySidebar';

export interface ParsedBinding {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'closeDialog',
  'newConnection',
  'openSettings',
  'closeSession',
  'nextTab',
  'prevTab',
  'togglePrimarySidebar',
  'toggleSecondarySidebar',
];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  closeDialog: 'Escape',
  newConnection: 'CmdOrCtrl+N',
  openSettings: 'CmdOrCtrl+,',
  closeSession: 'CmdOrCtrl+W',
  nextTab: 'CmdOrCtrl+Tab',
  prevTab: 'CmdOrCtrl+Shift+Tab',
  togglePrimarySidebar: 'CmdOrCtrl+Shift+E',
  toggleSecondarySidebar: 'CmdOrCtrl+Shift+S',
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  closeDialog: 'shortcuts.action.closeDialog',
  newConnection: 'shortcuts.action.newConnection',
  openSettings: 'shortcuts.action.openSettings',
  closeSession: 'shortcuts.action.closeSession',
  nextTab: 'shortcuts.action.nextTab',
  prevTab: 'shortcuts.action.prevTab',
  togglePrimarySidebar: 'shortcuts.action.togglePrimarySidebar',
  toggleSecondarySidebar: 'shortcuts.action.toggleSecondarySidebar',
};

function isMac(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
}

function resolveCmdOrCtrl(binding: string): string {
  return binding.replace(/CmdOrCtrl/g, isMac() ? 'Meta' : 'Control');
}

export function parseKeyBinding(str: string): ParsedBinding {
  const resolved = resolveCmdOrCtrl(str);
  const parts = resolved.split('+');
  const key = parts.pop() ?? '';
  return {
    key,
    ctrl: parts.includes('Control'),
    meta: parts.includes('Meta'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
  };
}

export function matchesBinding(str: string, event: KeyboardEvent): boolean {
  const binding = parseKeyBinding(str);
  if (event.key !== binding.key && event.code !== binding.key) {
    return false;
  }
  if (event.ctrlKey !== binding.ctrl) return false;
  if (event.metaKey !== binding.meta) return false;
  if (event.altKey !== binding.alt) return false;
  if (event.shiftKey !== binding.shift) return false;
  return true;
}

const MODIFIER_SYMBOLS: Record<string, string> = {
  Meta: '\u2318',
  Control: '\u2303',
  Alt: '\u2325',
  Shift: '\u21E7',
};

const MODIFIER_NAMES: Record<string, string> = {
  Meta: 'Cmd',
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
};

export function formatKeyBinding(str: string): string {
  const resolved = resolveCmdOrCtrl(str);
  const parts = resolved.split('+');
  const key = parts.pop() ?? '';
  const symbols = isMac();
  const keyDisplay = key === 'Escape' ? 'Esc' : key === ',' ? ',' : key;
  if (symbols) {
    const mods = parts.map((m) => MODIFIER_SYMBOLS[m] ?? m).join('');
    return `${mods}${keyDisplay}`;
  }
  const mods = parts.map((m) => MODIFIER_NAMES[m] ?? m).join('+');
  return `${mods}+${keyDisplay}`;
}

export function recordKeyBinding(event: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const key = event.key;

  // Ignore standalone modifier presses
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') {
    return null;
  }

  parts.push(key);
  return parts.join('+');
}
