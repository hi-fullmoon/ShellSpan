import { parseRunbookText, serializeRunbook } from '@/lib/runbook';
import type {
  DiagnosticAgentEvidenceRequirement,
  DiagnosticAgentPlan,
  DiagnosticAgentPlanStep,
} from '@/types/ai';
import type { RunbookDocument } from '@/types/runbook';

const MAX_AGENT_STEPS = 8;
const MAX_FIELD_LENGTH = 4000;
const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GENERIC_READ_ONLY_COMMANDS = new Set([
  'cat', 'df', 'du', 'free', 'grep', 'head', 'id', 'ls', 'lsof', 'netstat', 'ps', 'stat',
  'tail', 'uname', 'uptime', 'whoami',
]);
const SAFE_HOSTNAME_ARGUMENTS = new Set([
  '-A', '-d', '-f', '-i', '-I', '-s', '--all-fqdns', '--all-ip-addresses', '--domain',
  '--fqdn', '--help', '--ip-address', '--short', '--version',
]);
const MUTATING_JOURNALCTL_OPTIONS = [
  '--flush', '--relinquish-var', '--rotate', '--setup-keys', '--smart-relinquish-var',
  '--sync', '--update-catalog', '--vacuum-',
];

function hasFollowOrWatchOption(args: string[]): boolean {
  return args.some((argument) => (
    argument === '-F'
    || /^-[^-]*[fw][^-]*$/i.test(argument)
    || argument === '--watch-only'
    || argument.startsWith('--follow')
    || argument.startsWith('--watch')
  ));
}

function hasEnabledFlag(args: string[], option: string): boolean {
  return args.some((argument) => argument === option || argument === `${option}=true`);
}

function hasNumericLimit(args: string[], longOption: string, shortOption?: string): boolean {
  return args.some((argument, index) => {
    if (new RegExp(`^${longOption}=\\d+$`).test(argument)) return true;
    if (argument === longOption) return /^\d+$/.test(args[index + 1] ?? '');
    if (!shortOption) return false;
    if (argument === shortOption) return /^\d+$/.test(args[index + 1] ?? '');
    return new RegExp(`^${shortOption}\\d+$`).test(argument);
  });
}

function extractJson(value: string): string {
  const tagged = /<agent_plan>\s*([\s\S]*?)\s*<\/agent_plan>/i.exec(value);
  if (tagged) return tagged[1];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(value);
  if (fenced) return fenced[1];
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  return start >= 0 && end > start ? value.slice(start, end + 1) : value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Agent plan ${field} must be a non-empty string`);
  }
  return value.trim().slice(0, MAX_FIELD_LENGTH);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent plan ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Agent plan ${field} contains unknown field ${unexpected}`);
}

function idValue(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!PLAN_ID_PATTERN.test(result)) throw new Error(`Agent plan ${field} is invalid`);
  return result;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Agent plan ${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function stringArray(value: unknown, field: string, max: number, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new Error(`Agent plan ${field} must contain ${allowEmpty ? '0' : '1'}-${max} strings`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

export function isSafeReadOnlyAgentCommand(command: string): boolean {
  const normalized = command.trim();
  if (
    !normalized
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
    || !/^[\p{L}\p{N} ._\/:%=+,@-]+$/u.test(normalized)
  ) return false;
  const [program, ...args] = normalized.split(/ +/);
  const action = args[0];
  if (program === 'tail') return !hasFollowOrWatchOption(args);
  if (program === 'cat') {
    return args.some((argument) => !argument.startsWith('-'))
      && !args.some((argument) => /^\/dev\/(?:full|null|random|urandom|zero)$/.test(argument));
  }
  if (GENERIC_READ_ONLY_COMMANDS.has(program)) return true;
  if (program === 'date') {
    return args.every((argument) => (
      argument === '-u'
      || argument === '--utc'
      || argument === '--help'
      || argument === '--version'
      || argument.startsWith('+')
      || argument.startsWith('--iso-8601')
      || argument.startsWith('--rfc-3339')
    ));
  }
  if (program === 'hostname') {
    return args.every((argument) => SAFE_HOSTNAME_ARGUMENTS.has(argument));
  }
  if (program === 'journalctl') {
    return !hasFollowOrWatchOption(args) && !args.some((argument) => (
      MUTATING_JOURNALCTL_OPTIONS.some((option) => argument.startsWith(option))
    )) && hasNumericLimit(args, '--lines', '-n');
  }
  if (program === 'ss') return !args.some((argument) => ['-K', '--kill'].includes(argument));
  if (program === 'systemctl') return ['status', 'show', 'is-active', 'list-units'].includes(action);
  if (program === 'docker') {
    if (action === 'stats') return hasEnabledFlag(args.slice(1), '--no-stream');
    if (action === 'logs') {
      return !hasFollowOrWatchOption(args.slice(1))
        && hasNumericLimit(args.slice(1), '--tail');
    }
    return ['ps', 'inspect'].includes(action);
  }
  if (program === 'kubectl') {
    if (action === 'logs') {
      return !hasFollowOrWatchOption(args.slice(1))
        && hasNumericLimit(args.slice(1), '--tail');
    }
    if (action === 'get') return !hasFollowOrWatchOption(args.slice(1));
    return ['describe', 'top'].includes(action);
  }
  return false;
}

function parseEvidence(value: unknown, index: number): DiagnosticAgentEvidenceRequirement {
  const field = `evidence ${index + 1}`;
  const evidence = objectValue(value, field);
  exactKeys(evidence, ['id', 'description', 'source', 'sourceStepId', 'maxAgeSeconds'], field);
  if (evidence.source !== 'context' && evidence.source !== 'stepOutput') {
    throw new Error(`Agent plan ${field} source is invalid`);
  }
  const sourceStepId = evidence.sourceStepId === null
    ? null
    : idValue(evidence.sourceStepId, `${field} sourceStepId`);
  if (
    (evidence.source === 'context' && sourceStepId !== null)
    || (evidence.source === 'stepOutput' && sourceStepId === null)
  ) {
    throw new Error(`Agent plan ${field} sourceStepId does not match its source`);
  }
  return {
    id: idValue(evidence.id, `${field} id`),
    description: requiredString(evidence.description, `${field} description`),
    source: evidence.source,
    sourceStepId,
    maxAgeSeconds: integerValue(evidence.maxAgeSeconds, `${field} maxAgeSeconds`, 30, 3600),
  };
}

function parseStep(value: unknown, index: number): DiagnosticAgentPlanStep {
  const field = `step ${index + 1}`;
  const step = objectValue(value, field);
  exactKeys(step, [
    'id', 'title', 'description', 'command', 'risk', 'evidenceIds', 'impact', 'rollback',
    'expected', 'timeoutSeconds', 'safeToRetry',
  ], field);
  if (step.risk !== 'readOnly' && step.risk !== 'stateChange' && step.risk !== 'destructive') {
    throw new Error(`Agent plan ${field} risk is invalid`);
  }
  const command = requiredString(step.command, `${field} command`);
  if (step.risk === 'readOnly' && !isSafeReadOnlyAgentCommand(command)) {
    throw new Error(`Agent plan ${field} contains an unsafe read-only command`);
  }
  const expected = objectValue(step.expected, `${field} expected`);
  exactKeys(expected, ['exitCode', 'stdoutContains'], `${field} expected`);
  if (typeof step.safeToRetry !== 'boolean') {
    throw new Error(`Agent plan ${field} safeToRetry must be boolean`);
  }
  return {
    id: idValue(step.id, `${field} id`),
    title: requiredString(step.title, `${field} title`),
    description: requiredString(step.description, `${field} description`),
    command,
    risk: step.risk,
    evidenceIds: stringArray(step.evidenceIds, `${field} evidenceIds`, 8),
    impact: requiredString(step.impact, `${field} impact`),
    rollback: requiredString(step.rollback, `${field} rollback`),
    expected: {
      exitCode: integerValue(expected.exitCode, `${field} expected exitCode`, 0, 255),
      stdoutContains: stringArray(
        expected.stdoutContains,
        `${field} expected stdoutContains`,
        20,
        true,
      ),
    },
    timeoutSeconds: integerValue(step.timeoutSeconds, `${field} timeoutSeconds`, 1, 300),
    safeToRetry: step.safeToRetry,
  };
}

export function parseDiagnosticAgentPlan(value: string): DiagnosticAgentPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(value).trim());
  } catch {
    throw new Error('Agent returned an invalid plan');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Agent returned an invalid plan');
  const plan = objectValue(parsed, 'document');
  exactKeys(plan, ['objective', 'target', 'assumptions', 'summary', 'evidence', 'steps'], 'document');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_AGENT_STEPS) {
    throw new Error(`Agent plan must contain 1-${MAX_AGENT_STEPS} steps`);
  }
  if (!Array.isArray(plan.evidence) || plan.evidence.length === 0 || plan.evidence.length > MAX_AGENT_STEPS) {
    throw new Error(`Agent plan must contain 1-${MAX_AGENT_STEPS} evidence requirements`);
  }
  const result: DiagnosticAgentPlan = {
    objective: requiredString(plan.objective, 'objective'),
    target: requiredString(plan.target, 'target'),
    assumptions: stringArray(plan.assumptions, 'assumptions', 8),
    summary: requiredString(plan.summary, 'summary'),
    evidence: plan.evidence.map(parseEvidence),
    steps: plan.steps.map(parseStep),
  };
  validatePlanRelationships(result);
  // Reuse the same parser that guards reviewed Runbooks so a model cannot
  // understate command risk or smuggle an unsupported command into handoff.
  parseRunbookText(buildRunbookText(result));
  return result;
}

function validatePlanRelationships(plan: DiagnosticAgentPlan): void {
  const stepIndexes = new Map<string, number>();
  plan.steps.forEach((step, index) => {
    if (stepIndexes.has(step.id)) throw new Error(`Agent plan contains duplicate step ${step.id}`);
    stepIndexes.set(step.id, index);
  });
  const evidenceById = new Map<string, DiagnosticAgentEvidenceRequirement>();
  for (const evidence of plan.evidence) {
    if (evidenceById.has(evidence.id)) {
      throw new Error(`Agent plan contains duplicate evidence ${evidence.id}`);
    }
    if (evidence.sourceStepId) {
      const source = plan.steps.find((step) => step.id === evidence.sourceStepId);
      if (!source || source.risk !== 'readOnly') {
        throw new Error(`Agent plan evidence ${evidence.id} must come from a read-only step`);
      }
    }
    evidenceById.set(evidence.id, evidence);
  }
  const firstModification = plan.steps.findIndex((step) => step.risk !== 'readOnly');
  if (
    firstModification >= 0
    && plan.steps.slice(firstModification + 1).some((step) => step.risk === 'readOnly')
  ) {
    throw new Error('Agent plan read-only evidence steps must precede modifying steps');
  }
  let modificationSeen = false;
  for (const step of plan.steps) {
    if (step.risk === 'readOnly') {
      if (modificationSeen) {
        throw new Error('Agent plan read-only evidence steps must precede modifying steps');
      }
      if (!plan.evidence.some((evidence) => evidence.sourceStepId === step.id)) {
        throw new Error(`Agent plan read-only step ${step.id} has no traceable evidence requirement`);
      }
    } else {
      modificationSeen = true;
    }
    for (const evidenceId of step.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) throw new Error(`Agent plan step ${step.id} cites unknown evidence ${evidenceId}`);
      if (step.risk !== 'readOnly') {
        const sourceIndex = evidence.sourceStepId
          ? stepIndexes.get(evidence.sourceStepId)
          : undefined;
        const stepIndex = stepIndexes.get(step.id) ?? -1;
        if (evidence.source !== 'stepOutput' || sourceIndex === undefined || sourceIndex >= stepIndex) {
          throw new Error(`Agent plan modifying step ${step.id} lacks prior executable evidence`);
        }
      }
    }
  }
}

function runbookId(plan: DiagnosticAgentPlan): string {
  const slug = plan.objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55);
  return `ai-${slug || 'assisted-plan'}`;
}

function buildRunbookText(plan: DiagnosticAgentPlan): string {
  const stepEvidence = plan.evidence.filter((evidence) => evidence.source === 'stepOutput');
  const description = [
    plan.summary,
    `Objective: ${plan.objective}`,
    `Target: ${plan.target}`,
    `Assumptions: ${plan.assumptions.join('; ')}`,
    'AI-generated draft: review and edit every field before execution.',
  ].join('\n').slice(0, MAX_FIELD_LENGTH);
  const document: RunbookDocument = {
    schemaVersion: 1,
    id: runbookId(plan),
    name: plan.objective.slice(0, 200),
    description,
    evidenceMaxAgeSeconds: Math.min(...stepEvidence.map((item) => item.maxAgeSeconds)),
    variables: [],
    prechecks: plan.steps
      .filter((step) => step.risk === 'readOnly')
      .map((step) => ({
        id: step.id,
        description: `${step.title}: ${step.description}`.slice(0, MAX_FIELD_LENGTH),
        command: step.command,
        expected: {
          exitCode: step.expected.exitCode,
          ...(step.expected.stdoutContains.length
            ? { stdoutContains: step.expected.stdoutContains }
            : {}),
        },
        timeoutSeconds: step.timeoutSeconds,
      })),
    steps: plan.steps
      .filter((step) => step.risk !== 'readOnly')
      .map((step) => ({
        id: step.id,
        description: `${step.title}: ${step.description}`.slice(0, MAX_FIELD_LENGTH),
        command: step.command,
        risk: step.risk,
        impact: step.impact,
        rollback: step.rollback,
        expected: {
          exitCode: step.expected.exitCode,
          ...(step.expected.stdoutContains.length
            ? { stdoutContains: step.expected.stdoutContains }
            : {}),
        },
        timeoutSeconds: step.timeoutSeconds,
        safeToRetry: step.safeToRetry,
      })),
  };
  return serializeRunbook(document);
}

export function createAgentRunbookDraft(plan: DiagnosticAgentPlan): string {
  const text = buildRunbookText(plan);
  return serializeRunbook(parseRunbookText(text));
}

export const AI_RUNBOOK_DRAFT_EVENT = 'termbridge:review-ai-runbook';

export interface AiRunbookDraftDetail {
  sourceText: string;
  profileId?: string;
  contextLabel: string;
  contextObservedAt: number;
  objective: string;
  target: string;
}

let pendingAgentRunbookDraft: AiRunbookDraftDetail | undefined;

export function dispatchAgentRunbookDraft(detail: AiRunbookDraftDetail): void {
  pendingAgentRunbookDraft = detail;
  window.dispatchEvent(new CustomEvent<AiRunbookDraftDetail>(AI_RUNBOOK_DRAFT_EVENT, { detail }));
}

export function consumePendingAgentRunbookDraft(): AiRunbookDraftDetail | undefined {
  const detail = pendingAgentRunbookDraft;
  pendingAgentRunbookDraft = undefined;
  return detail;
}
