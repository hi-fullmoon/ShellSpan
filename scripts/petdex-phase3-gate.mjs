import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';

const DAY_MS = 86_400_000;
const MIN_OBSERVATION_DAYS = 14;
const MAX_OBSERVATION_DAYS = 28;
const MIN_QUALIFIED_USERS = 30;
const MIN_DAY7_RETENTION = 0.3;
const REPOSITORY_ROOT = process.cwd();

export const DEFAULT_PETDEX_PHASE3_LEDGER = path.join(
  REPOSITORY_ROOT,
  'docs/petdex-phase3/evidence-ledger.json',
);
export const DEFAULT_PETDEX_PHASE3_SCHEMA = path.join(
  REPOSITORY_ROOT,
  'docs/petdex-phase3/evidence-ledger.schema.json',
);

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return parsed;
}

function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

function formatValidationError(error) {
  const location = error.instancePath || '/';
  return `${location}: ${error.message ?? error.keyword}`;
}

function blockedResult(asOf, gaps) {
  return {
    status: 'blocked',
    asOf,
    studyId: null,
    summary: null,
    checks: [],
    gaps,
  };
}

function check(id, met, message, actual, required, evidenceRefs = []) {
  return {
    id,
    state: met ? 'met' : 'missing',
    message,
    actual,
    required,
    evidenceRefs,
  };
}

export function evaluatePetdexPhase3Ledger(ledger, schema, options = {}) {
  const asOfValue = options.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = parseDate(asOfValue);
  if (!asOf) {
    return blockedResult(String(asOfValue), [{
      id: 'evaluation.asOf',
      message: 'The evaluation date must be a real YYYY-MM-DD calendar date.',
    }]);
  }

  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(ledger)) {
    return blockedResult(asOfValue, (validate.errors ?? []).map((error) => ({
      id: 'ledger.schema',
      message: formatValidationError(error),
    })));
  }

  const startedOn = parseDate(ledger.observation.startedOn);
  const plannedEndOn = parseDate(ledger.observation.plannedEndOn);
  const endedOn = ledger.observation.endedOn === null
    ? null
    : parseDate(ledger.observation.endedOn);
  const semanticGaps = [];

  if (!startedOn || !plannedEndOn || (ledger.observation.endedOn !== null && !endedOn)) {
    semanticGaps.push({
      id: 'ledger.calendarDates',
      message: 'Observation dates must be real calendar dates.',
    });
  }

  if (startedOn && plannedEndOn) {
    const plannedDays = daysBetween(startedOn, plannedEndOn);
    if (plannedDays < MIN_OBSERVATION_DAYS || plannedDays > MAX_OBSERVATION_DAYS) {
      semanticGaps.push({
        id: 'observation.plannedWindow',
        message: `The planned observation window must be ${MIN_OBSERVATION_DAYS}-${MAX_OBSERVATION_DAYS} days.`,
      });
    }
    if (asOf < startedOn) {
      semanticGaps.push({
        id: 'observation.notStarted',
        message: 'The evaluation date is earlier than the observation start.',
      });
    }
  }

  if (startedOn && endedOn) {
    const actualDays = daysBetween(startedOn, endedOn);
    if (actualDays < MIN_OBSERVATION_DAYS || actualDays > MAX_OBSERVATION_DAYS) {
      semanticGaps.push({
        id: 'observation.actualWindow',
        message: `The completed observation window must be ${MIN_OBSERVATION_DAYS}-${MAX_OBSERVATION_DAYS} days.`,
      });
    }
    if (endedOn > asOf) {
      semanticGaps.push({
        id: 'observation.futureCutoff',
        message: 'The completed observation cutoff cannot be later than the evaluation date.',
      });
    }
  }

  const { recruitment, retention, safety, qualitative } = ledger;
  if (retention.day7EnabledUsers > retention.day7EligibleUsers) {
    semanticGaps.push({
      id: 'retention.enabledExceedsEligible',
      message: 'Day-7 enabled users cannot exceed Day-7 eligible users.',
    });
  }
  if (retention.day7EligibleUsers > recruitment.explicitOptInUsers) {
    semanticGaps.push({
      id: 'retention.eligibleExceedsOptIn',
      message: 'Day-7 eligible users cannot exceed explicitly opted-in trial users.',
    });
  }
  if (safety.reviewCompleted !== (safety.confirmedSeriousIncidents !== null)) {
    semanticGaps.push({
      id: 'safety.reviewConsistency',
      message: 'confirmedSeriousIncidents must stay null until the safety review is complete, then become a count.',
    });
  }
  if (qualitative.stateAwarenessValueResponses > qualitative.respondents) {
    semanticGaps.push({
      id: 'qualitative.valueExceedsRespondents',
      message: 'State-awareness value responses cannot exceed qualitative respondents.',
    });
  }

  const scenarioValues = Object.values(qualitative.valueByScenario);
  if (scenarioValues.some((value) => value > qualitative.respondents)) {
    semanticGaps.push({
      id: 'qualitative.scenarioExceedsRespondents',
      message: 'Each state-awareness scenario count cannot exceed qualitative respondents.',
    });
  }
  const preferenceTotal = Object.values(qualitative.preferredSurface)
    .reduce((total, value) => total + value, 0);
  if (preferenceTotal > qualitative.respondents) {
    semanticGaps.push({
      id: 'qualitative.preferenceExceedsRespondents',
      message: 'Preferred-surface choices cannot exceed qualitative respondents.',
    });
  }

  if (semanticGaps.length > 0) {
    return {
      ...blockedResult(asOfValue, semanticGaps),
      studyId: ledger.studyId,
    };
  }

  const qualifiedUsers = recruitment.explicitOptInUsers
    + recruitment.equivalentDemandEvidence;
  const retentionRate = retention.day7EligibleUsers > 0
    ? retention.day7EnabledUsers / retention.day7EligibleUsers
    : null;
  const observationDays = endedOn && startedOn
    ? daysBetween(startedOn, endedOn)
    : daysBetween(startedOn, asOf);
  const latestAllowedEnd = new Date(startedOn.getTime() + MAX_OBSERVATION_DAYS * DAY_MS);
  const observationComplete = endedOn !== null;
  const seriousIncidents = safety.confirmedSeriousIncidents;
  const hasStateAwarenessScenario = scenarioValues.some((value) => value > 0);

  const checks = [
    check(
      'observation.window',
      observationComplete,
      observationComplete
        ? `Observation ended after ${observationDays} days.`
        : `Observation is still open (${observationDays} days observed).`,
      observationComplete ? observationDays : null,
      `${MIN_OBSERVATION_DAYS}-${MAX_OBSERVATION_DAYS} completed days`,
    ),
    check(
      'recruitment.minimum',
      qualifiedUsers >= MIN_QUALIFIED_USERS && recruitment.evidenceRefs.length > 0,
      `${qualifiedUsers} explicitly opted-in users or equivalent verifiable demand records are documented.`,
      qualifiedUsers,
      `>= ${MIN_QUALIFIED_USERS} with evidence references`,
      recruitment.evidenceRefs,
    ),
    check(
      'retention.day7Coverage',
      recruitment.explicitOptInUsers > 0
        && retention.day7EligibleUsers === recruitment.explicitOptInUsers
        && retention.evidenceRefs.length > 0,
      `${retention.day7EligibleUsers} of ${recruitment.explicitOptInUsers} opted-in trial users are eligible for a Day-7 result.`,
      retention.day7EligibleUsers,
      'all explicitly opted-in trial users have a referenced Day-7 result',
      retention.evidenceRefs,
    ),
    check(
      'retention.day7Rate',
      retentionRate !== null && retentionRate >= MIN_DAY7_RETENTION,
      retentionRate === null
        ? 'No Day-7 retention denominator exists yet.'
        : `Day-7 continued-enable rate is ${(retentionRate * 100).toFixed(1)}%.`,
      retentionRate,
      `>= ${MIN_DAY7_RETENTION}`,
      retention.evidenceRefs,
    ),
    check(
      'safety.noSeriousIncident',
      safety.reviewCompleted
        && seriousIncidents === 0
        && safety.evidenceRefs.length > 0,
      safety.reviewCompleted
        ? `${seriousIncidents} confirmed serious integration incidents.`
        : 'The crash, business-blocking, and secret-exposure review is pending.',
      seriousIncidents,
      'completed review, 0 serious incidents, and evidence references',
      safety.evidenceRefs,
    ),
    check(
      'qualitative.stateAwarenessValue',
      qualitative.respondents > 0
        && qualitative.stateAwarenessValueResponses > 0
        && hasStateAwarenessScenario
        && qualitative.evidenceRefs.length > 0,
      `${qualitative.stateAwarenessValueResponses} of ${qualitative.respondents} respondents reported state-awareness value.`,
      qualitative.stateAwarenessValueResponses,
      '> 0 responses tied to transfer, AI completion, or connection failure, with evidence references',
      qualitative.evidenceRefs,
    ),
  ];

  const gaps = checks
    .filter((item) => item.state !== 'met')
    .map((item) => ({ id: item.id, message: item.message }));

  let status = 'collecting';
  if (seriousIncidents !== null && seriousIncidents > 0) {
    status = 'fail';
  } else if (!observationComplete && asOf > latestAllowedEnd) {
    status = 'blocked';
    gaps.unshift({
      id: 'observation.overdue',
      message: `The observation remains open after ${MAX_OBSERVATION_DAYS} days; establish an auditable cutoff without backdating evidence.`,
    });
  } else if (observationComplete) {
    if (!safety.reviewCompleted) {
      status = 'blocked';
    } else {
      status = checks.every((item) => item.state === 'met') ? 'pass' : 'fail';
    }
  }

  return {
    status,
    asOf: asOfValue,
    studyId: ledger.studyId,
    summary: {
      observationDays,
      explicitOptInUsers: recruitment.explicitOptInUsers,
      equivalentDemandEvidence: recruitment.equivalentDemandEvidence,
      qualifiedUsers,
      day7EligibleUsers: retention.day7EligibleUsers,
      day7EnabledUsers: retention.day7EnabledUsers,
      day7RetentionRate: retentionRate,
      qualitativeRespondents: qualitative.respondents,
      stateAwarenessValueResponses: qualitative.stateAwarenessValueResponses,
      confirmedSeriousIncidents: seriousIncidents,
    },
    checks,
    gaps,
  };
}

function parseArgs(argv) {
  const options = {
    asOf: new Date().toISOString().slice(0, 10),
    format: 'text',
    ledger: DEFAULT_PETDEX_PHASE3_LEDGER,
    requirePass: false,
    schema: DEFAULT_PETDEX_PHASE3_SCHEMA,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case '--':
        break;
      case '--as-of':
        options.asOf = value ?? '';
        index += 1;
        break;
      case '--format':
        options.format = value ?? '';
        index += 1;
        break;
      case '--ledger':
        options.ledger = path.resolve(value ?? '');
        index += 1;
        break;
      case '--schema':
        options.schema = path.resolve(value ?? '');
        index += 1;
        break;
      case '--require-pass':
        options.requirePass = true;
        break;
      case '-h':
      case '--help':
        return { help: true };
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!['json', 'text'].includes(options.format)) {
    throw new Error('--format must be json or text.');
  }
  return options;
}

function renderText(result) {
  const lines = [
    `Petdex Phase 3 gate: ${result.status}`,
    `Study: ${result.studyId ?? 'unavailable'}`,
    `As of: ${result.asOf}`,
  ];
  if (result.checks.length > 0) {
    lines.push('Checks:');
    for (const item of result.checks) {
      lines.push(`- ${item.state}: ${item.id} — ${item.message}`);
    }
  }
  lines.push('Evidence gaps:');
  if (result.gaps.length === 0) {
    lines.push('- none');
  } else {
    for (const gap of result.gaps) lines.push(`- ${gap.id} — ${gap.message}`);
  }
  return lines.join('\n');
}

async function runCli() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage:
  node scripts/petdex-phase3-gate.mjs [--ledger <path>] [--schema <path>] [--as-of YYYY-MM-DD] [--format text|json] [--require-pass]

Without --require-pass, collecting and fail are reported without failing the process. blocked always exits 2. With --require-pass, every non-pass result exits 1 (blocked remains 2).
`);
      return;
    }

    const [ledger, schema] = await Promise.all([
      readFile(options.ledger, 'utf8').then(JSON.parse),
      readFile(options.schema, 'utf8').then(JSON.parse),
    ]);
    const result = evaluatePetdexPhase3Ledger(ledger, schema, { asOf: options.asOf });
    console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : renderText(result));
    if (result.status === 'blocked') process.exitCode = 2;
    else if (options.requirePass && result.status !== 'pass') process.exitCode = 1;
  } catch (error) {
    const result = blockedResult(options?.asOf ?? 'unavailable', [{
      id: 'ledger.read',
      message: error instanceof Error ? error.message : String(error),
    }]);
    console.error(options?.format === 'json' ? JSON.stringify(result, null, 2) : renderText(result));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'petdex-phase3-gate.mjs') {
  await runCli();
}
