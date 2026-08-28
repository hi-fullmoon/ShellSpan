import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PETDEX_PHASE3_LEDGER,
  DEFAULT_PETDEX_PHASE3_SCHEMA,
  evaluatePetdexPhase3Ledger,
} from './petdex-phase3-gate.mjs';

const REPOSITORY_ROOT = process.cwd();

export const DEFAULT_PETDEX_PHASE4_RECORD = path.join(
  REPOSITORY_ROOT,
  'docs/petdex-phase4/admission-evaluation.json',
);
export const DEFAULT_PETDEX_PHASE4_ASSESSMENT = path.join(
  REPOSITORY_ROOT,
  'docs/petdex-phase4-admission.md',
);
export const DEFAULT_PETDEX_ROADMAP = path.join(
  REPOSITORY_ROOT,
  'docs/petdex-integration-roadmap.md',
);

export const REQUIRED_PETDEX_PHASE4_CRITERIA = [
  'phase3.real-user-gate',
  'assets.machine-readable-rights',
  'downloads.integrity-cache-cleanup',
  'window.cross-platform-prototype',
  'resources.baseline',
  'format.compatibility-rollback',
];

const DECISION_MARKER = /<!-- petdex-phase4-decision: (blocked|admitted) -->/;
const IMPLEMENTATION_MARKER = /<!-- petdex-phase4-implementation: (not-authorized|authorized) -->/;

function error(id, message) {
  return { id, message };
}

function expectedStrictExitCode(status) {
  if (status === 'pass') return 0;
  if (status === 'blocked') return 2;
  return 1;
}

export function readPhase4DocumentMarkers(contents, name) {
  const decision = contents.match(DECISION_MARKER)?.[1] ?? null;
  const implementationValue = contents.match(IMPLEMENTATION_MARKER)?.[1] ?? null;
  return {
    name,
    decision,
    implementationAuthorized: implementationValue === null
      ? null
      : implementationValue === 'authorized',
  };
}

export function evaluatePetdexPhase4Admission(record, phase3Result, documentMarkers) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      status: 'invalid',
      decision: null,
      implementationAuthorized: false,
      phase3Status: phase3Result?.status ?? null,
      criteria: [],
      errors: [error('record.type', 'The Phase 4 admission record must be an object.')],
    };
  }

  if (record.schemaVersion !== 1) {
    errors.push(error('record.schemaVersion', 'schemaVersion must be 1.'));
  }
  if (record.scope !== 'admission-only') {
    errors.push(error('record.scope', 'scope must remain admission-only.'));
  }
  if (!['blocked', 'admitted'].includes(record.decision)) {
    errors.push(error('record.decision', 'decision must be blocked or admitted.'));
  }
  if (typeof record.implementationAuthorized !== 'boolean') {
    errors.push(error(
      'record.implementationAuthorized',
      'implementationAuthorized must be a boolean.',
    ));
  }

  if (!record.phase3Gate || typeof record.phase3Gate !== 'object') {
    errors.push(error('record.phase3Gate', 'phase3Gate is required.'));
  } else {
    if (record.phase3Gate.asOf !== record.evaluatedOn) {
      errors.push(error(
        'record.phase3Gate.asOf',
        'The Phase 3 evaluation date must match the Phase 4 evaluation date.',
      ));
    }
    if (record.phase3Gate.status !== phase3Result.status) {
      errors.push(error(
        'record.phase3Gate.status',
        `Recorded Phase 3 status ${record.phase3Gate.status} does not match ${phase3Result.status}.`,
      ));
    }
    const strictExitCode = expectedStrictExitCode(phase3Result.status);
    if (record.phase3Gate.strictExitCode !== strictExitCode) {
      errors.push(error(
        'record.phase3Gate.strictExitCode',
        `Strict Phase 3 exit code must be ${strictExitCode} for ${phase3Result.status}.`,
      ));
    }
  }

  const criteria = Array.isArray(record.criteria) ? record.criteria : [];
  if (!Array.isArray(record.criteria)) {
    errors.push(error('record.criteria', 'criteria must be an array.'));
  }
  const counts = new Map();
  for (const criterion of criteria) {
    const id = criterion?.id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!REQUIRED_PETDEX_PHASE4_CRITERIA.includes(id)) {
      errors.push(error('record.criteria.unknown', `Unknown Phase 4 criterion: ${String(id)}.`));
      continue;
    }
    if (!['blocked', 'met'].includes(criterion.status)) {
      errors.push(error(
        `record.criteria.${id}.status`,
        'Criterion status must be blocked or met.',
      ));
    }
    if (!Array.isArray(criterion.evidence) || criterion.evidence.length === 0) {
      errors.push(error(
        `record.criteria.${id}.evidence`,
        'Every criterion must contain current evidence.',
      ));
    }
    if (!Array.isArray(criterion.gaps)) {
      errors.push(error(`record.criteria.${id}.gaps`, 'Criterion gaps must be an array.'));
    } else if (criterion.status === 'blocked' && criterion.gaps.length === 0) {
      errors.push(error(
        `record.criteria.${id}.gaps`,
        'A blocked criterion must identify at least one gap.',
      ));
    } else if (criterion.status === 'met' && criterion.gaps.length !== 0) {
      errors.push(error(
        `record.criteria.${id}.gaps`,
        'A met criterion cannot retain unresolved gaps.',
      ));
    }
  }
  for (const id of REQUIRED_PETDEX_PHASE4_CRITERIA) {
    if (counts.get(id) !== 1) {
      errors.push(error(
        `record.criteria.${id}`,
        `Criterion ${id} must appear exactly once.`,
      ));
    }
  }

  const phase3Criterion = criteria.find((criterion) => criterion?.id === 'phase3.real-user-gate');
  const expectedPhase3CriterionStatus = phase3Result.status === 'pass' ? 'met' : 'blocked';
  if (phase3Criterion?.status !== expectedPhase3CriterionStatus) {
    errors.push(error(
      'record.criteria.phase3.real-user-gate.status',
      `The Phase 3 criterion must be ${expectedPhase3CriterionStatus} while Phase 3 is ${phase3Result.status}.`,
    ));
  }

  const everyCriterionMet = REQUIRED_PETDEX_PHASE4_CRITERIA.every((id) => (
    criteria.find((criterion) => criterion?.id === id)?.status === 'met'
  ));
  const admissionAllowed = phase3Result.status === 'pass' && everyCriterionMet;
  const expectedDecision = admissionAllowed ? 'admitted' : 'blocked';
  if (record.decision !== expectedDecision) {
    errors.push(error(
      'record.decision.invariant',
      `Phase 4 must remain ${expectedDecision} for the current Phase 3 result and criterion states.`,
    ));
  }
  if (record.implementationAuthorized !== admissionAllowed) {
    errors.push(error(
      'record.implementationAuthorized.invariant',
      `implementationAuthorized must be ${admissionAllowed}.`,
    ));
  }

  for (const markers of documentMarkers) {
    if (markers.decision === null) {
      errors.push(error(
        `document.${markers.name}.decision`,
        'The document is missing its Phase 4 decision marker.',
      ));
    } else if (markers.decision !== record.decision) {
      errors.push(error(
        `document.${markers.name}.decision`,
        `The document says ${markers.decision}, but the admission record says ${record.decision}.`,
      ));
    }
    if (markers.implementationAuthorized === null) {
      errors.push(error(
        `document.${markers.name}.implementation`,
        'The document is missing its Phase 4 implementation marker.',
      ));
    } else if (markers.implementationAuthorized !== record.implementationAuthorized) {
      errors.push(error(
        `document.${markers.name}.implementation`,
        'The document implementation marker does not match the admission record.',
      ));
    }
  }

  return {
    status: errors.length === 0 ? 'consistent' : 'invalid',
    decision: record.decision ?? null,
    implementationAuthorized: admissionAllowed,
    phase3Status: phase3Result.status,
    criteria,
    errors,
  };
}

function renderText(result) {
  const lines = [
    `Petdex Phase 4 admission record: ${result.status}`,
    `Decision: ${result.decision ?? 'unavailable'}`,
    `Phase 3 prerequisite: ${result.phase3Status ?? 'unavailable'}`,
    `Implementation authorized: ${result.implementationAuthorized ? 'yes' : 'no'}`,
  ];
  if (result.criteria.length > 0) {
    lines.push('Criteria:');
    for (const criterion of result.criteria) {
      lines.push(`- ${criterion.status}: ${criterion.id}`);
    }
  }
  lines.push('Consistency errors:');
  if (result.errors.length === 0) lines.push('- none');
  else for (const item of result.errors) lines.push(`- ${item.id} — ${item.message}`);
  return lines.join('\n');
}

async function runCli() {
  const requireAdmitted = process.argv.slice(2).includes('--require-admitted');
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--require-admitted');
  if (unknownArguments.length > 0) {
    console.error(`Unknown option: ${unknownArguments[0]}`);
    process.exitCode = 2;
    return;
  }

  try {
    const [record, ledger, schema, assessment, roadmap] = await Promise.all([
      readFile(DEFAULT_PETDEX_PHASE4_RECORD, 'utf8').then(JSON.parse),
      readFile(DEFAULT_PETDEX_PHASE3_LEDGER, 'utf8').then(JSON.parse),
      readFile(DEFAULT_PETDEX_PHASE3_SCHEMA, 'utf8').then(JSON.parse),
      readFile(DEFAULT_PETDEX_PHASE4_ASSESSMENT, 'utf8'),
      readFile(DEFAULT_PETDEX_ROADMAP, 'utf8'),
    ]);
    const phase3Result = evaluatePetdexPhase3Ledger(ledger, schema, {
      asOf: record.phase3Gate?.asOf,
    });
    const result = evaluatePetdexPhase4Admission(record, phase3Result, [
      readPhase4DocumentMarkers(assessment, 'assessment'),
      readPhase4DocumentMarkers(roadmap, 'roadmap'),
    ]);
    console.log(renderText(result));
    if (result.status !== 'consistent') process.exitCode = 2;
    else if (requireAdmitted && result.decision !== 'admitted') process.exitCode = 1;
  } catch (cause) {
    console.error(`Petdex Phase 4 admission audit could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'petdex-phase4-admission-gate.mjs') {
  await runCli();
}
