import {
  appendTerminalOutput,
  clearTerminalOutput,
  getRecentTerminalOutput,
} from '@/lib/terminal-output-buffer';

export const BUFFER_BURST_BYTES = 256 * 1024;
export const BUFFER_CHUNK_BYTES = 4 * 1024;
export const BUFFER_CHUNK_COUNT = BUFFER_BURST_BYTES / BUFFER_CHUNK_BYTES;
export const MULTI_SESSION_COUNT = 4;
export const CONTEXT_LINE_LIMIT = 2_000;
export const INCREMENTAL_RESET_BYTES = 192 * 1024;
export const COALESCED_INCREMENTAL_CHUNKS = 8;

const TERMINAL_LINE = '\u001b[32mtermbridge\u001b[0m output line 0123456789 abcdefghijklmnopqrstuvwxyz\r\n';

function repeatedPayload(bytes: number): string {
  return TERMINAL_LINE.repeat(Math.ceil(bytes / TERMINAL_LINE.length)).slice(0, bytes);
}

export const BUFFER_CHUNK = repeatedPayload(BUFFER_CHUNK_BYTES);
export const INCREMENTAL_SEED = TERMINAL_LINE.repeat(512);
export const INCREMENTAL_APPEND_CHUNK = TERMINAL_LINE.repeat(8);
export const INCREMENTAL_SEED_BYTES = new TextEncoder().encode(INCREMENTAL_SEED).length;
export const INCREMENTAL_APPEND_BYTES = new TextEncoder().encode(INCREMENTAL_APPEND_CHUNK).length;
export const XTERM_OUTPUT_BYTES = 512 * 1024;
export const XTERM_OUTPUT_CHUNKS = Array.from(
  { length: XTERM_OUTPUT_BYTES / (8 * 1024) },
  () => repeatedPayload(8 * 1024),
);

/**
 * Mirrors the output-buffer part of TerminalController's SSH/local data
 * listener. When the AI panel is open, its live-context hook coalesces output
 * notifications to one render per animation frame; `extractContext` models
 * that one context extraction after the burst.
 */
export function runOutputBufferBurst(
  sessionId: string,
  extractContext: boolean,
): string {
  clearTerminalOutput(sessionId);
  for (let index = 0; index < BUFFER_CHUNK_COUNT; index += 1) {
    appendTerminalOutput(sessionId, BUFFER_CHUNK);
  }
  const context = extractContext
    ? getRecentTerminalOutput(sessionId, CONTEXT_LINE_LIMIT)
    : '';
  clearTerminalOutput(sessionId);
  return context;
}

export function preloadOutputBuffer(sessionId: string): void {
  clearTerminalOutput(sessionId);
  for (let index = 0; index < BUFFER_CHUNK_COUNT; index += 1) {
    appendTerminalOutput(sessionId, BUFFER_CHUNK);
  }
}

export function primeIncrementalOutputBuffer(sessionId: string): void {
  clearTerminalOutput(sessionId);
  appendTerminalOutput(sessionId, INCREMENTAL_SEED);
  getRecentTerminalOutput(sessionId, CONTEXT_LINE_LIMIT);
}

export function appendIncrementalTerminalContext(sessionId: string): string {
  appendTerminalOutput(sessionId, INCREMENTAL_APPEND_CHUNK);
  return getRecentTerminalOutput(sessionId, CONTEXT_LINE_LIMIT);
}

export function appendCoalescedIncrementalTerminalContext(sessionId: string): string {
  for (let index = 0; index < COALESCED_INCREMENTAL_CHUNKS; index += 1) {
    appendTerminalOutput(sessionId, INCREMENTAL_APPEND_CHUNK);
  }
  return getRecentTerminalOutput(sessionId, CONTEXT_LINE_LIMIT);
}

/**
 * Production-shaped multi-session workload: every terminal keeps its complete
 * bounded output buffer, while only the active AI-bound session prepares a
 * redacted context. Passing `false` models AI closed/no output subscription.
 */
export function runMultiSessionOutputBurst(
  sessionPrefix: string,
  extractActiveContext: boolean,
): string {
  const sessionIds = Array.from(
    { length: MULTI_SESSION_COUNT },
    (_, index) => `${sessionPrefix}-${index}`,
  );
  for (const sessionId of sessionIds) clearTerminalOutput(sessionId);
  for (let chunkIndex = 0; chunkIndex < BUFFER_CHUNK_COUNT; chunkIndex += 1) {
    for (const sessionId of sessionIds) appendTerminalOutput(sessionId, BUFFER_CHUNK);
  }
  const context = extractActiveContext
    ? getRecentTerminalOutput(sessionIds[0], CONTEXT_LINE_LIMIT)
    : '';
  for (const sessionId of sessionIds) clearTerminalOutput(sessionId);
  return context;
}
