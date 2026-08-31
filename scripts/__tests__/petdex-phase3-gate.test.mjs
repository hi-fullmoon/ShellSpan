import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PETDEX_PHASE3_LEDGER,
  DEFAULT_PETDEX_PHASE3_SCHEMA,
  evaluatePetdexPhase3Ledger,
} from '../petdex-phase3-gate.mjs';

const schema = JSON.parse(readFileSync(DEFAULT_PETDEX_PHASE3_SCHEMA, 'utf8'));
const initialLedger = JSON.parse(readFileSync(DEFAULT_PETDEX_PHASE3_LEDGER, 'utf8'));

function passingLedger() {
  return {
    ...structuredClone(initialLedger),
    observation: {
      startedOn: '2026-08-28',
      plannedEndOn: '2026-09-11',
      endedOn: '2026-09-11',
    },
    recruitment: {
      consent: 'explicit-opt-in',
      explicitOptInUsers: 30,
      equivalentDemandEvidence: 0,
      evidenceRefs: ['https://github.com/hi-fullmoon/ShellSpan/issues/101'],
    },
    retention: {
      day7EligibleUsers: 30,
      day7EnabledUsers: 9,
      evidenceRefs: ['anonymous:retention-batch-a'],
    },
    safety: {
      reviewCompleted: true,
      confirmedSeriousIncidents: 0,
      evidenceRefs: ['anonymous:safety-review-a'],
    },
    qualitative: {
      respondents: 3,
      stateAwarenessValueResponses: 1,
      valueByScenario: {
        backgroundTransfer: 1,
        aiCompletion: 0,
        connectionFailure: 0,
      },
      frictionReports: {
        interference: 1,
        resourceUse: 0,
        obstruction: 0,
      },
      preferredSurface: {
        externalFloatingPet: 1,
        inWindowCharacter: 1,
        systemNotification: 1,
        none: 0,
      },
      evidenceRefs: ['https://github.com/hi-fullmoon/ShellSpan/issues/102'],
    },
  };
}

describe('Petdex Phase 3 evidence gate', () => {
  it('keeps the real zero-evidence ledger in collecting with explicit gaps', () => {
    const result = evaluatePetdexPhase3Ledger(initialLedger, schema, {
      asOf: '2026-08-28',
    });

    expect(result.status).toBe('collecting');
    expect(result.summary.qualifiedUsers).toBe(0);
    expect(result.gaps.map((gap) => gap.id)).toEqual(expect.arrayContaining([
      'observation.window',
      'recruitment.minimum',
      'retention.day7Rate',
      'safety.noSeriousIncident',
      'qualitative.stateAwarenessValue',
    ]));
  });

  it('never interprets an empty ledger as a pass', () => {
    const result = evaluatePetdexPhase3Ledger({}, schema, {
      asOf: '2026-08-28',
    });

    expect(result.status).toBe('blocked');
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps.every((gap) => gap.id === 'ledger.schema')).toBe(true);
  });

  it('passes only after a valid observation cutoff and every evidence gate', () => {
    const result = evaluatePetdexPhase3Ledger(passingLedger(), schema, {
      asOf: '2026-09-11',
    });

    expect(result.status).toBe('pass');
    expect(result.summary.day7RetentionRate).toBe(0.3);
    expect(result.gaps).toEqual([]);
    expect(result.checks.every((item) => item.state === 'met')).toBe(true);
  });

  it('fails a completed observation below 30 percent Day-7 retention', () => {
    const ledger = passingLedger();
    ledger.retention.day7EnabledUsers = 8;

    const result = evaluatePetdexPhase3Ledger(ledger, schema, {
      asOf: '2026-09-11',
    });

    expect(result.status).toBe('fail');
    expect(result.gaps).toContainEqual(expect.objectContaining({
      id: 'retention.day7Rate',
    }));
  });

  it('fails immediately when a serious integration safety incident is confirmed', () => {
    const ledger = structuredClone(initialLedger);
    ledger.safety = {
      reviewCompleted: true,
      confirmedSeriousIncidents: 1,
      evidenceRefs: ['anonymous:safety-incident-a'],
    };

    const result = evaluatePetdexPhase3Ledger(ledger, schema, {
      asOf: '2026-09-01',
    });

    expect(result.status).toBe('fail');
    expect(result.summary.confirmedSeriousIncidents).toBe(1);
  });

  it('blocks an observation left open beyond four weeks', () => {
    const result = evaluatePetdexPhase3Ledger(initialLedger, schema, {
      asOf: '2026-09-26',
    });

    expect(result.status).toBe('blocked');
    expect(result.gaps[0].id).toBe('observation.overdue');
  });

  it('blocks inconsistent aggregate counts instead of guessing', () => {
    const ledger = structuredClone(initialLedger);
    ledger.recruitment.explicitOptInUsers = 1;
    ledger.retention.day7EligibleUsers = 1;
    ledger.retention.day7EnabledUsers = 2;

    const result = evaluatePetdexPhase3Ledger(ledger, schema, {
      asOf: '2026-09-04',
    });

    expect(result.status).toBe('blocked');
    expect(result.gaps).toContainEqual(expect.objectContaining({
      id: 'retention.enabledExceedsEligible',
    }));
  });
});
