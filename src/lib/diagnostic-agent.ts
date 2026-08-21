import type { DiagnosticAgentPlan, DiagnosticAgentPlanStep } from '@/types/ai';

const MAX_AGENT_STEPS = 8;
const MAX_FIELD_LENGTH = 4000;
const READ_ONLY_COMMANDS = new Set([
  'cat', 'date', 'df', 'du', 'find', 'free', 'grep', 'head', 'hostname', 'id', 'journalctl',
  'ls', 'lsof', 'netstat', 'ps', 'rg', 'ss', 'stat', 'tail', 'uname', 'uptime', 'whoami',
]);

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
  if (!normalized || /[\r\n;&|><`]/.test(normalized) || normalized.includes('$(')) return false;
  const [program, action] = normalized.split(/\s+/);
  if (READ_ONLY_COMMANDS.has(program)) {
    return !(program === 'find' && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/.test(normalized));
  }
  if (program === 'systemctl') return ['status', 'show', 'is-active', 'list-units'].includes(action);
  if (program === 'docker') return ['ps', 'logs', 'inspect', 'stats'].includes(action);
  if (program === 'kubectl') return ['get', 'describe', 'logs', 'top'].includes(action);
  return false;
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
