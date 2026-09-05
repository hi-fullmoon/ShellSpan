import { t } from '@/locales';
import type { SessionStatus } from '@/types';

const TERMINAL_PREFIX = '[36m[shellspan][0m';

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'connected':
      return t('terminal.status.connected');
    case 'connecting':
      return t('terminal.status.connecting');
    case 'error':
      return t('terminal.status.error');
    case 'disconnected':
      return t('terminal.status.disconnected');
  }
}

export function normalizeTerminalStatusMessage(message?: string): string {
  if (!message) {
    return '';
  }

  switch (message.trim()) {
    case 'shell ready':
      return t('terminal.message.shellReady');
    default:
      return message;
  }
}

export function formatTerminalStatusLine(
  status: SessionStatus,
  message?: string,
): string {
  const normalizedMessage = normalizeTerminalStatusMessage(message);
  const suffix = normalizedMessage ? ` ${normalizedMessage}` : '';

  return `${TERMINAL_PREFIX} [33m[${statusLabel(status)}][0m${suffix}`;
}

export function formatTerminalNoticeLine(
  label: string,
  message?: string,
  tone: '31' | '33' | '36' = '33',
): string {
  const suffix = message ? ` ${message}` : '';

  return `${TERMINAL_PREFIX} [${tone}m[${label}][0m${suffix}`;
}

export function shouldDisableTerminalInput(status: SessionStatus): boolean {
  return status === 'connecting';
}

export function shouldReconnectFromInput(
  status: SessionStatus,
  data: string,
): boolean {
  return (
    (status === 'disconnected' || status === 'error') &&
    (data === '\r' || data === '\n')
  );
}
