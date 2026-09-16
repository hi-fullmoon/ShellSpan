import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentExecutionSurfaceSelector } from '../agent-execution-surface-selector';

const translations = vi.hoisted<Record<string, string>>(() => ({
  'agent.executionSurface': 'Command execution',
  'agent.executionSurface.switchHint': 'Switch when the terminal is connected and the Agent is idle.',
  'agent.executionSurface.v1.direct': 'Direct',
  'agent.executionSurface.v1.directDescription': 'Run reliably outside this terminal with structured output and exit status.',
  'agent.executionSurface.v1.visibleCommand': 'Visible command',
  'agent.executionSurface.v1.state.initializing': 'Initializing',
  'agent.executionSurface.v1.state.ready': 'Ready',
  'agent.executionSurface.v1.state.unavailable': 'Unavailable',
  'agent.executionSurface.v1.state.directFallback': 'Direct fallback',
  'agent.executionSurface.v1.initializingDescription': 'Real-terminal command support is initializing. Use Direct for now.',
  'agent.executionSurface.v1.readyDescription': 'Runs visibly with cooperative shell lifecycle. Use Direct for security-sensitive or untrusted code.',
  'agent.executionSurface.v1.unavailableDescription': 'Real-terminal command support is unavailable for this terminal. Choose Direct instead.',
  'agent.executionSurface.v1.directFallbackDescription': 'The runtime fell back to Direct because real-terminal command support could not be used.',
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
    ready: true,
    locale: 'en-US',
    setLocale: () => undefined,
  }),
}));

describe('AgentExecutionSurfaceSelector', () => {
  it.each([
    ['initializing', 'Initializing', 'Real-terminal command support is initializing. Use Direct for now.'],
    ['ready', 'Ready', 'Runs visibly with cooperative shell lifecycle. Use Direct for security-sensitive or untrusted code.'],
    ['unavailable', 'Unavailable', 'Real-terminal command support is unavailable for this terminal. Choose Direct instead.'],
  ] as const)(
    'presents the real-terminal %s state without changing the stored surface',
    async (state, stateLabel, description) => {
      const onSurfaceChange = vi.fn();
      render(
        <AgentExecutionSurfaceSelector
          surface="boundTerminal"
          realTerminalState={state}
          onSurfaceChange={onSurfaceChange}
        />,
      );

      const trigger = screen.getByRole('button', { name: 'Command execution: Visible command' });
      expect(trigger).toHaveAttribute('data-execution-surface', 'boundTerminal');
      expect(trigger).toHaveAttribute('data-terminal-surface-state', state);
      expect(trigger).toHaveAttribute('data-real-terminal-state', state);
      expect(trigger).toHaveAttribute('aria-description', description);

      await userEvent.click(trigger);
      const option = await screen.findByRole('menuitemradio', { name: 'Visible command' });
      expect(option).toHaveAttribute('aria-description', description);
      expect(option).toHaveTextContent(stateLabel);
      if (state === 'ready') expect(option).not.toHaveAttribute('aria-disabled');
      else expect(option).toHaveAttribute('aria-disabled', 'true');
      expect(onSurfaceChange).not.toHaveBeenCalled();
    },
  );

  it('keeps an ordinary Direct selection free of fallback presentation', async () => {
    render(
      <AgentExecutionSurfaceSelector surface="direct" realTerminalState="unavailable" />,
    );

    const trigger = screen.getByRole('button', { name: 'Command execution: Direct' });
    expect(trigger).toHaveAttribute('data-execution-surface', 'direct');
    expect(trigger).toHaveAttribute('data-terminal-surface-state', 'direct');
    expect(trigger).toHaveAttribute('data-real-terminal-state', 'unavailable');
    expect(trigger).toHaveAttribute(
      'aria-description',
      'Run reliably outside this terminal with structured output and exit status.',
    );

    await userEvent.click(trigger);
    const directOption = await screen.findByRole('menuitemradio', { name: 'Direct' });
    expect(directOption).toHaveAttribute(
      'aria-description',
      'Run reliably outside this terminal with structured output and exit status.',
    );
    expect(directOption).not.toHaveTextContent('Direct fallback');
    expect(directOption.querySelector('[data-slot="badge"]')).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Visible command' }))
      .toHaveTextContent('Unavailable');
    expect(screen.getByRole('menuitemradio', { name: 'Visible command' }))
      .toHaveAttribute('aria-disabled', 'true');
  });

  it('presents Direct fallback only with an explicit future runtime signal', async () => {
    render(
      <AgentExecutionSurfaceSelector
        surface="direct"
        realTerminalState="unavailable"
        runtimeFallback={{ kind: 'directFallback' }}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Command execution: Direct' });
    expect(trigger).toHaveAttribute('data-terminal-surface-state', 'directFallback');
    expect(trigger).toHaveAttribute('data-real-terminal-state', 'unavailable');
    expect(trigger).toHaveAttribute(
      'aria-description',
      'The runtime fell back to Direct because real-terminal command support could not be used.',
    );

    await userEvent.click(trigger);
    expect(await screen.findByRole('menuitemradio', { name: 'Direct' }))
      .toHaveTextContent('Direct fallback');
  });

  it('serializes choices with the existing direct and boundTerminal vocabulary', async () => {
    const user = userEvent.setup();
    const onSurfaceChange = vi.fn();
    const { rerender } = render(
      <AgentExecutionSurfaceSelector
        surface="direct"
        realTerminalState="ready"
        onSurfaceChange={onSurfaceChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Command execution: Direct' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Visible command' }));
    expect(onSurfaceChange).toHaveBeenLastCalledWith('boundTerminal');

    rerender(
      <AgentExecutionSurfaceSelector
        surface="boundTerminal"
        realTerminalState="ready"
        onSurfaceChange={onSurfaceChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Command execution: Visible command' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Direct' }));
    expect(onSurfaceChange).toHaveBeenLastCalledWith('direct');
  });

});
