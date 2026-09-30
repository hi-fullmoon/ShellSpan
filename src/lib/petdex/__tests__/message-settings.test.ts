import { describe, expect, it } from 'vitest';
import { newestMessageDiagnostic, type PetdexMessageDiagnostic, type PetdexSettings } from '../messages';
import { isPetdexConfigurationResult, isPetdexMessageDiagnostic, isPetdexMessageTestResult } from '../diagnostic-validators';
import { normalizePetdexMessagePreferences } from '../message-preferences';
import { resolvePetdexSettings } from '../preferences';

const settings: PetdexSettings = { enabled: false, categories: { ssh: true, sftp: true, ai: false }, petdexMessagesEnabled: false, petdexMessageDetailsEnabled: false, locale: 'zh-CN' };
const diagnostic: PetdexMessageDiagnostic = { revision: 2, status: 'disabled', errorReason: null, acceptedCount: 0, lastAcceptedAt: null, usedSlotCount: 0, unsupported: false, cleanupOutcome: 'unconfirmed' };

describe('message configuration contracts', () => {
  it('keeps legacy and malformed preferences disabled and composes sparse patches against confirmation', () => {
    for (const value of [undefined, {}, { petdexEnabled: true }, { petdexMessagesEnabled: 'true' }]) {
      expect(normalizePetdexMessagePreferences(value)).toEqual({ petdexMessagesEnabled: false, petdexMessageDetailsEnabled: false });
    }
    const enabled = resolvePetdexSettings(settings, { petdexMessagesEnabled: true });
    expect(resolvePetdexSettings(enabled, { categories: { ai: true }, locale: 'en-US' })).toEqual({ ...enabled, categories: { ssh: true, sftp: true, ai: true }, locale: 'en-US' });
    expect(resolvePetdexSettings(settings, { petdexMessageDetailsEnabled: true }).petdexMessagesEnabled).toBe(false);
  });
  it('rejects delayed diagnostic snapshots including older close outcomes', () => {
    expect(newestMessageDiagnostic(diagnostic, { ...diagnostic, revision: 1, cleanupOutcome: 'accepted' })).toBe(diagnostic);
    expect(newestMessageDiagnostic(diagnostic, { ...diagnostic, revision: 2, status: 'ready' })).toBe(diagnostic);
    expect(newestMessageDiagnostic(diagnostic, { ...diagnostic, revision: 3 }).revision).toBe(3);
  });
  it('decodes effective disabled configuration even when settlement is unconfirmed', () => {
    expect(isPetdexConfigurationResult({ effective: settings, diagnostic: { revision: 1, status: 'disabled', errorReason: null, targetAction: null, lastSuccessAt: null }, messageDiagnostic: diagnostic, cleanupOutcome: 'unconfirmed' })).toBe(true);
    expect(isPetdexMessageTestResult({ diagnostic, outcome: 'accepted' })).toBe(true);
    expect(isPetdexMessageTestResult({ diagnostic, outcome: 'displayed' })).toBe(false);
    for (const extra of [{ text: 'forbidden' }, { token: 'forbidden' }, { conversationKey: 'forbidden' }, { usedSlotCount: 4 }, { revision: -1 }]) {
      expect(isPetdexMessageDiagnostic({ ...diagnostic, ...extra })).toBe(false);
    }
  });
});
