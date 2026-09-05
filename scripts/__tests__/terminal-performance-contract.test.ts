import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUFFER_BURST_BYTES,
  BUFFER_CHUNK_BYTES,
  BUFFER_CHUNK_COUNT,
  COALESCED_INCREMENTAL_CHUNKS,
  CONTEXT_LINE_LIMIT,
  INCREMENTAL_APPEND_BYTES,
  INCREMENTAL_RESET_BYTES,
  INCREMENTAL_SEED,
  INCREMENTAL_SEED_BYTES,
  appendCoalescedIncrementalTerminalContext,
  appendIncrementalTerminalContext,
  preloadOutputBuffer,
  primeIncrementalOutputBuffer,
  runMultiSessionOutputBurst,
  runOutputBufferBurst,
} from '../perf/terminal-workloads';
import {
  appendTerminalOutput,
  clearTerminalOutput,
  getRecentTerminalOutput,
  getRecentTerminalOutputSnapshot,
  subscribeTerminalOutput,
} from '@/lib/terminal/terminal-output-buffer';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn(),
  error: vi.fn(),
  createOperationId: vi.fn(() => 'test-operation-id'),
  findOperationId: vi.fn(() => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: mocks.debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.error,
  }),
}));

vi.mock('@/lib/operation-id', () => ({
  createOperationId: mocks.createOperationId,
  findOperationId: mocks.findOperationId,
}));

import {
  invokeResizeSession,
  invokeSetSessionOutputPaused,
  invokeWriteSession,
} from '@/lib/ipc/tauri';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('terminal performance benchmark contract', () => {
  it('keeps the output workload byte geometry stable', () => {
    expect(BUFFER_CHUNK_COUNT).toBe(64);
    expect(BUFFER_CHUNK_BYTES * BUFFER_CHUNK_COUNT).toBe(BUFFER_BURST_BYTES);
    expect(runOutputBufferBurst('contract-ai-closed', false)).toBe('');
    expect(runOutputBufferBurst('contract-ai-open', true).length).toBeGreaterThan(0);
  });

  it('keeps the incremental workload below the wrap boundary and reuses unchanged snapshots', () => {
    expect(INCREMENTAL_SEED.endsWith('\n')).toBe(true);
    expect(INCREMENTAL_SEED_BYTES).toBeLessThan(INCREMENTAL_RESET_BYTES);
    expect(INCREMENTAL_APPEND_BYTES).toBeLessThan(INCREMENTAL_RESET_BYTES - INCREMENTAL_SEED_BYTES);

    primeIncrementalOutputBuffer('contract-incremental');
    const seeded = getRecentTerminalOutputSnapshot('contract-incremental', CONTEXT_LINE_LIMIT);
    expect(getRecentTerminalOutputSnapshot('contract-incremental', CONTEXT_LINE_LIMIT)).toBe(seeded);

    const appended = appendIncrementalTerminalContext('contract-incremental');
    const next = getRecentTerminalOutputSnapshot('contract-incremental', CONTEXT_LINE_LIMIT);
    expect(next).not.toBe(seeded);
    expect(next.content).toBe(appended);
    expect(getRecentTerminalOutputSnapshot('contract-incremental', CONTEXT_LINE_LIMIT)).toBe(next);

    const coalesced = appendCoalescedIncrementalTerminalContext('contract-incremental');
    expect(coalesced).toBe(getRecentTerminalOutput('contract-incremental', CONTEXT_LINE_LIMIT));
    expect(COALESCED_INCREMENTAL_CHUNKS).toBe(8);
    clearTerminalOutput('contract-incremental');
  });

  it('keeps saturated reads cached while invalidating safely on overwrite', () => {
    preloadOutputBuffer('contract-saturated');
    appendTerminalOutput('contract-saturated', '\npassword=saturated-secret\n');
    const first = getRecentTerminalOutputSnapshot('contract-saturated', CONTEXT_LINE_LIMIT);
    expect(first.content).not.toContain('saturated-secret');
    expect(getRecentTerminalOutputSnapshot('contract-saturated', CONTEXT_LINE_LIMIT)).toBe(first);

    appendTerminalOutput('contract-saturated', 'latest-after-wrap\n');
    const wrapped = getRecentTerminalOutputSnapshot('contract-saturated', CONTEXT_LINE_LIMIT);
    expect(wrapped).not.toBe(first);
    expect(wrapped.content).toContain('latest-after-wrap');
    expect(wrapped.content).not.toContain('saturated-secret');
    clearTerminalOutput('contract-saturated');
  });

  it('prepares AI context only for the active session in the multi-session workload', () => {
    expect(runMultiSessionOutputBurst('contract-multi-closed', false)).toBe('');
    expect(runMultiSessionOutputBurst('contract-multi-active', true).length).toBeGreaterThan(0);
  });

  it('does not notify an active AI subscriber for background-session output', () => {
    const activeListener = vi.fn();
    const unsubscribe = subscribeTerminalOutput('contract-active', activeListener);

    appendTerminalOutput('contract-background-1', 'one\n');
    appendTerminalOutput('contract-background-2', 'two\n');
    expect(activeListener).not.toHaveBeenCalled();

    appendTerminalOutput('contract-active', 'active\n');
    expect(activeListener).toHaveBeenCalledOnce();
    unsubscribe();
    appendTerminalOutput('contract-active', 'after unsubscribe\n');
    expect(activeListener).toHaveBeenCalledOnce();

    for (const sessionId of [
      'contract-active',
      'contract-background-1',
      'contract-background-2',
    ]) clearTerminalOutput(sessionId);
  });

  it('keeps redaction on the cached and incremental AI paths', () => {
    appendTerminalOutput('contract-redaction', 'safe line\n');
    getRecentTerminalOutputSnapshot('contract-redaction', CONTEXT_LINE_LIMIT);
    appendTerminalOutput('contract-redaction', 'api_key=incremental-secret\n');

    const output = getRecentTerminalOutput('contract-redaction', CONTEXT_LINE_LIMIT);
    expect(output).toContain('api_key=[REDACTED]');
    expect(output).not.toContain('incremental-secret');
    clearTerminalOutput('contract-redaction');
  });

  it('dispatches input in order without generic logging or ID bookkeeping', async () => {
    const events = 25;
    const writes = Array.from(
      { length: events },
      (_, index) => String(index % 10),
    );
    await Promise.all(writes.map((data) =>
      invokeWriteSession('contract-input', data),
    ));

    expect(mocks.invoke).toHaveBeenCalledTimes(events);
    expect(mocks.invoke.mock.calls.map(([command, args]) => [command, args.data])).toEqual(
      writes.map((data) => ['write_session', data]),
    );
    expect(mocks.debug).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.createOperationId).not.toHaveBeenCalled();
    expect(mocks.findOperationId).not.toHaveBeenCalled();
  });

  it('propagates write failures without generic logging', async () => {
    const failure = new Error('native write failed');
    mocks.invoke.mockRejectedValueOnce(failure);

    await expect(invokeWriteSession('contract-input', 'secret')).rejects.toBe(failure);

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.debug).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('returns the native IPC promise without another async wrapper', async () => {
    const nativePromise = Promise.resolve(undefined);
    mocks.invoke.mockReturnValueOnce(nativePromise);

    const result = invokeWriteSession('contract-input', 'x');

    expect(result).toBe(nativePromise);
    await result;
  });

  it('uses the same untracked path for repeated backpressure and resize controls', async () => {
    await invokeSetSessionOutputPaused('contract-input', true);
    await invokeSetSessionOutputPaused('contract-input', false);
    await invokeResizeSession('contract-input', 120, 30);

    expect(mocks.invoke.mock.calls).toEqual([
      ['set_session_output_paused', { sessionId: 'contract-input', paused: true }],
      ['set_session_output_paused', { sessionId: 'contract-input', paused: false }],
      ['resize_session', { sessionId: 'contract-input', cols: 120, rows: 30 }],
    ]);
    expect(mocks.debug).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.createOperationId).not.toHaveBeenCalled();
  });

  it('preserves backpressure and resize IPC failures for their callers', async () => {
    const pauseFailure = new Error('pause failed');
    const resizeFailure = new Error('resize failed');
    mocks.invoke
      .mockRejectedValueOnce(pauseFailure)
      .mockRejectedValueOnce(resizeFailure);

    await expect(invokeSetSessionOutputPaused('contract-input', true)).rejects.toBe(pauseFailure);
    await expect(invokeResizeSession('contract-input', 120, 30)).rejects.toBe(resizeFailure);

    expect(mocks.debug).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
