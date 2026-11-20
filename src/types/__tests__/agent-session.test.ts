import { describe, expect, it } from 'vitest';
import {
  normalizeKillProcessResultState,
  type KillProcessResultState,
  type LegacyKillProcessResultState,
} from '../agent-session';

describe('normalizeKillProcessResultState', () => {
  it('accepts all canonical lowerCamelCase states unchanged', () => {
    const canonical: KillProcessResultState[] = [
      'terminationRequested',
      'terminated',
      'unknown',
      'running',
      'exited',
      'cancelled',
      'timedOut',
      'failed',
    ];
    for (const state of canonical) {
      expect(normalizeKillProcessResultState(state)).toBe(state);
    }
  });

  it('normalizes legacy PascalCase persisted states to lowerCamelCase', () => {
    const legacy: Record<LegacyKillProcessResultState, KillProcessResultState> = {
      Running: 'running',
      Exited: 'exited',
      Cancelled: 'cancelled',
      TimedOut: 'timedOut',
      Failed: 'failed',
    };
    for (const [raw, expected] of Object.entries(legacy)) {
      expect(normalizeKillProcessResultState(raw)).toBe(expected);
    }
  });

  it('returns undefined for unrecognized state values', () => {
    expect(normalizeKillProcessResultState('')).toBeUndefined();
    expect(normalizeKillProcessResultState('terminatedRequested')).toBeUndefined();
    expect(normalizeKillProcessResultState('EXITED')).toBeUndefined();
    expect(normalizeKillProcessResultState('toString')).toBeUndefined();
    expect(normalizeKillProcessResultState('constructor')).toBeUndefined();
    expect(normalizeKillProcessResultState('__proto__')).toBeUndefined();
    expect(normalizeKillProcessResultState('hasOwnProperty')).toBeUndefined();
  });
});
