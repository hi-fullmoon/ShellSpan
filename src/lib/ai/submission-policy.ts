import type { AiSessionKind, AiSessionStatus } from './conversation-node';
import type { AiSubmissionMode } from './session-adapter';

export type AiBusyPreference = 'queue' | 'steer';

export type AiSubmissionRejection =
  | 'empty'
  | 'submitting'
  | 'waitingApproval'
  | 'terminal'
  | 'providerUnavailable'
  | 'sessionUnavailable'
  | 'busyUnsupported';

export type AiSubmissionDecision =
  | Readonly<{ kind: 'submit'; mode: AiSubmissionMode }>
  | Readonly<{ kind: 'stop' }>
  | Readonly<{ kind: 'reject'; reason: AiSubmissionRejection }>;

export interface AiSubmissionPolicyInput {
  readonly sessionKind: AiSessionKind;
  readonly sessionStatus: AiSessionStatus;
  readonly terminal: boolean;
  readonly sessionId: string | null;
  readonly waitingApproval: boolean;
  readonly hasProvider: boolean;
  readonly canCreateSession: boolean;
  readonly draft: string;
  readonly gesture: 'keyboard' | 'primary' | 'retry';
  readonly accelerated: boolean;
  readonly preferredBusyMode: AiBusyPreference;
  readonly submitting: boolean;
}

function opposite(mode: AiBusyPreference): AiBusyPreference {
  return mode === 'queue' ? 'steer' : 'queue';
}

/** Resolve one Composer gesture without reading React, stores, or Runtime state. */
export function resolveAiSubmission(input: AiSubmissionPolicyInput): AiSubmissionDecision {
  const empty = input.draft.trim().length === 0;
  const running = input.sessionStatus === 'running' || input.sessionStatus === 'waiting';

  if (input.submitting) return { kind: 'reject', reason: 'submitting' };
  if (input.waitingApproval) return { kind: 'reject', reason: 'waitingApproval' };
  if (running && empty && input.gesture === 'primary') return { kind: 'stop' };
  if (empty) return { kind: 'reject', reason: 'empty' };
  if (input.terminal) return { kind: 'reject', reason: 'terminal' };
  if (!input.hasProvider) return { kind: 'reject', reason: 'providerUnavailable' };

  if (running) {
    // Ask has cancellation while streaming, but no durable Queue/Steer lane.
    if (input.sessionKind === 'ask') return { kind: 'reject', reason: 'busyUnsupported' };
    if (input.sessionId === null) return { kind: 'reject', reason: 'sessionUnavailable' };
    const busyMode = input.accelerated
      ? opposite(input.preferredBusyMode)
      : input.preferredBusyMode;
    return { kind: 'submit', mode: busyMode === 'queue' ? 'nextTurn' : 'nextStep' };
  }

  if (input.sessionId === null && !input.canCreateSession) {
    return { kind: 'reject', reason: 'sessionUnavailable' };
  }
  return { kind: 'submit', mode: input.sessionId === null ? 'start' : 'nextTurn' };
}
