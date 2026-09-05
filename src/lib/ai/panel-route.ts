import type { AiSessionKind } from './conversation-node';

export type AiPanelRoute =
  | Readonly<{ kind: 'conversation'; sessionId: string | null }>
  | Readonly<{ kind: 'sessions' }>
  | Readonly<{ kind: 'toolDetails'; sessionId: string; nodeKey: string }>
  | Readonly<{ kind: 'artifactDetails'; sessionId: string; artifactId: string }>;

export interface AiScrollAnchor {
  readonly nodeKey: string;
  readonly offset: number;
  readonly scrollTop: number;
  readonly atBottom?: boolean;
}

export interface AiRouteReturnFocus {
  readonly sessionId: string;
  readonly nodeKey: string;
}

export interface AiWorkspaceNavigationState {
  readonly route: AiPanelRoute;
  readonly scrollAnchorBySession: Readonly<Record<string, AiScrollAnchor | undefined>>;
  readonly returnFocus: AiRouteReturnFocus | null;
}

export function createAiWorkspaceNavigationState(
  sessionId: string | null = null,
): AiWorkspaceNavigationState {
  return {
    route: { kind: 'conversation', sessionId },
    scrollAnchorBySession: {},
    returnFocus: null,
  };
}

export function sessionRouteKey(kind: AiSessionKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}
