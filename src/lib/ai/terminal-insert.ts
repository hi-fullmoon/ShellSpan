import type { TerminalSession } from '@/stores/terminalStore';

const TERMINAL_INSERT_LANGUAGES: ReadonlySet<string> = new Set([
  '',
  'sh',
  'bash',
  'zsh',
  'shell',
  'fish',
  'ash',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'shellsession',
  'console',
  'cmd',
  'bat',
  'powershell',
  'pwsh',
  'ps1',
  'terminal',
  'cli',
]);

/** Only single-line commands may be pasted into a terminal; newlines risk executing immediately when bracketed paste is off. */
export function sanitizeSingleLineTerminalCommand(code: string): string | null {
  const sanitized = code.replace(/[\r\n]+$/g, '');
  if (!sanitized.trim() || /[\r\n]/.test(sanitized)) return null;
  return sanitized;
}

export function isTerminalInsertLanguage(language: string): boolean {
  return TERMINAL_INSERT_LANGUAGES.has(language.trim().toLowerCase());
}

export function terminalSessionDisplayName(
  session: Pick<TerminalSession, 'manualTitle' | 'title' | 'host'>,
): string {
  return session.manualTitle?.trim() || session.title.trim() || session.host.trim();
}

export function canInsertIntoTerminal(input: {
  readonly session: Pick<TerminalSession, 'status' | 'readOnly'> | null | undefined;
  readonly preparing: boolean;
  readonly blockedByAgent: boolean;
  readonly hasTerminal?: boolean;
}): boolean {
  return Boolean(
    input.session?.status === 'connected'
    && !input.session.readOnly
    && !input.preparing
    && !input.blockedByAgent
    && (input.hasTerminal ?? true),
  );
}
