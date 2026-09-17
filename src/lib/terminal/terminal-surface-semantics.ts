import type { AgentExecutionSurface } from '@/types/agent-session';
import type { SessionStatus } from '@/types';

export type RealTerminalPresentationState =
  | 'initializing'
  | 'ready'
  | 'busy'
  | 'unavailable';

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

/**
 * A connected terminal without cooperative integration does not support visible
 * commands. Unsupported terminals are presented as unavailable.
 */
export function terminalConnectionPresentationState(
  status: SessionStatus | undefined,
): Exclude<RealTerminalPresentationState, 'ready' | 'busy'> {
  switch (status) {
    case 'connecting':
      return 'initializing';
    case 'connected':
      return 'unavailable';
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
