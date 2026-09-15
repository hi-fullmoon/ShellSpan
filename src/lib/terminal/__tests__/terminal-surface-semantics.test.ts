import { describe, expect, it } from 'vitest';

import {
  legacyRealTerminalPresentationState,
  resolveTerminalSurfacePresentation,
  TERMINAL_SURFACE_SEMANTICS_V1,
  terminalSurfaceSemanticsV1Enabled,
} from '../terminal-surface-semantics';

describe('terminal_surface_semantics_v1', () => {
  it('defaults on with presentation-only legacy-copy rollback semantics', () => {
    expect(TERMINAL_SURFACE_SEMANTICS_V1).toEqual({
      name: 'terminal_surface_semantics_v1',
      defaultEnabled: true,
      rollback: 'legacyCopyOnly',
    });
    expect(terminalSurfaceSemanticsV1Enabled()).toBe(true);
    expect(terminalSurfaceSemanticsV1Enabled(false)).toBe(false);
  });

  it.each([
    ['connecting', 'initializing'],
    ['connected', 'degraded'],
    ['disconnected', 'unavailable'],
    ['error', 'unavailable'],
    [undefined, 'unavailable'],
  ] as const)('maps the legacy terminal status %s to %s', (status, expected) => {
    expect(legacyRealTerminalPresentationState(status)).toBe(expected);
  });

  it('never promotes the legacy connected path to real-terminal ready', () => {
    const current = legacyRealTerminalPresentationState('connected');
    expect(current).not.toBe('ready');
    expect(resolveTerminalSurfacePresentation('boundTerminal', current)).toEqual({
      state: 'degraded',
      realTerminalState: 'degraded',
    });
  });

  it.each(['initializing', 'ready', 'unavailable', 'degraded'] as const)(
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
