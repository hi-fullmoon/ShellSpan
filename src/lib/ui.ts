// ui.ts — merged from ui/index.ts, pathDisplay.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { RemoteFileKind, SessionStatus, TerminalTheme, CursorStyle } from '../types';

export function cn(...parts: ClassValue[]) {
  return twMerge(clsx(...parts));
}

export function sessionStatusTone(status: SessionStatus) {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500/12 text-emerald-300';
    case 'connecting':
      return 'bg-sky-500/12 text-sky-300';
    case 'error':
      return 'bg-rose-500/12 text-rose-300';
    case 'disconnected':
      return 'bg-slate-500/12 text-slate-300';
  }
}

export function sessionStatusDot(status: SessionStatus) {
  switch (status) {
    case 'connected':
      return 'bg-emerald-400';
    case 'connecting':
      return 'bg-sky-400';
    case 'error':
      return 'bg-rose-400';
    case 'disconnected':
      return 'bg-slate-400';
  }
}

export function fileKindColor(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return 'text-cyan-300';
    case 'symlink':
      return 'text-violet-300';
    case 'file':
      return 'text-slate-300';
    case 'other':
      return 'text-amber-300';
  }
}

export function fileKindTone(kind: RemoteFileKind) {
  return `${fileKindColor(kind).replace('text-', 'bg-').replace('-300', '-500/12')} ${fileKindColor(kind)}`;
}

export function getCurrentThemeMode() {
  if (typeof document === 'undefined') {
    return 'dark' as const;
  }

  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

interface ITerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  brightBlack: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightWhite: string;
}

const terminalThemes: Record<TerminalTheme, { dark: ITerminalTheme; light: ITerminalTheme }> = {
  default: {
    dark: {
      background: '#020617',
      foreground: '#dbe7f5',
      cursor: '#67e8f9',
      selectionBackground: '#1e293b',
      black: '#0f172a',
      brightBlack: '#475569',
      red: '#fb7185',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#67e8f9',
      white: '#e2e8f0',
      brightWhite: '#f8fafc',
    },
    light: {
      background: '#f8fafc',
      foreground: '#0f172a',
      cursor: '#0891b2',
      selectionBackground: '#cbd5e1',
      black: '#e2e8f0',
      brightBlack: '#94a3b8',
      red: '#e11d48',
      green: '#059669',
      yellow: '#ca8a04',
      blue: '#2563eb',
      magenta: '#9333ea',
      cyan: '#0891b2',
      white: '#334155',
      brightWhite: '#0f172a',
    },
  },
  dracula: {
    dark: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      brightBlack: '#6272a4',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightWhite: '#ffffff',
    },
    light: {
      background: '#f8f8f2',
      foreground: '#282a36',
      cursor: '#282a36',
      selectionBackground: '#d0d0d0',
      black: '#e8e8e8',
      brightBlack: '#6272a4',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#282a36',
      brightWhite: '#000000',
    },
  },
  'solarized-dark': {
    dark: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      brightBlack: '#002b36',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightWhite: '#fdf6e3',
    },
    light: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
      black: '#eee8d5',
      brightBlack: '#fdf6e3',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#073642',
      brightWhite: '#002b36',
    },
  },
  'solarized-light': {
    dark: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      brightBlack: '#002b36',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightWhite: '#fdf6e3',
    },
    light: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
      black: '#eee8d5',
      brightBlack: '#fdf6e3',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#073642',
      brightWhite: '#002b36',
    },
  },
  'one-dark': {
    dark: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#282c34',
      brightBlack: '#5c6370',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightWhite: '#ffffff',
    },
    light: {
      background: '#fafafa',
      foreground: '#383a42',
      cursor: '#4078f2',
      selectionBackground: '#e5e5e6',
      black: '#fafafa',
      brightBlack: '#a0a1a7',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#4078f2',
      magenta: '#a626a4',
      cyan: '#0184bc',
      white: '#383a42',
      brightWhite: '#000000',
    },
  },
  monokai: {
    dark: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822',
      brightBlack: '#75715e',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightWhite: '#f9f8f5',
    },
    light: {
      background: '#f9f8f5',
      foreground: '#272822',
      cursor: '#272822',
      selectionBackground: '#d0d0d0',
      black: '#e8e8e8',
      brightBlack: '#75715e',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#272822',
      brightWhite: '#000000',
    },
  },
};

export function getTerminalTheme(
  themeName: TerminalTheme = 'default',
  mode: 'light' | 'dark' = getCurrentThemeMode(),
): ITerminalTheme {
  const themeSet = terminalThemes[themeName] ?? terminalThemes.default;
  return themeSet[mode];
}

export function getCursorStyle(style: CursorStyle): 'block' | 'bar' | 'underline' {
  switch (style) {
    case 'block':
      return 'block';
    case 'line':
      return 'bar';
    case 'bar':
      return 'underline';
    default:
      return 'block';
  }
}

const SOFT_WRAP = '\u200b';

export function addPathWrapOpportunities(path: string) {
  return path.replace(/[\\/]/g, (separator) => `${separator}${SOFT_WRAP}`);
}
