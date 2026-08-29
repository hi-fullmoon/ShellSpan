export const MAX_AI_CONTEXT_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = MAX_AI_CONTEXT_BYTES;
const AI_CONTEXT_TRUNCATION_MARKER = '[... earlier terminal content omitted ...]\n';

interface TerminalOutputBuffer {
  chunks: Uint8Array[];
  head: number;
  byteLength: number;
  version: number;
  contextCache?: TerminalOutputContextCache;
}

export interface TerminalOutputSnapshot {
  readonly version: number;
  readonly content: string;
}

interface TerminalOutputContextCache {
  version: number;
  maxLines: number;
  redactedLines: string[];
  snapshot: TerminalOutputSnapshot;
  appendBoundarySafe: boolean;
  nextChunkIndex: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const buffers = new Map<string, TerminalOutputBuffer>();
const outputListeners = new Map<string, Set<() => void>>();
const EMPTY_TERMINAL_OUTPUT_SNAPSHOT: TerminalOutputSnapshot = {
  version: 0,
  content: '',
};

function notifyOutputChanged(sessionId: string): void {
  for (const listener of outputListeners.get(sessionId) ?? []) listener();
}

export function subscribeTerminalOutput(
  sessionId: string,
  listener: () => void,
): () => void {
  const listeners = outputListeners.get(sessionId) ?? new Set<() => void>();
  listeners.add(listener);
  outputListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) outputListeners.delete(sessionId);
  };
}

export function appendTerminalOutput(sessionId: string, chunk: string): void {
  if (!chunk) return;

  const bytes = encoder.encode(chunk);
  const buffer = buffers.get(sessionId) ?? {
    chunks: [],
    head: 0,
    byteLength: 0,
    version: 0,
  };
  buffer.chunks.push(bytes);
  buffer.byteLength += bytes.length;
  const trimmed = trimBufferHead(buffer, MAX_BUFFER_BYTES);
  buffer.version += 1;
  // Preserve a safe checkpoint until the next actual reader. Multiple output
  // chunks can then be normalized/redacted once after the live hook coalesces
  // their notifications. Ring-buffer trimming invalidates its chunk cursor.
  if (trimmed) buffer.contextCache = undefined;
  buffers.set(sessionId, buffer);
  notifyOutputChanged(sessionId);
}

export function clearTerminalOutput(sessionId: string): void {
  if (buffers.delete(sessionId)) notifyOutputChanged(sessionId);
}

export function rebindTerminalOutput(oldSessionId: string, newSessionId: string): void {
  const buffer = buffers.get(oldSessionId);
  buffers.delete(oldSessionId);
  if (buffer !== undefined) {
    buffer.version += 1;
    buffer.contextCache = undefined;
    buffers.set(newSessionId, buffer);
  }
  notifyOutputChanged(oldSessionId);
  notifyOutputChanged(newSessionId);
}

export function getRecentTerminalOutput(sessionId: string, maxLines: number): string {
  return getRecentTerminalOutputSnapshot(sessionId, maxLines).content;
}

/**
 * Returns a versioned, already-redacted AI context snapshot. The cached value
 * is safe to reuse across React renders; raw decoded terminal text is never
 * retained outside the bounded byte buffer.
 */
export function getRecentTerminalOutputSnapshot(
  sessionId: string,
  maxLines: number,
): TerminalOutputSnapshot {
  const buffer = buffers.get(sessionId);
  if (!buffer || buffer.byteLength === 0) return EMPTY_TERMINAL_OUTPUT_SNAPSHOT;

  const lineLimit = normalizeLineLimit(maxLines);
  const cached = buffer.contextCache;
  if (cached?.version === buffer.version && cached.maxLines === lineLimit) {
    return cached.snapshot;
  }

  if (
    cached?.maxLines === lineLimit
    && cached.appendBoundarySafe
    && cached.nextChunkIndex <= buffer.chunks.length
  ) {
    const appendedRaw = decodeBufferChunks(buffer, cached.nextChunkIndex);
    const appendedCache = appendToContextCache(
      cached,
      appendedRaw,
      buffer.version,
      buffer.chunks.length,
    );
    buffer.contextCache = appendedCache;
    return appendedCache.snapshot;
  }

  const raw = decodeBuffer(buffer);
  const normalized = renderTerminalText(stripAnsi(raw));
  const redactedLines = redactTerminalSecrets(normalized)
    .split('\n')
    .slice(-lineLimit);
  const snapshot = createContextSnapshot(buffer.version, redactedLines);
  buffer.contextCache = {
    version: buffer.version,
    maxLines: lineLimit,
    redactedLines,
    snapshot,
    appendBoundarySafe: isIncrementalAppendBoundarySafe(raw, normalized),
    nextChunkIndex: buffer.chunks.length,
  };
  return snapshot;
}

export function truncateAiContext(
  value: string,
  maxBytes = MAX_AI_CONTEXT_BYTES,
): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (limit === 0 || !value) return '';
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) return value;

  const marker = encoder.encode(AI_CONTEXT_TRUNCATION_MARKER);
  if (marker.length >= limit) {
    return decoder.decode(marker.slice(0, limit));
  }

  let start = bytes.length - (limit - marker.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return AI_CONTEXT_TRUNCATION_MARKER + decoder.decode(bytes.slice(start));
}

export function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '');
}

export function renderTerminalText(value: string): string {
  return renderTerminalLines(value).join('\n');
}

function renderTerminalLines(value: string): string[] {
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
  return lines;
}

export function redactTerminalSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|$)/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(authorization\s*:\s*(?:bearer|basic)\s+)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\S+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|token|password|passwd|passphrase|pwd)\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|token|password|passwd|passphrase))(?:=|\s+)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\S+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS ACCESS KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
}

const SENSITIVE_FIELD_KEYS = new Set([
  'apikey',
  'accesstoken',
  'authtoken',
  'authorization',
  'clientsecret',
  'credential',
  'credentials',
  'passphrase',
  'password',
  'passwd',
  'privatekey',
  'privatekeydata',
  'pwd',
  'secret',
  'token',
]);

function normalizedSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Recursively sanitizes JSON-compatible data. Sensitive field names are
 * replaced regardless of nesting depth, and every string leaf still passes
 * through the terminal text redactor. This is the common boundary used before
 * Agent tool data is sent to a model, persisted, or copied into audit metadata.
 */
export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === 'string') return redactTerminalSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item)) as T;
  if (typeof value !== 'object' || value === null) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_FIELD_KEYS.has(normalizedSensitiveKey(key))
      ? '[REDACTED]'
      : redactSensitiveValue(item);
  }
  return redacted as T;
}

function trimBufferHead(buffer: TerminalOutputBuffer, maxBytes: number): boolean {
  let excess = buffer.byteLength - maxBytes;
  let trimmed = false;
  while (excess > 0 && buffer.head < buffer.chunks.length) {
    trimmed = true;
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
  return trimmed;
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

function normalizeLineLimit(maxLines: number): number {
  if (!Number.isFinite(maxLines)) return 1;
  return Math.max(1, Math.floor(maxLines));
}

function createContextSnapshot(
  version: number,
  redactedLines: readonly string[],
): TerminalOutputSnapshot {
  return {
    version,
    content: truncateAiContext(redactedLines.join('\n').trim()),
  };
}

function appendToContextCache(
  cache: TerminalOutputContextCache,
  appendedRaw: string,
  version: number,
  nextChunkIndex: number,
): TerminalOutputContextCache {
  const strippedChunk = stripAnsi(appendedRaw);
  const renderedLines = renderTerminalLines(strippedChunk);
  const normalizedChunk = renderedLines.join('\n');
  const redactedLines = renderedLines.length === 0
    ? cache.redactedLines
    : [
        ...cache.redactedLines,
        ...redactTerminalSecrets(normalizedChunk).split('\n'),
      ].slice(-cache.maxLines);
  const snapshot = createContextSnapshot(version, redactedLines);
  return {
    version,
    maxLines: cache.maxLines,
    redactedLines,
    snapshot,
    appendBoundarySafe: isIncrementalAppendBoundarySafe(appendedRaw, normalizedChunk),
    nextChunkIndex,
  };
}

function decodeBufferChunks(buffer: TerminalOutputBuffer, startIndex: number): string {
  const decoded: string[] = [];
  for (let index = startIndex; index < buffer.chunks.length; index += 1) {
    decoded.push(decoder.decode(buffer.chunks[index]));
  }
  return decoded.join('');
}

function isIncrementalAppendBoundarySafe(raw: string, normalized: string): boolean {
  return raw.endsWith('\n')
    && !hasIncompleteAnsiSequence(raw)
    && !hasPendingSensitiveSequence(normalized);
}

function hasIncompleteAnsiSequence(value: string): boolean {
  let state: 'ground' | 'escape' | 'csi-params' | 'csi-intermediates' | 'osc' | 'osc-escape' = 'ground';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (state === 'ground') {
      if (code === 0x1b) state = 'escape';
      continue;
    }
    if (state === 'escape') {
      if (character === '[') state = 'csi-params';
      else if (character === ']') state = 'osc';
      else state = 'ground';
      continue;
    }
    if (state === 'osc') {
      if (code === 0x07) state = 'ground';
      else if (code === 0x1b) state = 'osc-escape';
      continue;
    }
    if (state === 'osc-escape') {
      if (character === '\\') state = 'ground';
      else if (code !== 0x1b) state = 'osc';
      continue;
    }
    if (state === 'csi-params') {
      if (code >= 0x30 && code <= 0x3f) continue;
      if (code >= 0x20 && code <= 0x2f) {
        state = 'csi-intermediates';
        continue;
      }
      state = 'ground';
      continue;
    }
    if (code >= 0x20 && code <= 0x2f) continue;
    state = 'ground';
  }
  return state !== 'ground';
}

function hasPendingSensitiveSequence(value: string): boolean {
  let privateKeyOpen = false;
  const privateKeyBoundary = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/gi;
  for (const match of value.matchAll(privateKeyBoundary)) {
    privateKeyOpen = match[0].toUpperCase().includes('BEGIN');
  }
  if (privateKeyOpen) return true;

  return /\bauthorization\s*:\s*(?:(?:bearer|basic)\s*)?$/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|pwd)\s*(?::|=)?\s*["']?$/i.test(value)
    || /--(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)(?:=|\s)*$/i.test(value);
}
