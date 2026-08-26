import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUFFER_BURST_BYTES,
  BUFFER_CHUNK_BYTES,
  BUFFER_CHUNK_COUNT,
  runOutputBufferBurst,
} from '../perf/terminal-workloads';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn(),
  error: vi.fn(),
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

import { invokeWriteSession } from '@/lib/tauri';

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

  it('records current input IPC and debug-log amplification', async () => {
    const events = 25;
    await Promise.all(Array.from(
      { length: events },
      () => invokeWriteSession('contract-input', 'x'),
    ));

    expect(mocks.invoke).toHaveBeenCalledTimes(events);
    expect(mocks.invoke).toHaveBeenCalledWith('write_session', {
      sessionId: 'contract-input',
      data: 'x',
    });
    expect(mocks.debug).toHaveBeenCalledTimes(events * 2);
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
