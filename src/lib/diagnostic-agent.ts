import type { DiagnosticAgentPlan, DiagnosticAgentPlanStep } from '@/types/ai';

const MAX_AGENT_STEPS = 8;
const MAX_FIELD_LENGTH = 4000;
const MAX_RESULT_LINES = 40;
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

export function createAgentExecutionMarker(stepId: string): string {
  const normalizedId = stepId.replace(/[^A-Za-z0-9]/g, '').slice(-32) || 'STEP';
  return `__TERMBRIDGE_AGENT_RESULT_${normalizedId}__`;
}

export function buildAgentExecutionCommand(command: string, marker: string): string {
  if (!isSafeReadOnlyAgentCommand(command) || !/^__TERMBRIDGE_AGENT_RESULT_[A-Za-z0-9]+__$/.test(marker)) {
    throw new Error('Cannot instrument an unsafe agent command');
  }
  return `${command}; printf '\\n${marker}:%s\\n' "$?"`;
}

export interface AgentCommandCompletion {
  exitCode: number;
  result?: string;
}

export function extractAgentCommandCompletion(
  before: string,
  after: string,
  marker: string,
): AgentCommandCompletion | undefined {
  if (!/^__TERMBRIDGE_AGENT_RESULT_[A-Za-z0-9]+__$/.test(marker)) return undefined;
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escapedMarker}:(\\d{1,3})(?=\\n|$)`).exec(after);
  if (!match) return undefined;
  const outputBeforeMarker = after.slice(0, match.index);
  return {
    exitCode: Number.parseInt(match[1], 10),
    result: extractAgentCommandResult(before, outputBeforeMarker),
  };
}

export function extractAgentCommandResult(before: string, after: string): string | undefined {
  const beforeLines = before.trim().split('\n').filter(Boolean);
  const afterLines = after.trim().split('\n').filter(Boolean);
  if (afterLines.length === 0) return undefined;

  let overlap = 0;
  const maxOverlap = Math.min(beforeLines.length, afterLines.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    const beforeStart = beforeLines.length - length;
    const matches = beforeLines
      .slice(beforeStart)
      .every((line, index) => line === afterLines[index]);
    if (matches) {
      overlap = length;
      break;
    }
  }

  const resultLines = afterLines.slice(overlap).slice(-MAX_RESULT_LINES);
  return resultLines.length > 0 ? resultLines.join('\n') : undefined;
}

function parseStep(value: unknown, index: number): DiagnosticAgentPlanStep {
  if (!value || typeof value !== 'object') {
    throw new Error(`Agent plan step ${index + 1} is invalid`);
  }
  const step = value as Record<string, unknown>;
  const command = typeof step.command === 'string' ? step.command.trim() : undefined;
  if (command && !isSafeReadOnlyAgentCommand(command)) {
    throw new Error(`Agent plan step ${index + 1} contains an unsafe command`);
  }
  return {
    title: requiredString(step.title, `step ${index + 1} title`),
    description: requiredString(step.description, `step ${index + 1} description`),
    command: command ? command.slice(0, MAX_FIELD_LENGTH) : undefined,
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
  const plan = parsed as Record<string, unknown>;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_AGENT_STEPS) {
    throw new Error(`Agent plan must contain 1-${MAX_AGENT_STEPS} steps`);
  }
  return {
    summary: requiredString(plan.summary, 'summary'),
    steps: plan.steps.map(parseStep),
  };
}
