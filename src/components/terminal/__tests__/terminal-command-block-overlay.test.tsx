import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { enableRealCanvas } from '@/tests/real-canvas';
import { createTerminalCommandBlocks, type TerminalCommandBlocks } from '@/lib/terminal/terminal-command-blocks';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useAppStore } from '@/stores/appStore';
import { TerminalCommandBlockOverlay } from '../terminal-command-block-overlay';

const trackerMocks = vi.hoisted(() => ({
  tracker: undefined as TerminalCommandBlocks | undefined,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => (
      values ? `${key}:${JSON.stringify(values)}` : key
    ),
  }),
}));

vi.mock('../terminal-command-activity', () => ({
  subscribeTerminalCommandTrackers: () => () => {},
  terminalCommandTracker: () => trackerMocks.tracker,
}));

const originalApp = useAppStore.getState();

describe('TerminalCommandBlockOverlay', () => {
  let host: HTMLDivElement;
  let terminal: Terminal;
  let tracker: TerminalCommandBlocks;

  beforeAll(enableRealCanvas);

  beforeEach(async () => {
    vi.clearAllMocks();
    useAppStore.setState({
      terminalColorScheme: 'catppuccinMocha',
      terminalColorOverrides: {},
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    terminal.open(host);
    const screenEl = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!;
    Object.defineProperty(screenEl, 'clientHeight', { configurable: true, value: 480 });
    tracker = createTerminalCommandBlocks(terminal);
    trackerMocks.tracker = tracker;
  });

  afterEach(() => {
    tracker.dispose();
    terminal.dispose();
    host.remove();
    useAppStore.setState(originalApp, true);
  });

  it('uses terminal theme contrast for the running indicator instead of bg-app-primary', async () => {
    await new Promise<void>((resolve) => {
      terminal.write('\u001b]133;A\u0007$ sleep 5\r\n\u001b]133;C;ShellSpan=1\u0007', resolve);
    });
    tracker.update({
      sessionId: 's1',
      terminalSessionId: 'ts1',
      terminalGeneration: 1,
      commandId: 1,
      phase: 'running',
      startedAt: 1,
      cwd: '/srv',
    });

    render(<TerminalCommandBlockOverlay terminal={terminal} sessionId="s1" />);

    const trigger = await screen.findByRole('button', { name: 'terminal.commandBlock.running' });
    const dot = trigger.querySelector('span') as HTMLElement;
    expect(dot).not.toHaveClass('bg-app-primary');
    expect(dot.style.backgroundColor).toBeTruthy();
  });

  it('copies command output with inline copied feedback and sends failed output to AI', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useAiDraftStore.setState({ terminalInsertions: {} });
    useAiPanelStore.setState({ panelOpenBySection: { terminal: false, workbench: false } });

    await new Promise<void>((resolve) => {
      terminal.write('\u001b]133;A\u0007$ cat missing\r\n\u001b]133;C;ShellSpan=2\u0007No such file\r\n\u001b]133;D;2;ShellSpan=2\u0007', resolve);
    });
    tracker.update({
      sessionId: 's1',
      terminalSessionId: 'ts1',
      terminalGeneration: 1,
      commandId: 2,
      phase: 'completed',
      startedAt: 1,
      exitCode: 2,
      durationMs: 250,
      cwd: '/srv',
    });

    render(<TerminalCommandBlockOverlay terminal={terminal} sessionId="s1" />);

    const trigger = await screen.findByRole('button', {
      name: 'terminal.commandBlock.result:{"code":2,"seconds":"0.3"}',
    });
    expect(trigger.querySelector('span')).toHaveClass('bg-destructive');

    await act(async () => {
      fireEvent.click(trigger);
    });

    const copyButton = await screen.findByRole('button', { name: 'terminal.commandBlock.copy' });
    const diagnoseButton = screen.getByRole('button', { name: 'terminal.commandBlock.diagnose' });
    expect(copyButton).toHaveAttribute('data-variant', 'outline');
    expect(diagnoseButton).toHaveAttribute('data-variant', 'default');
    await act(async () => {
      fireEvent.click(copyButton);
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('No such file'));
    expect(screen.getByRole('button', { name: 'common.copied' })).toBeInTheDocument();

    fireEvent.click(diagnoseButton);
    expect(useAiPanelStore.getState().panelOpenBySection.terminal).toBe(true);
    expect(useAiDraftStore.getState().terminalInsertions['terminal:s1']).toContain('No such file');
  });

  it('uses consistent outline buttons and a status indicator for succeeded commands', async () => {
    await new Promise<void>((resolve) => {
      terminal.write('\u001b]133;A\u0007$ echo ok\r\n\u001b]133;C;ShellSpan=3\u0007ok\r\n\u001b]133;D;0;ShellSpan=3\u0007', resolve);
    });
    tracker.update({
      sessionId: 's1',
      terminalSessionId: 'ts1',
      terminalGeneration: 1,
      commandId: 3,
      phase: 'completed',
      startedAt: 1,
      exitCode: 0,
      durationMs: 200,
      cwd: '/srv',
    });

    render(<TerminalCommandBlockOverlay terminal={terminal} sessionId="s1" />);

    const trigger = await screen.findByRole('button', {
      name: 'terminal.commandBlock.result:{"code":0,"seconds":"0.2"}',
    });
    await act(async () => {
      fireEvent.click(trigger);
    });

    const copyButton = await screen.findByRole('button', { name: 'terminal.commandBlock.copy' });
    const diagnoseButton = screen.getByRole('button', { name: 'terminal.commandBlock.diagnose' });
    expect(copyButton).toHaveAttribute('data-variant', 'outline');
    expect(diagnoseButton).toHaveAttribute('data-variant', 'outline');
    expect(copyButton.querySelector('svg')).toBeNull();
    expect(diagnoseButton.querySelector('svg')).toBeNull();

    const title = screen.getByText('terminal.commandBlock.result:{"code":0,"seconds":"0.2"}').closest('[data-slot="popover-title"]');
    expect(title).toHaveClass('tabular-nums', 'gap-1');
    expect(title?.querySelector('span[aria-hidden="true"]')).toHaveClass('bg-app-success');
  });
});
