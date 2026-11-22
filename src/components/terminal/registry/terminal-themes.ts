import type { Terminal } from '@xterm/xterm';
import type { TerminalColorScheme } from '@/types';
import { applyTerminalColorOverrides, type TerminalColorOverrides } from '@/lib/terminal/terminal-colors';

export type TerminalTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'];

const BELL_COOLDOWN_MS = 100;
let sharedBellContext: AudioContext | null = null;
let lastBellPlayedAt = 0;

export function playBellSound(): void {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;
  const now = performance.now();
  if (now - lastBellPlayedAt < BELL_COOLDOWN_MS) return;
  lastBellPlayedAt = now;
  if (!sharedBellContext || sharedBellContext.state === 'closed') {
    sharedBellContext = new AudioContextConstructor();
  }
  const context = sharedBellContext;
  if (context.state === 'suspended') {
    void context.resume().catch(() => {});
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.05, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.08);
}

const LIGHT_SELECTION_BACKGROUND = 'rgba(24, 24, 24, 0.22)';
const LIGHT_SELECTION_INACTIVE_BACKGROUND = 'rgba(24, 24, 24, 0.12)';

const TERMINAL_COLOR_THEMES: Record<Exclude<TerminalColorScheme, 'app'>, TerminalTheme> = {
  oneDark: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
  },
  solarizedDark: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
  },
  dracula: {
    background: '#282a36',
    foreground: '#e5e5df',
    cursor: '#e5e5df',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  gruvboxDark: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  tokyoNight: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    selectionBackground: '#33467c',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: LIGHT_SELECTION_BACKGROUND,
    selectionInactiveBackground: LIGHT_SELECTION_INACTIVE_BACKGROUND,
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#f6f8fa',
  },
};

function readAppColor(variable: string, lightFallback: string, darkFallback: string): string {
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (resolved) return resolved;
  return document.documentElement.dataset.theme === 'dark' ? darkFallback : lightFallback;
}

function resolveBaseTerminalTheme(colorScheme: TerminalColorScheme): TerminalTheme {
  if (colorScheme !== 'app') return { ...TERMINAL_COLOR_THEMES[colorScheme], overviewRulerBorder: '#00000000' };
  return {
    // Keep search markers without xterm's default full-height ruler border.
    overviewRulerBorder: '#00000000',
    background: readAppColor('--app-surface', '#ffffff', '#202122'),
    foreground: readAppColor('--app-text', '#181818', '#d4d4d8'),
    cursor: readAppColor('--app-primary', '#282828', '#b3b3b8'),
    selectionBackground: readAppColor(
      '--app-terminal-selection',
      LIGHT_SELECTION_BACKGROUND,
      'rgba(244, 244, 245, 0.22)',
    ),
    selectionInactiveBackground: readAppColor(
      '--app-terminal-selection-inactive',
      LIGHT_SELECTION_INACTIVE_BACKGROUND,
      'rgba(244, 244, 245, 0.12)',
    ),
  };
}

export function resolveTerminalTheme(colorScheme: TerminalColorScheme, overrides: TerminalColorOverrides = {}): TerminalTheme {
  return applyTerminalColorOverrides(resolveBaseTerminalTheme(colorScheme) ?? {}, overrides);
}
