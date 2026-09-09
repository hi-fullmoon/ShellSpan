import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalRegistry, type TerminalOutputFilter } from '@/components/terminal/registry/terminal-registry';
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

afterEach(() => vi.restoreAllMocks());

describe('readTerminalCurrentDirectory', () => {
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
