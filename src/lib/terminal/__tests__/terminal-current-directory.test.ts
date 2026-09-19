import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalRegistry, type TerminalOutputFilter } from '@/components/terminal/registry/terminal-registry';
import { invokeGetTerminalBrokerSnapshot } from '@/lib/ipc/tauri';
import { readTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';
import type { TerminalSession } from '@/stores/terminalStore';

const session: TerminalSession = {
  sessionId: 'terminal-current-directory',
  title: 'Remote',
  host: 'example.test',
  port: 22,
  username: 'tester',
  status: 'connected',
};

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetTerminalBrokerSnapshot: vi.fn().mockResolvedValue({ session: null }),
}));

afterEach(() => vi.restoreAllMocks());

describe('readTerminalCurrentDirectory', () => {
  it('uses the integrated prompt directory without injecting input into local PowerShell', async () => {
    const controller = {
      hasPendingUserInput: vi.fn(() => false),
      hasUnverifiedUserSubmission: vi.fn(() => false),
      whenOutputReady: vi.fn(async () => undefined),
      writeInput: vi.fn(),
      subscribeOutputFilter: vi.fn(),
    };
    vi.spyOn(terminalRegistry, 'get').mockReturnValue(controller as never);
    vi.mocked(invokeGetTerminalBrokerSnapshot).mockResolvedValueOnce({
      session: { promptReady: true, currentDirectory: 'C:\\Users\\tester' },
    } as Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>);

    await expect(readTerminalCurrentDirectory({ ...session, host: 'local', port: 0 }))
      .resolves.toBe('C:\\Users\\tester');
    expect(controller.writeInput).not.toHaveBeenCalled();
    expect(controller.subscribeOutputFilter).not.toHaveBeenCalled();
  });

  it('does not inject a local probe while shell integration is unavailable', async () => {
    const controller = {
      hasPendingUserInput: vi.fn(() => false),
      hasUnverifiedUserSubmission: vi.fn(() => false),
      whenOutputReady: vi.fn(async () => undefined),
      writeInput: vi.fn(),
    };
    vi.spyOn(terminalRegistry, 'get').mockReturnValue(controller as never);

    await expect(readTerminalCurrentDirectory({ ...session, host: 'local', port: 0 }))
      .resolves.toBeNull();
    expect(controller.writeInput).not.toHaveBeenCalled();
  });
  it('reads a UTF-8 directory from the interactive shell and hides the probe output', async () => {
    let filter!: TerminalOutputFilter;
    let visible = '';
    const releaseInput = vi.fn();
    const removeFilter = vi.fn(() => { visible += filter.finish(); });
    const controller = {
      hasPendingUserInput: vi.fn(() => false),
      hasUnverifiedUserSubmission: vi.fn(() => false),
      whenOutputReady: vi.fn(async () => undefined),
      suppressUserInput: vi.fn(() => releaseInput),
      subscribeOutputFilter: vi.fn((value: TerminalOutputFilter) => { filter = value; return removeFilter; }),
      writeInput: vi.fn(async (command: string) => {
        const token = command.match(/shellspan-cwd:([a-f0-9]+):/)?.[1];
        expect(token).toBeTruthy();
        const encoded = btoa(unescape(encodeURIComponent('/srv/项目')));
        visible += filter.push(`echoed probe\r\n\u001b]777;shellspan-cwd:${token}:${encoded}\u0007prompt`);
      }),
    };
    vi.spyOn(terminalRegistry, 'get').mockReturnValue(controller as never);

    await expect(readTerminalCurrentDirectory(session)).resolves.toBe('/srv/项目');
    expect(visible).toBe('');
    expect(controller.writeInput).toHaveBeenCalledWith(expect.stringContaining("python3 -c"));
    expect(removeFilter).toHaveBeenCalledOnce();
    expect(releaseInput).toHaveBeenCalledOnce();
  });

  it('does not disturb a partially typed terminal command', async () => {
    const controller = {
      hasPendingUserInput: vi.fn(() => true),
      hasUnverifiedUserSubmission: vi.fn(() => false),
    };
    vi.spyOn(terminalRegistry, 'get').mockReturnValue(controller as never);

    await expect(readTerminalCurrentDirectory(session)).resolves.toBeNull();
    expect(controller.hasPendingUserInput).toHaveBeenCalledOnce();
  });
});
