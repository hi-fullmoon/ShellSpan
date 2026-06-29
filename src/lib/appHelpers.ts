import type { AppPreferences } from '../types';

export const SYSTEM_OPEN_SETTINGS_EVENT = 'system-open-settings';
export const SETTINGS_CHANGED_EVENT = 'settings-changed';

export const defaultPreferences: AppPreferences = {
  theme: 'dark',
  locale: 'zh-CN',
  terminalFontSize: 14,
  terminalLineHeight: 1.2,
  terminalTheme: 'default',
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  showFileManager: true,
  showSidebar: true,
  autoReconnect: true,
  startupUpdateCheck: true,
  historyLimit: 8,
  keyboardShortcuts: {},
};

export function getSystemThemeMode(): 'dark' | 'light' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const validTerminalThemes: Array<AppPreferences['terminalTheme']> = [
  'default',
  'dracula',
  'solarized-dark',
  'solarized-light',
  'one-dark',
  'monokai',
];
const validCursorStyles: Array<AppPreferences['cursorStyle']> = ['block', 'line', 'bar'];

export function normalizePreferences(value: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    theme: value?.theme === 'light' || value?.theme === 'system' ? value.theme : 'dark',
    locale: value?.locale === 'en-US' ? 'en-US' : 'zh-CN',
    terminalFontSize:
      typeof value?.terminalFontSize === 'number' && value.terminalFontSize >= 10 && value.terminalFontSize <= 20 ? value.terminalFontSize : 14,
    terminalLineHeight:
      typeof value?.terminalLineHeight === 'number' && value.terminalLineHeight >= 1 && value.terminalLineHeight <= 2
        ? value.terminalLineHeight
        : 1.2,
    terminalTheme: validTerminalThemes.includes(value?.terminalTheme as AppPreferences['terminalTheme'])
      ? (value!.terminalTheme as AppPreferences['terminalTheme'])
      : 'default',
    cursorStyle: validCursorStyles.includes(value?.cursorStyle as AppPreferences['cursorStyle'])
      ? (value!.cursorStyle as AppPreferences['cursorStyle'])
      : 'block',
    cursorBlink: value?.cursorBlink !== false,
    copyOnSelect: value?.copyOnSelect === true,
    showFileManager: value?.showFileManager !== false,
    showSidebar: value?.showSidebar !== false,
    autoReconnect: value?.autoReconnect !== false,
    startupUpdateCheck: value?.startupUpdateCheck !== false,
    historyLimit: typeof value?.historyLimit === 'number' && value.historyLimit >= 3 && value.historyLimit <= 20 ? value.historyLimit : 8,
    keyboardShortcuts: (value?.keyboardShortcuts ?? {}) as AppPreferences['keyboardShortcuts'],
  };
}

export function reorderSessions<T extends SessionStateLike>(sessions: T[], draggedSessionId: string, insertIndex: number): T[] {
  const draggedIndex = sessions.findIndex((session) => session.sessionId === draggedSessionId);
  if (draggedIndex === -1) {
    return sessions;
  }

  const nextSessions = [...sessions];
  let lastPinnedIndex = -1;
  for (let i = nextSessions.length - 1; i >= 0; i--) {
    if (nextSessions[i].pinned) {
      lastPinnedIndex = i;
      break;
    }
  }
  const [draggedSession] = nextSessions.splice(draggedIndex, 1);
  const adjustedIndex = insertIndex;

  const lastPinnedAfterSplice = draggedSession.pinned ? lastPinnedIndex - 1 : lastPinnedIndex;

  if (draggedSession.pinned) {
    if (lastPinnedAfterSplice === -1 || adjustedIndex > lastPinnedAfterSplice) {
      draggedSession.pinned = false;
    }
  } else if (lastPinnedAfterSplice !== -1 && adjustedIndex <= lastPinnedAfterSplice) {
    draggedSession.pinned = true;
  }
  nextSessions.splice(adjustedIndex, 0, draggedSession);
  return nextSessions;
}

interface SessionStateLike {
  sessionId: string;
  pinned?: boolean;
}
