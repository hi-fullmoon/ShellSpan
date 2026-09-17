import { describe, expect, it } from 'vitest';

import {
  resolveTerminalSurfacePresentation,
  terminalConnectionPresentationState,
} from '../terminal-surface-semantics';

describe('terminal surface semantics', () => {
  it.each([
    ['connecting', 'initializing'],
    ['connected', 'unavailable'],
    ['disconnected', 'unavailable'],
    ['error', 'unavailable'],
    [undefined, 'unavailable'],
  ] as const)('maps terminal status %s to %s', (status, expected) => {
    expect(terminalConnectionPresentationState(status)).toBe(expected);
  });

  it('does not claim visible-command support without an authoritative ready state', () => {
    const current = terminalConnectionPresentationState('connected');
    expect(current).not.toBe('ready');
    expect(resolveTerminalSurfacePresentation('boundTerminal', current)).toEqual({
      state: 'unavailable',
      realTerminalState: 'unavailable',
    });
  });

  it.each(['initializing', 'ready', 'busy', 'unavailable'] as const)(
    'keeps an ordinary Direct selection ordinary while real-terminal state is %s',
    (realTerminalState) => {
      expect(resolveTerminalSurfacePresentation('direct', realTerminalState)).toEqual({
        state: 'direct',
        realTerminalState,
      });
    },
  );

  it('requires an explicit future runtime signal to present Direct fallback', () => {
    expect(resolveTerminalSurfacePresentation(
      'direct',
      'unavailable',
      { kind: 'directFallback' },
    )).toEqual({
      state: 'directFallback',
      realTerminalState: 'unavailable',
    });
  });
});
