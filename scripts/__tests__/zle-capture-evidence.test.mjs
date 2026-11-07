import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateZleCapture } from '../native-input-p3/zle-capture-evidence.mjs';

const directory = resolve(import.meta.dirname, 'fixtures/zle-guards-native-20261106');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
const observations = manifest.records.map(record => {
  const bytes = readFileSync(resolve(directory, record.file));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
  return JSON.parse(bytes);
});

describe('actual ZLE capture evidence validation', () => {
  it('accepts all eleven byte-preserved native guard receipts, including the expanded namespace cases', () => {
    expect(evaluateZleCapture('guards', observations)).toMatchObject({ ok: true, expectedCases: 11, missing: [], duplicates: [], unexpected: [] });
  });
  it('rejects the obsolete five-case subset of the actual native results', () => {
    const partial = observations.filter(value => ['function', 'alias', 'global-alias', 'widget', 'chord'].includes(value.kind));
    expect(partial).toHaveLength(5);
    expect(evaluateZleCapture('guards', partial)).toMatchObject({ ok: false, expectedCases: 11 });
  });
  it('rejects a repeated actual receipt replacing a distinct guard despite the total remaining eleven', () => {
    const [removed, ...remaining] = observations;
    const result = evaluateZleCapture('guards', [...remaining, remaining[0]]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(removed.kind);
    expect(result.duplicates).toContain(remaining[0].kind);
  });
  it('does not accept native guard receipts as EOF or geometry evidence', () => {
    expect(evaluateZleCapture('eof', observations).ok).toBe(false);
    expect(evaluateZleCapture('geometry', observations).ok).toBe(false);
  });
});
