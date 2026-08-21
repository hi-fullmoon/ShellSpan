const MAX_BUFFER_BYTES = 256 * 1024;

const buffers = new Map<string, string>();

export function appendTerminalOutput(sessionId: string, chunk: string): void {
  const next = (buffers.get(sessionId) ?? '') + chunk;
  buffers.set(sessionId, trimUtf8Tail(next, MAX_BUFFER_BYTES));
}

export function clearTerminalOutput(sessionId: string): void {
  buffers.delete(sessionId);
}

export function rebindTerminalOutput(oldSessionId: string, newSessionId: string): void {
  const content = buffers.get(oldSessionId);
  buffers.delete(oldSessionId);
  if (content !== undefined) buffers.set(newSessionId, content);
}

export function getRecentTerminalOutput(sessionId: string, maxLines: number): string {
  const raw = buffers.get(sessionId) ?? '';
  const normalized = redactTerminalSecrets(renderTerminalText(stripAnsi(raw)));
  return normalized.split('\n').slice(-Math.max(1, maxLines)).join('\n').trim();
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}

export function renderTerminalText(value: string): string {
  const lines: string[] = [];
  let current: string[] = [];
  let cursor = 0;
  for (const character of value) {
    if (character === '\r') {
      cursor = 0;
    } else if (character === '\n') {
      lines.push(current.join('').replace(/[ \t]+$/g, ''));
      current = [];
      cursor = 0;
    } else if (character === '\b') {
      cursor = Math.max(0, cursor - 1);
    } else if (character >= ' ' || character === '\t') {
      current[cursor] = character;
      cursor += 1;
    }
  }
  if (current.length > 0) lines.push(current.join('').replace(/[ \t]+$/g, ''));
  return lines.join('\n');
}

export function redactTerminalSecrets(value: string): string {
  return value
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*([^\s]+)/gi, '$1=[REDACTED]');
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return value;
  const tail = bytes.slice(bytes.length - maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(tail).replace(/^\uFFFD/, '');
}
