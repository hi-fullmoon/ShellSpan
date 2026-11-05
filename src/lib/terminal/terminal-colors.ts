import type { ITheme } from '@xterm/xterm';

export const TERMINAL_ANSI_COLOR_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
export const TERMINAL_BASIC_COLOR_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground', 'selectionInactiveBackground',
] as const;
export const TERMINAL_SEARCH_COLOR_KEYS = ['searchMatchBackground', 'searchActiveMatchBackground'] as const;
export const TERMINAL_COLOR_KEYS = [...TERMINAL_BASIC_COLOR_KEYS, ...TERMINAL_ANSI_COLOR_KEYS, ...TERMINAL_SEARCH_COLOR_KEYS] as const;
export type TerminalColorKey = typeof TERMINAL_COLOR_KEYS[number];
export type TerminalColorOverrides = Partial<Record<TerminalColorKey, string>>;

// Match xterm 6's default ANSI palette when a preset omits these entries.
export const DEFAULT_TERMINAL_ANSI_COLORS: Record<typeof TERMINAL_ANSI_COLOR_KEYS[number], string> = {
  black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
  blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
  brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
  brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
};

export function isTerminalColor(value: string): boolean {
  return /^#[\da-f]{6}([\da-f]{2})?$/i.test(value);
}

export function normalizeTerminalColorOverrides(value: unknown): TerminalColorOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: TerminalColorOverrides = {};
  for (const key of TERMINAL_COLOR_KEYS) {
    const color: unknown = Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof color === 'string' && isTerminalColor(color)) result[key] = color.toLowerCase();
  }
  return result;
}

export function applyTerminalColorOverrides(theme: ITheme, overrides: TerminalColorOverrides): ITheme {
  const colors: ITheme = {};
  const normalized = normalizeTerminalColorOverrides(overrides);
  for (const key of [...TERMINAL_BASIC_COLOR_KEYS, ...TERMINAL_ANSI_COLOR_KEYS]) {
    if (normalized[key]) colors[key] = normalized[key];
  }
  return { ...theme, ...colors };
}

export function terminalSearchDecorations(theme: ITheme | undefined, overrides: TerminalColorOverrides) {
  const color = theme?.blue ?? '#808080';
  return {
    matchBorder: color,
    activeMatchBorder: theme?.foreground ?? color,
    matchOverviewRuler: color,
    activeMatchColorOverviewRuler: color,
    matchBackground: overrides.searchMatchBackground,
    activeMatchBackground: overrides.searchActiveMatchBackground,
  };
}
