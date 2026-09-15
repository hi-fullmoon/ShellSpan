import type { AgentExecutionSurface } from '@/types/agent-session';
import type { SessionStatus } from '@/types';

/**
 * Phase 1 has no general runtime feature service to evaluate presentation-only
 * flags. Keep this source default non-persisted and outside the Agent protocol:
 * changing it to false is the complete legacy-copy rollback.
 */
export const TERMINAL_SURFACE_SEMANTICS_V1 = {
  name: 'terminal_surface_semantics_v1',
  defaultEnabled: true,
  rollback: 'legacyCopyOnly',
} as const;

export type RealTerminalPresentationState =
  | 'initializing'
  | 'ready'
  | 'unavailable'
  | 'degraded';

export type TerminalSurfacePresentationState =
  | 'direct'
  | RealTerminalPresentationState
  | 'directFallback';

/** Reserved for a future authoritative runtime routing result. */
export interface TerminalSurfaceRuntimeFallbackSignal {
  readonly kind: 'directFallback';
}

export interface TerminalSurfacePresentation {
  /** Overall state shown for the currently selected execution surface. */
  readonly state: TerminalSurfacePresentationState;
  /** Capability state shown beside the real-terminal choice. */
  readonly realTerminalState: RealTerminalPresentationState;
}

export function terminalSurfaceSemanticsV1Enabled(override?: boolean): boolean {
  return override ?? TERMINAL_SURFACE_SEMANTICS_V1.defaultEnabled;
}

/**
 * Phase 1 intentionally classifies every connected legacy-wrapper terminal as
 * degraded. Only a later generation-bound cooperative integration signal may supply `ready`.
 */
export function legacyRealTerminalPresentationState(
  status: SessionStatus | undefined,
): Exclude<RealTerminalPresentationState, 'ready'> {
  switch (status) {
    case 'connecting':
      return 'initializing';
    case 'connected':
      return 'degraded';
    case 'disconnected':
    case 'error':
    case undefined:
      return 'unavailable';
  }
}

export function resolveTerminalSurfacePresentation(
  executionSurface: AgentExecutionSurface,
  realTerminalState: RealTerminalPresentationState,
  runtimeFallback?: TerminalSurfaceRuntimeFallbackSignal,
): TerminalSurfacePresentation {
  return {
    realTerminalState,
    state: runtimeFallback?.kind === 'directFallback'
      ? 'directFallback'
      : executionSurface === 'direct'
        ? 'direct'
        : realTerminalState,
  };
}
