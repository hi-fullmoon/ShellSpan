import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PETDEX_PHASE3_LEDGER,
  DEFAULT_PETDEX_PHASE3_SCHEMA,
  evaluatePetdexPhase3Ledger,
} from '../petdex-phase3-gate.mjs';
import {
  DEFAULT_PETDEX_PHASE4_ASSESSMENT,
  DEFAULT_PETDEX_PHASE4_RECORD,
  DEFAULT_PETDEX_ROADMAP,
  evaluatePetdexPhase4Admission,
  readPhase4DocumentMarkers,
} from '../petdex-phase4-admission-gate.mjs';

const schema = JSON.parse(readFileSync(DEFAULT_PETDEX_PHASE3_SCHEMA, 'utf8'));
const ledger = JSON.parse(readFileSync(DEFAULT_PETDEX_PHASE3_LEDGER, 'utf8'));
const record = JSON.parse(readFileSync(DEFAULT_PETDEX_PHASE4_RECORD, 'utf8'));
const phase3Result = evaluatePetdexPhase3Ledger(ledger, schema, {
  asOf: record.phase3Gate.asOf,
});
const currentMarkers = [
  readPhase4DocumentMarkers(
    readFileSync(DEFAULT_PETDEX_PHASE4_ASSESSMENT, 'utf8'),
    'assessment',
  ),
  readPhase4DocumentMarkers(readFileSync(DEFAULT_PETDEX_ROADMAP, 'utf8'), 'roadmap'),
];

describe('Petdex Phase 4 admission audit', () => {
  it('accepts the current blocked record as internally consistent, not admitted', () => {
    const result = evaluatePetdexPhase4Admission(record, phase3Result, currentMarkers);

    expect(phase3Result.status).toBe('collecting');
    expect(result.status).toBe('consistent');
    expect(result.decision).toBe('blocked');
    expect(result.implementationAuthorized).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('rejects an admitted claim while the real Phase 3 gate is not pass', () => {
    const misclaimed = structuredClone(record);
    misclaimed.decision = 'admitted';
    misclaimed.implementationAuthorized = true;
    misclaimed.criteria[0].status = 'met';
    misclaimed.criteria[0].gaps = [];
    const admittedMarkers = currentMarkers.map((markers) => ({
      ...markers,
      decision: 'admitted',
      implementationAuthorized: true,
    }));

    const result = evaluatePetdexPhase4Admission(misclaimed, phase3Result, admittedMarkers);

    expect(result.status).toBe('invalid');
    expect(result.errors.map((item) => item.id)).toEqual(expect.arrayContaining([
      'record.criteria.phase3.real-user-gate.status',
      'record.decision.invariant',
      'record.implementationAuthorized.invariant',
    ]));
  });

  it('rejects a roadmap or assessment marker that disagrees with the record', () => {
    const mismatchedMarkers = structuredClone(currentMarkers);
    mismatchedMarkers[1].decision = 'admitted';

    const result = evaluatePetdexPhase4Admission(record, phase3Result, mismatchedMarkers);

    expect(result.status).toBe('invalid');
    expect(result.errors).toContainEqual(expect.objectContaining({
      id: 'document.roadmap.decision',
    }));
  });

  it('requires every admission criterion to have evidence and blocked gaps', () => {
    const incomplete = structuredClone(record);
    incomplete.criteria[1].evidence = [];
    incomplete.criteria[1].gaps = [];

    const result = evaluatePetdexPhase4Admission(incomplete, phase3Result, currentMarkers);

    expect(result.status).toBe('invalid');
    expect(result.errors.map((item) => item.id)).toEqual(expect.arrayContaining([
      'record.criteria.assets.machine-readable-rights.evidence',
      'record.criteria.assets.machine-readable-rights.gaps',
    ]));
  });
});
