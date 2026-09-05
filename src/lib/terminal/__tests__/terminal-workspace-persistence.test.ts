import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTerminalWorkspace,
  flushTerminalWorkspace,
  stageTerminalWorkspace,
} from '@/lib/terminal/terminal-workspace-persistence';
import {
  invokeClearTerminalWorkspace,
  invokeSaveTerminalWorkspace,
} from '@/lib/ipc/tauri';

vi.mock('@/lib/ipc/tauri', () => ({
  invokeClearTerminalWorkspace: vi.fn().mockResolvedValue(undefined),
  invokeSaveTerminalWorkspace: vi.fn().mockResolvedValue(undefined),
}));

describe('terminal workspace persistence', () => {
  beforeEach(async () => {
    await clearTerminalWorkspace();
    vi.clearAllMocks();
  });

  it('flushes only the latest staged snapshot', async () => {
    stageTerminalWorkspace('first');
    stageTerminalWorkspace('latest');

    await flushTerminalWorkspace();

    expect(invokeSaveTerminalWorkspace).toHaveBeenCalledTimes(1);
    expect(invokeSaveTerminalWorkspace).toHaveBeenCalledWith('latest');
  });

  it('serializes a final snapshot behind a save already in flight', async () => {
    let resolveFirstSave!: () => void;
    vi.mocked(invokeSaveTerminalWorkspace)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValue(undefined);
    stageTerminalWorkspace('first');
    const firstFlush = flushTerminalWorkspace();
    await vi.waitFor(() => expect(invokeSaveTerminalWorkspace).toHaveBeenCalledTimes(1));

    stageTerminalWorkspace('final');
    const finalFlush = flushTerminalWorkspace();
    expect(invokeSaveTerminalWorkspace).toHaveBeenCalledTimes(1);
    resolveFirstSave();
    await Promise.all([firstFlush, finalFlush]);

    expect(vi.mocked(invokeSaveTerminalWorkspace).mock.calls).toEqual([
      ['first'],
      ['final'],
    ]);
  });

  it('discards a pending snapshot when persistence is cleared', async () => {
    stageTerminalWorkspace('stale');
    await clearTerminalWorkspace();
    await flushTerminalWorkspace();

    expect(invokeClearTerminalWorkspace).toHaveBeenCalledTimes(1);
    expect(invokeSaveTerminalWorkspace).not.toHaveBeenCalled();
  });
});
