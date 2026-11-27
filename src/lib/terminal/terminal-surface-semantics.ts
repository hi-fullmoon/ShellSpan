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

export interface RemoteGlibcMismatch {
  readonly actual: string;
  readonly minimum: string;
}

export function remoteGlibcMismatch(reason: string | undefined): RemoteGlibcMismatch | null {
  const match = /^remoteGlibcTooOld:(2\.\d{1,10}):(2\.\d{1,10})$/.exec(reason ?? '');
  return match ? { actual: match[1], minimum: match[2] } : null;
}

export type WindowsPowerShell7Unavailable =
  | { readonly kind: 'missing'; readonly minimum: string }
  | { readonly kind: 'tooOld'; readonly actual: string; readonly minimum: string }
  | { readonly kind: 'untrusted' };

export function windowsPowerShell7Unavailable(
  reason: string | undefined,
): WindowsPowerShell7Unavailable | null {
  if (!reason) return null;
  if (reason === 'windowsPowerShell7Untrusted') {
    return { kind: 'untrusted' };
  }
  const missing = /^windowsPowerShell7Missing:(\d+\.\d+\.\d+)$/.exec(reason);
  if (missing) {
    return { kind: 'missing', minimum: missing[1] };
  }
  const tooOld = /^windowsPowerShell7TooOld:([A-Za-z0-9._-]+):(\d+\.\d+\.\d+)$/.exec(reason);
  if (tooOld) {
    return { kind: 'tooOld', actual: tooOld[1], minimum: tooOld[2] };
  }
  return null;
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
