import { describe, expect, it } from 'vitest';
import { acceptPetdexDiagnostic, INITIAL_PETDEX_DIAGNOSTIC_VIEW, isPetdexDiagnostic, isPetdexTestResult, petdexDiagnosticStatus, reducePetdexDiagnosticView, PETDEX_STATUS_LABEL_KEYS, PETDEX_PREVIEW_LABEL_KEYS } from '../diagnostic';
import type { PetdexDiagnostic } from '@/types';
import zhCN from '@/locales/zh-CN';
import enUS from '@/locales/en-US';
import { isPetdexCheckResult } from '../diagnostic';

describe('Petdex diagnostic state', () => {
  const initial: PetdexDiagnostic = {
    revision: 0, status: 'disabled', errorReason: null, targetAction: null, lastSuccessAt: null,
  };

  it('keeps health separate from authentication and accepts only the finite contract', () => {
    for (const health of ['reachable', 'unavailable', 'disabled']) {
      expect(isPetdexCheckResult({ diagnostic: initial, health })).toBe(true);
    }
    expect(isPetdexCheckResult({ diagnostic: initial, health: 'authenticated' })).toBe(false);
    expect(isPetdexCheckResult({ diagnostic: initial, health: 'reachable', response: 'raw' })).toBe(false);
    for (const status of Object.keys(PETDEX_STATUS_LABEL_KEYS)) {
      const key = `settings.experimental.petdex.advice.${status}` as keyof typeof zhCN;
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
    }
  });

  it('accepts the initial revision, then only strictly newer revisions regardless of arrival order', () => {
    let current = acceptPetdexDiagnostic(null, initial);
    expect(current).toBe(initial);
    for (const revision of [4, 1, 3, 4, 2, 5, 0]) {
      const previous = current;
      const incoming = { ...initial, revision };
      current = acceptPetdexDiagnostic(current, incoming);
      expect(current.revision).toBe(Math.max(previous.revision, revision));
      expect(current).toBe(revision > previous.revision ? incoming : previous);
    }
  });

  it('validates preview outcomes and provides bilingual feedback without asserting visible animation', () => {
    for (const [preview, key] of Object.entries(PETDEX_PREVIEW_LABEL_KEYS)) {
      expect(isPetdexTestResult({ diagnostic: initial, preview })).toBe(true);
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).not.toBe(preview);
      expect(enUS[key]).not.toBe(preview);
    }
    expect(isPetdexTestResult(initial)).toBe(false);
    expect(isPetdexTestResult({ diagnostic: initial, preview: 'displayed' })).toBe(false);
    expect(isPetdexTestResult({ diagnostic: { ...initial, revision: -1 }, preview: 'requested' })).toBe(false);
    expect(isPetdexTestResult({ diagnostic: initial, preview: 'requested', token: 'extra' })).toBe(false);
    expect(zhCN[PETDEX_PREVIEW_LABEL_KEYS.overridden]).toContain('覆盖');
    expect(enUS[PETDEX_PREVIEW_LABEL_KEYS.overridden]).toContain('overrides');
  });

  it('rejects unsafe revisions, timestamps, free text and unexpected diagnostic fields', () => {
    for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isPetdexDiagnostic({ ...initial, revision })).toBe(false);
    }
    expect(isPetdexDiagnostic({ ...initial, lastSuccessAt: -1 })).toBe(false);
    expect(isPetdexDiagnostic({ ...initial, errorReason: 'unknown' })).toBe(false);
    expect(isPetdexDiagnostic({ ...initial, targetAction: 'unknown' })).toBe(false);
    expect(isPetdexDiagnostic({ ...initial, detail: 'not part of the contract' })).toBe(false);
  });

  it('recovers a read failure from a valid command reply, including an unchanged revision', () => {
    let view = reducePetdexDiagnosticView(INITIAL_PETDEX_DIAGNOSTIC_VIEW, { type: 'readFailed' });
    expect(petdexDiagnosticStatus(view)).toBe('connectionError');
    view = reducePetdexDiagnosticView(view, { type: 'snapshot', snapshot: initial });
    expect(petdexDiagnosticStatus(view)).toBe('disabled');
    view = reducePetdexDiagnosticView(view, { type: 'readFailed' });
    view = reducePetdexDiagnosticView(view, { type: 'snapshot', snapshot: initial });
    expect(petdexDiagnosticStatus(view)).toBe('disabled');
    const connected = { ...initial, revision: 2, status: 'connected' } as const;
    view = reducePetdexDiagnosticView(view, { type: 'snapshot', snapshot: connected });
    const failed = reducePetdexDiagnosticView(view, { type: 'readFailed' });
    expect(reducePetdexDiagnosticView(failed, { type: 'snapshot', snapshot: initial })).toBe(failed);
  });

  it('keeps subscription health separate from successful communication and clears it after resubscription', () => {
    let view = reducePetdexDiagnosticView(INITIAL_PETDEX_DIAGNOSTIC_VIEW, { type: 'subscription', failed: true });
    view = reducePetdexDiagnosticView(view, { type: 'readFailed' });
    view = reducePetdexDiagnosticView(view, {
      type: 'snapshot', snapshot: { ...initial, revision: 1, status: 'connected' },
    });
    expect(petdexDiagnosticStatus(view)).toBe('connected');
    expect(view.subscriptionFailed).toBe(true);
    view = reducePetdexDiagnosticView(view, { type: 'subscription', failed: false });
    expect(petdexDiagnosticStatus(view)).toBe('connected');
    expect(view.subscriptionFailed).toBe(false);
  });

  it('provides readable bilingual labels for every finite status without claiming an unreachable service is stopped', () => {
    for (const [status, key] of Object.entries(PETDEX_STATUS_LABEL_KEYS)) {
      expect(isPetdexDiagnostic({ ...initial, status })).toBe(true);
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).not.toBe(status);
      expect(enUS[key]).not.toBe(status);
    }
    expect(zhCN[PETDEX_STATUS_LABEL_KEYS.unreachable]).toBe('无法连接');
    expect(enUS[PETDEX_STATUS_LABEL_KEYS.unreachable]).toBe('Unable to connect');
  });
});
