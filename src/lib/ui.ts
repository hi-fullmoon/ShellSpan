import type { RemoteFileKind, SessionStatus } from '../types';

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
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

export function fileKindTone(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return 'bg-cyan-500/12 text-cyan-300';
    case 'symlink':
      return 'bg-violet-500/12 text-violet-300';
    case 'file':
      return 'bg-slate-500/12 text-slate-300';
    case 'other':
      return 'bg-amber-500/12 text-amber-300';
  }
}

export function getCurrentThemeMode() {
  if (typeof document === 'undefined') {
    return 'dark' as const;
  }

  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function getTerminalTheme(mode: 'light' | 'dark' = getCurrentThemeMode()) {
  if (mode === 'light') {
    return {
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
    };
  }

  return {
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
  };
}
