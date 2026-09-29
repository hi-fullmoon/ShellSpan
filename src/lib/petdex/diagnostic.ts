import type { PetdexConnectionStatus, PetdexDiagnostic, PetdexPreviewOutcome } from '@/types';
import type { LocaleKey } from '@/locales';
// Ajv compiles at development time so native CSP never needs unsafe-eval.
export { isPetdexDiagnostic, isPetdexCheckResult, isPetdexTestResult } from './diagnostic-validators.js';

export const PETDEX_STATUS_LABEL_KEYS: Record<PetdexConnectionStatus, LocaleKey> = {
  disabled: 'settings.experimental.petdex.status.disabled',
  checking: 'settings.experimental.petdex.status.checking',
  notDetected: 'settings.experimental.petdex.status.notDetected',
  connected: 'settings.experimental.petdex.status.connected',
  unreachable: 'settings.experimental.petdex.status.unreachable',
  unauthorized: 'settings.experimental.petdex.status.unauthorized',
  rejected: 'settings.experimental.petdex.status.rejected',
  tokenUnreadable: 'settings.experimental.petdex.status.tokenUnreadable',
  tokenInvalid: 'settings.experimental.petdex.status.tokenInvalid',
  connectionError: 'settings.experimental.petdex.status.connectionError',
};

export const PETDEX_PREVIEW_LABEL_KEYS: Record<PetdexPreviewOutcome, LocaleKey> = {
  requested: 'settings.experimental.petdex.preview.requested',
  overridden: 'settings.experimental.petdex.preview.overridden',
  failed: 'settings.experimental.petdex.preview.failed',
  disabled: 'settings.experimental.petdex.preview.disabled',
};

/** Shared by reads, command replies and events: delivery order is not revision order. */
export function acceptPetdexDiagnostic(
  current: PetdexDiagnostic | null,
  incoming: PetdexDiagnostic,
): PetdexDiagnostic {
  return current === null || incoming.revision > current.revision ? incoming : current;
}

export interface PetdexDiagnosticView {
  snapshot: PetdexDiagnostic | null;
  readFailed: boolean;
  subscriptionFailed: boolean;
}

export const INITIAL_PETDEX_DIAGNOSTIC_VIEW: PetdexDiagnosticView = {
  snapshot: null, readFailed: false, subscriptionFailed: false,
};

export function petdexDiagnosticStatus(view: PetdexDiagnosticView): PetdexConnectionStatus {
  return view.readFailed ? 'connectionError' : view.snapshot?.status ?? 'checking';
}

type DiagnosticViewEvent =
  | { type: 'snapshot'; snapshot: PetdexDiagnostic }
  | { type: 'readFailed' }
  | { type: 'subscription'; failed: boolean };

export function reducePetdexDiagnosticView(
  current: PetdexDiagnosticView, event: DiagnosticViewEvent,
): PetdexDiagnosticView {
  if (event.type === 'readFailed') return { ...current, readFailed: true };
  if (event.type === 'subscription') return { ...current, subscriptionFailed: event.failed };
  if (current.snapshot && event.snapshot.revision < current.snapshot.revision) return current;
  return { ...current, snapshot: acceptPetdexDiagnostic(current.snapshot, event.snapshot), readFailed: false };
}
