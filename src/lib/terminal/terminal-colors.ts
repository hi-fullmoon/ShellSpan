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

export const TERMINAL_MINIMUM_CONTRAST_RATIOS = [1, 4.5, 7] as const;
export type TerminalMinimumContrastRatio = typeof TERMINAL_MINIMUM_CONTRAST_RATIOS[number];
export const DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO: TerminalMinimumContrastRatio = 4.5;

export function normalizeTerminalMinimumContrastRatio(value: unknown): TerminalMinimumContrastRatio {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const match = TERMINAL_MINIMUM_CONTRAST_RATIOS.find((ratio) => ratio === value);
    if (match !== undefined) return match;
  }
  return DEFAULT_TERMINAL_MINIMUM_CONTRAST_RATIO;
}

// Match xterm 6's default ANSI palette when a preset omits these entries.
export const DEFAULT_TERMINAL_ANSI_COLORS: Record<typeof TERMINAL_ANSI_COLOR_KEYS[number], string> = {
  black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
  blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
  brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f',
  brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
};

// Complete 16-color ANSI palette tuned for light backgrounds so shells such as
// PowerShell (PSReadLine brightYellow, PSStyle brightGreen/brightCyan) stay legible.
export const LIGHT_TERMINAL_ANSI_COLORS: Record<typeof TERMINAL_ANSI_COLOR_KEYS[number], string> = {
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#f6f8fa',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700',
  brightBlue: '#1f6feb', brightMagenta: '#8957e5', brightCyan: '#0e7490', brightWhite: '#ffffff',
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

function searchBackground(color: string | undefined, background: string | undefined): string | undefined {
  if (color?.length !== 9) return color;
  // Search decorations only render opaque RGB. Composite with the terminal's
  // background through the platform color renderer before passing them to xterm.
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  context.fillStyle = background ?? '#000000';
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function terminalSearchDecorations(theme: ITheme | undefined, overrides: TerminalColorOverrides) {
  const color = theme?.blue ?? '#808080';
  return {
    matchBorder: color,
    activeMatchBorder: theme?.foreground ?? color,
    matchOverviewRuler: color,
    activeMatchColorOverviewRuler: color,
    matchBackground: searchBackground(overrides.searchMatchBackground, theme?.background),
    activeMatchBackground: searchBackground(overrides.searchActiveMatchBackground, theme?.background),
  };
}
