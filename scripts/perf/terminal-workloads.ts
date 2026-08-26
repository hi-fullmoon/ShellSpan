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

const TERMINAL_LINE = '\u001b[32mtermbridge\u001b[0m output line 0123456789 abcdefghijklmnopqrstuvwxyz\r\n';

function repeatedPayload(bytes: number): string {
  return TERMINAL_LINE.repeat(Math.ceil(bytes / TERMINAL_LINE.length)).slice(0, bytes);
}

export const BUFFER_CHUNK = repeatedPayload(BUFFER_CHUNK_BYTES);
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
