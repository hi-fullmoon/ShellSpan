import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { CommandSnippet } from '@/lib/terminal/snippet-template';
import { terminalRegistry } from '../registry/terminal-registry';
import { TerminalSnippetDialog } from '../terminal-snippet-dialog';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const snippet: CommandSnippet = {
  id: 's-1',
  name: 'SSH Connect',
  groupName: 'Ops',
  tags: ['ssh'],
  description: 'Connect to host',
  commandTemplate: 'ssh {{user}}@{{host}} -p {{port:22}}',
  createdAt: 1,
  updatedAt: 1,
};

const originalApp = useAppStore.getState();
const originalTerminal = useTerminalStore.getState();

describe('TerminalSnippetDialog', () => {
  const writeUserInput = vi.fn().mockResolvedValue(true);
  const focus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ activeSection: 'workbench' });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'term-1',
        title: 'Local',
        host: 'local',
        port: 0,
        username: 'dev',
        status: 'connected',
      }],
      activeSessionId: 'term-1',
    });
    vi.spyOn(terminalRegistry, 'get').mockReturnValue({
      terminal: { buffer: { active: { type: 'normal' } } },
      hasPendingUserInput: () => false,
      hasUnverifiedUserSubmission: () => false,
      writeUserInput,
      focus,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState(originalApp, true);
    useTerminalStore.setState(originalTerminal, true);
  });

  it('uses CompactDialogBody, outline cancel button, and live preview with default parameter values', () => {
    render(<TerminalSnippetDialog snippet={snippet} sessionId="term-1" close={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.overflow-y-auto.overscroll-contain')).toBeInTheDocument();
    expect(dialog.querySelector('[data-slot="scroll-area"]')).toBeNull();
    expect(screen.getByLabelText('port')).toHaveValue('22');
    expect(dialog.querySelector('pre')).toHaveTextContent('ssh {{user}}@{{host}} -p {{port:22}}');

    const cancel = screen.getByRole('button', { name: 'common.cancel' });
    expect(cancel).toHaveAttribute('data-variant', 'outline');
  });

  it('submits the form via Enter to insert without newline and supports Insert and Execute', async () => {
    const close = vi.fn();
    render(<TerminalSnippetDialog snippet={snippet} sessionId="term-1" close={close} />);

    const userInput = screen.getByLabelText('user');
    await userEvent.type(userInput, 'deploy');
    await userEvent.type(screen.getByLabelText('host'), 'prod.internal');

    const pre = screen.getByRole('dialog').querySelector('pre');
    expect(pre).toHaveTextContent('ssh deploy@prod.internal -p 22');

    fireEvent.submit(userInput.closest('form')!);
    await waitFor(() => expect(writeUserInput).toHaveBeenCalledWith('ssh deploy@prod.internal -p 22'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().activeSection).toBe('terminal');

    writeUserInput.mockClear();
    close.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'terminal.snippets.execute' }));
    await waitFor(() => expect(writeUserInput).toHaveBeenCalledWith('ssh deploy@prod.internal -p 22\r'));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
