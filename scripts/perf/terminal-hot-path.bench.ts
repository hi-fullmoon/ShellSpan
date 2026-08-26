import { Terminal } from '@xterm/xterm';
import { afterAll, bench, describe, vi } from 'vitest';
import {
  BUFFER_BURST_BYTES,
  COALESCED_INCREMENTAL_CHUNKS,
  CONTEXT_LINE_LIMIT,
  INCREMENTAL_APPEND_BYTES,
  INCREMENTAL_RESET_BYTES,
  INCREMENTAL_SEED_BYTES,
  MULTI_SESSION_COUNT,
  XTERM_OUTPUT_BYTES,
  XTERM_OUTPUT_CHUNKS,
  appendCoalescedIncrementalTerminalContext,
  appendIncrementalTerminalContext,
  preloadOutputBuffer,
  primeIncrementalOutputBuffer,
  runMultiSessionOutputBurst,
  runOutputBufferBurst,
} from './terminal-workloads';
import {
  clearTerminalOutput,
  getRecentTerminalOutput,
  subscribeTerminalOutput,
} from '@/lib/terminal-output-buffer';

const instrumentation = vi.hoisted(() => ({
  ipcCalls: 0,
  debugLogs: 0,
  errorLogs: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => {
    instrumentation.ipcCalls += 1;
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {
      instrumentation.debugLogs += 1;
    },
    info: () => {},
    warn: () => {},
    error: () => {
      instrumentation.errorLogs += 1;
    },
  }),
}));

import { invokeWriteSession } from '@/lib/tauri';

const STANDARD_BENCH = {
  time: 1_000,
  iterations: 10,
  warmupTime: 250,
  warmupIterations: 3,
};

const EXPENSIVE_BENCH = {
  time: 750,
  iterations: 6,
  warmupTime: 200,
  warmupIterations: 2,
};

const INPUT_EVENTS_PER_OPERATION = 1_000;
const contextSessionId = 'perf-context';
preloadOutputBuffer(contextSessionId);
const incrementalSessionId = 'perf-context-incremental';
let incrementalBufferBytes = INCREMENTAL_SEED_BYTES;
primeIncrementalOutputBuffer(incrementalSessionId);
const coalescedIncrementalSessionId = 'perf-context-incremental-coalesced';
let coalescedIncrementalBufferBytes = INCREMENTAL_SEED_BYTES;
primeIncrementalOutputBuffer(coalescedIncrementalSessionId);
let activeOutputNotificationPending = false;
const stopActiveOutputSubscription = subscribeTerminalOutput(
  'perf-buffer-multi-active-0',
  () => {
    activeOutputNotificationPending = true;
  },
);

const singleXterm = new Terminal({ cols: 120, rows: 30, scrollback: 10_000 });
const multiXterms = Array.from(
  { length: MULTI_SESSION_COUNT },
  () => new Terminal({ cols: 120, rows: 30, scrollback: 10_000 }),
);

function writeChunks(terminal: Terminal, chunks: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    let remaining = chunks.length;
    for (const chunk of chunks) {
      terminal.write(chunk, () => {
        remaining -= 1;
        if (remaining === 0) resolve();
      });
    }
  });
}

describe('terminal input IPC and logging', () => {
  bench(`connected input burst (${INPUT_EVENTS_PER_OPERATION} events)`, async () => {
    await Promise.all(Array.from(
      { length: INPUT_EVENTS_PER_OPERATION },
      (_, index) => invokeWriteSession('perf-input', String(index % 10)),
    ));
  }, STANDARD_BENCH);
});

describe('terminal output buffer and AI context', () => {
  bench(`append ${BUFFER_BURST_BYTES / 1024} KiB in 4 KiB chunks (AI closed)`, () => {
    runOutputBufferBurst('perf-buffer-closed', false);
  }, STANDARD_BENCH);

  bench(`append ${BUFFER_BURST_BYTES / 1024} KiB + one context extraction (AI open)`, () => {
    runOutputBufferBurst('perf-buffer-open', true);
  }, STANDARD_BENCH);

  bench('extract 2,000-line AI context from a saturated 256 KiB buffer', () => {
    getRecentTerminalOutput(contextSessionId, CONTEXT_LINE_LIMIT);
  }, STANDARD_BENCH);

  bench(`incremental append + context (${INCREMENTAL_APPEND_BYTES} bytes, below buffer cap)`, () => {
    if (incrementalBufferBytes + INCREMENTAL_APPEND_BYTES > INCREMENTAL_RESET_BYTES) {
      primeIncrementalOutputBuffer(incrementalSessionId);
      incrementalBufferBytes = INCREMENTAL_SEED_BYTES;
    }
    incrementalBufferBytes += INCREMENTAL_APPEND_BYTES;
    appendIncrementalTerminalContext(incrementalSessionId);
  }, STANDARD_BENCH);

  bench(`${COALESCED_INCREMENTAL_CHUNKS} coalesced appends + one context (${INCREMENTAL_APPEND_BYTES * COALESCED_INCREMENTAL_CHUNKS} bytes)`, () => {
    const appendedBytes = INCREMENTAL_APPEND_BYTES * COALESCED_INCREMENTAL_CHUNKS;
    if (coalescedIncrementalBufferBytes + appendedBytes > INCREMENTAL_RESET_BYTES) {
      primeIncrementalOutputBuffer(coalescedIncrementalSessionId);
      coalescedIncrementalBufferBytes = INCREMENTAL_SEED_BYTES;
    }
    coalescedIncrementalBufferBytes += appendedBytes;
    appendCoalescedIncrementalTerminalContext(coalescedIncrementalSessionId);
  }, STANDARD_BENCH);

  bench(`${MULTI_SESSION_COUNT} sessions append, AI closed/unsubscribed (${BUFFER_BURST_BYTES / 1024} KiB each)`, () => {
    runMultiSessionOutputBurst('perf-buffer-multi-closed', false);
  }, EXPENSIVE_BENCH);

  bench(`${MULTI_SESSION_COUNT} sessions append, one active AI subscription + extraction (${BUFFER_BURST_BYTES / 1024} KiB each)`, () => {
    activeOutputNotificationPending = false;
    runMultiSessionOutputBurst('perf-buffer-multi-active', true);
    if (!activeOutputNotificationPending) throw new Error('active output subscription was not notified');
  }, EXPENSIVE_BENCH);

  bench(`${MULTI_SESSION_COUNT} sessions append + cold extract every session (legacy stress)`, () => {
    for (let index = 0; index < MULTI_SESSION_COUNT; index += 1) {
      runOutputBufferBurst(`perf-buffer-multi-stress-${index}`, true);
    }
  }, EXPENSIVE_BENCH);
});

describe('xterm large-output parsing', () => {
  bench(`single session, ${XTERM_OUTPUT_BYTES / 1024} KiB in 8 KiB writes`, async () => {
    await writeChunks(singleXterm, XTERM_OUTPUT_CHUNKS);
  }, EXPENSIVE_BENCH);

  bench(`${MULTI_SESSION_COUNT} sessions, ${XTERM_OUTPUT_BYTES / 1024} KiB each`, async () => {
    await Promise.all(multiXterms.map((terminal) => writeChunks(terminal, XTERM_OUTPUT_CHUNKS)));
  }, EXPENSIVE_BENCH);
});

afterAll(() => {
  clearTerminalOutput(contextSessionId);
  clearTerminalOutput(incrementalSessionId);
  clearTerminalOutput(coalescedIncrementalSessionId);
  stopActiveOutputSubscription();
  singleXterm.dispose();
  for (const terminal of multiXterms) terminal.dispose();
});
