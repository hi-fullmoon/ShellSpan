import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture = process.env.SHELLSPAN_STAGE2_HOUR_FIXTURE;
describe.skipIf(!fixture)('actual original Runtime one-hour authorization evidence', () => {
  const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(resolve(fixture!), 'fixture', name), 'utf8')) as Record<string, unknown>;
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Actual recorded object required');
    return value as Record<string, unknown>;
  };
  it('observes the full real lifetime in the same process and removes expired read access', () => {
    const initial = read('hour-initial.json');
    const expired = read('hour-expired.json');
    const before = object(initial.authorization);
    const after = object(expired.authorization);
    expect(before.state).toBe('active');
    expect(expired.pid).toBe(initial.pid);
    expect(Number(before.expiresAtUnixMs) - Number(initial.auditAtUnixMs)).toBeGreaterThanOrEqual(3_599_000);
    expect(Number(expired.monotonicElapsedMs) + Number(expired.grantAgeAtObserverStartMs)).toBeGreaterThanOrEqual(3_599_000);
    expect(Number(after.checkedAtUnixMs)).toBeGreaterThanOrEqual(Number(before.expiresAtUnixMs));
    expect(after.state).toBe('expired');
    expect(after.readPaths).toEqual([]);
    expect(expired.passed).toBe(true);
  });
  it('requires a new real once approval and a confirmed native result after expiry', () => {
    const report = read('hour-acceptance.json');
    expect(report.freshOnceResourceApproval).toBe(true);
    expect(report.freshNativeTerminal).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.stage3Allowed).toBe(false);
  });
});
