// terminal.ts — merged from terminalOutput.ts, terminalStatus.ts
import type { SessionStatus } from '../types';
import { t } from './i18n';

const TERMINAL_PREFIX = '\u001b[36m[termbridge]\u001b[0m';

function statusLabel(status: SessionStatus) {
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

export function normalizeTerminalStatusMessage(message?: string) {
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
) {
  const normalizedMessage = normalizeTerminalStatusMessage(message);
  const suffix = normalizedMessage ? ` ${normalizedMessage}` : '';

  return `${TERMINAL_PREFIX} \u001b[33m[${statusLabel(status)}]\u001b[0m${suffix}`;
}

export function formatTerminalPrefixedText(text: string) {
  return `${TERMINAL_PREFIX} ${text}`;
}

export function formatTerminalNoticeLine(
  label: string,
  message?: string,
  tone: '31' | '33' | '36' = '33',
) {
  const suffix = message ? ` ${message}` : '';

  return `${TERMINAL_PREFIX} \u001b[${tone}m[${label}]\u001b[0m${suffix}`;
}

export function shouldDisableTerminalInput(status: SessionStatus) {
  return status === "connecting";
}

export function shouldReconnectFromInput(status: SessionStatus, data: string) {
  return (
    (status === "disconnected" || status === "error") &&
    (data === "\r" || data === "\n")
  );
}

export function shouldWarnOnClosedSession(status: SessionStatus) {
  return status !== "error";
}
