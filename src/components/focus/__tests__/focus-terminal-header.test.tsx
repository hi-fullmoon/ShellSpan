import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '@/locales';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useFocusStore } from '@/stores/focusStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { FocusTerminalHeader } from '../focus-terminal-header';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  useFocusStore.setState({
    enabled: false,
    hasOpened: false,
    terminalOpen: true,
    targetSessionId: null,
    conversationSessionId: null,
    busy: false,
  });
  useTerminalStore.setState({
    sessions: [],
    activeSessionId: null,
  });
});

describe('FocusTerminalHeader', () => {
  it('uses the link icon for the set-target action and switches the focus target on click', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'root',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
    });
    useTerminalStore.getState().addSession({
      sessionId: 's2',
      title: 'local',
      host: 'localhost',
      port: 0,
      username: 'user',
    });
    useTerminalStore.getState().setStatus('s1', { sessionId: 's1', status: 'connected' });
    useTerminalStore.getState().setStatus('s2', { sessionId: 's2', status: 'connected' });
    useTerminalStore.getState().setActiveSession('s2');
    useFocusStore.setState({
      enabled: true,
      hasOpened: true,
      terminalOpen: true,
      targetSessionId: 's1',
      busy: false,
    });

    render(
      <TooltipProvider>
        <FocusTerminalHeader />
      </TooltipProvider>,
    );

    const nonTargetBadge = screen.getByText('非 Agent 目标');
    expect(nonTargetBadge).toHaveClass('text-muted-foreground');
    expect(nonTargetBadge).not.toHaveClass('text-app-success');

    const setTargetButton = screen.getByRole('button', { name: '设为 Agent 目标' });
    expect(setTargetButton.querySelector('svg.lucide-link-2')).not.toBeNull();
    expect(setTargetButton.querySelector('svg.lucide-target')).toBeNull();

    fireEvent.click(setTargetButton);
    expect(useFocusStore.getState().targetSessionId).toBe('s2');

    const targetBadge = screen.getByText('Agent 目标');
    expect(targetBadge).toHaveClass('bg-app-success/10', 'text-app-success');
    expect(screen.queryByText('非 Agent 目标')).toBeNull();
  });

  it('does not show a target status badge when no terminal is open', () => {
    useFocusStore.setState({
      enabled: true,
      hasOpened: true,
      terminalOpen: true,
      targetSessionId: null,
      busy: false,
    });

    render(
      <TooltipProvider>
        <FocusTerminalHeader />
      </TooltipProvider>,
    );

    expect(screen.queryByText('Agent 目标')).toBeNull();
    expect(screen.queryByText('非 Agent 目标')).toBeNull();
  });
});
