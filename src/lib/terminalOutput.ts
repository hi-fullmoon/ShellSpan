import type { SessionStatus } from '../types';

const TERMINAL_PREFIX = '\u001b[36m[termbridge]\u001b[0m';

function statusLabel(status: SessionStatus) {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'error':
      return '错误';
    case 'disconnected':
      return '已断开';
  }
}

export function normalizeTerminalStatusMessage(message?: string) {
  if (!message) {
    return '';
  }

  switch (message.trim()) {
    case 'shell ready':
      return '终端已就绪';
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
