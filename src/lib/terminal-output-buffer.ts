const MAX_BUFFER_BYTES = 256 * 1024;

interface TerminalOutputBuffer {
  chunks: Uint8Array[];
  head: number;
  byteLength: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const buffers = new Map<string, TerminalOutputBuffer>();
const outputListeners = new Set<(sessionId: string) => void>();

function notifyOutputChanged(sessionId: string): void {
  for (const listener of outputListeners) listener(sessionId);
}

export function subscribeTerminalOutput(
  listener: (sessionId: string) => void,
): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

export function appendTerminalOutput(sessionId: string, chunk: string): void {
  if (!chunk) return;

  const bytes = encoder.encode(chunk);
  const buffer = buffers.get(sessionId) ?? { chunks: [], head: 0, byteLength: 0 };
  buffer.chunks.push(bytes);
  buffer.byteLength += bytes.length;
  trimBufferHead(buffer, MAX_BUFFER_BYTES);
  buffers.set(sessionId, buffer);
  notifyOutputChanged(sessionId);
}

export function clearTerminalOutput(sessionId: string): void {
  buffers.delete(sessionId);
  notifyOutputChanged(sessionId);
}

export function rebindTerminalOutput(oldSessionId: string, newSessionId: string): void {
  const buffer = buffers.get(oldSessionId);
  buffers.delete(oldSessionId);
  if (buffer !== undefined) buffers.set(newSessionId, buffer);
  notifyOutputChanged(oldSessionId);
  notifyOutputChanged(newSessionId);
}

export function getRecentTerminalOutput(sessionId: string, maxLines: number): string {
  const raw = decodeBuffer(buffers.get(sessionId));
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
    .replace(
      /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|pwd)\s*[:=]\s*)(["']?)[^\s"']+\2/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd))(?:=|\s+)\S+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS ACCESS KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
}

function trimBufferHead(buffer: TerminalOutputBuffer, maxBytes: number): void {
  let excess = buffer.byteLength - maxBytes;
  while (excess > 0 && buffer.head < buffer.chunks.length) {
    const current = buffer.chunks[buffer.head];
    if (current.length <= excess) {
      excess -= current.length;
      buffer.byteLength -= current.length;
      buffer.head += 1;
      continue;
    }

    let offset = excess;
    // The retained tail must start at a UTF-8 code point boundary. Dropping
    // continuation bytes can make the buffer a few bytes smaller than the
    // nominal cap, which is preferable to introducing U+FFFD into AI context.
    while (offset < current.length && (current[offset] & 0xc0) === 0x80) {
      offset += 1;
    }
    buffer.chunks[buffer.head] = current.slice(offset);
    buffer.byteLength -= offset;
    excess = 0;
  }

  // Avoid retaining an ever-growing prefix of already-consumed chunk slots.
  if (buffer.head > 64 && buffer.head * 2 >= buffer.chunks.length) {
    buffer.chunks = buffer.chunks.slice(buffer.head);
    buffer.head = 0;
  }
}

function decodeBuffer(buffer: TerminalOutputBuffer | undefined): string {
  if (!buffer || buffer.byteLength === 0) return '';
  const bytes = new Uint8Array(buffer.byteLength);
  let offset = 0;
  for (let index = buffer.head; index < buffer.chunks.length; index += 1) {
    bytes.set(buffer.chunks[index], offset);
    offset += buffer.chunks[index].length;
  }
  return decoder.decode(bytes);
}
