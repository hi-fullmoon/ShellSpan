import type {
  RunbookDocument,
  RunbookExpectedResult,
  RunbookPrecheck,
  RunbookRisk,
  RunbookRun,
  RunbookRunItem,
  RunbookStep,
  RunbookStepExecutionResult,
  RunbookTarget,
  RunbookVariable,
} from '@/types/runbook';

const MAX_TEXT_LENGTH = 512 * 1024;
const MAX_COMMAND_LENGTH = 8 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEYCHAIN_REF_PATTERN = /^keychain:\/\/profile\/(?:password|passphrase|jump-password|jump-passphrase)$/;
const TEMPLATE_PATTERN = /\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g;
const READ_ONLY_PROGRAMS = new Set([
  'cat', 'date', 'df', 'du', 'free', 'getent', 'grep', 'head', 'hostname', 'id', 'journalctl',
  'ls', 'lsof', 'netstat', 'ps', 'pwd', 'ss', 'stat', 'systemctl', 'tail', 'uname', 'uptime',
  'wc', 'whoami',
]);

function fail(message: string): never {
  throw new Error(`Runbook: ${message}`);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${field} contains unsupported field ${unknown}`);
}

function stringValue(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max || /[\u0000\u007f]/u.test(result)) fail(`${field} is invalid`);
  return result;
}

function integerValue(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function idValue(value: unknown, field: string): string {
  const result = stringValue(value, field, 64);
  if (!ID_PATTERN.test(result)) fail(`${field} must use lowercase letters, numbers, dots, underscores or dashes`);
  return result;
}

function hasSecretLiteral(value: string): boolean {
  return /(?:password|passphrase|api[_-]?key|secret|token)\s*[=:]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[A-Z0-9]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/i.test(value);
}

function secretVariableName(name: string): boolean {
  return /(?:PASSWORD|PASSPHRASE|SECRET|TOKEN|API_KEY|PRIVATE_KEY)/.test(name);
}

function parseVariable(value: unknown, index: number): RunbookVariable {
  const field = `variables[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, ['name', 'description', 'required', 'default', 'keychainRef'], field);
  const name = stringValue(entry.name, `${field}.name`, 64);
  if (!VARIABLE_PATTERN.test(name)) fail(`${field}.name must be uppercase shell-style identifier`);
  if (typeof entry.required !== 'boolean') fail(`${field}.required must be boolean`);
  const defaultValue = entry.default === undefined ? undefined : stringValue(entry.default, `${field}.default`);
  const keychainRef = entry.keychainRef === undefined
    ? undefined
    : stringValue(entry.keychainRef, `${field}.keychainRef`, 128);
  if (keychainRef && !KEYCHAIN_REF_PATTERN.test(keychainRef)) fail(`${field}.keychainRef is unsupported`);
  if (keychainRef && defaultValue !== undefined) fail(`${field} cannot contain both default and keychainRef`);
  if (!keychainRef && secretVariableName(name)) {
    fail(`${field}.name identifies a secret and therefore requires keychainRef`);
  }
  if (defaultValue && hasSecretLiteral(defaultValue)) {
    fail(`${field}.default appears to contain a secret; use keychainRef`);
  }
  return {
    name,
    description: stringValue(entry.description, `${field}.description`),
    required: entry.required,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(keychainRef ? { keychainRef } : {}),
  };
}

function parseExpected(value: unknown, field: string): RunbookExpectedResult {
  const expected = objectValue(value, field);
  exactKeys(expected, ['exitCode', 'stdoutContains'], field);
  const stdoutContains = expected.stdoutContains === undefined
    ? undefined
    : Array.isArray(expected.stdoutContains)
      ? expected.stdoutContains.map((item, index) => stringValue(item, `${field}.stdoutContains[${index}]`, 1000))
      : fail(`${field}.stdoutContains must be an array`);
  if (stdoutContains && stdoutContains.length > 20) fail(`${field}.stdoutContains has too many entries`);
  return {
    exitCode: integerValue(expected.exitCode, `${field}.exitCode`, 0, 255),
    ...(stdoutContains?.length ? { stdoutContains } : {}),
  };
}

function commandRisk(command: string): RunbookRisk {
  const structural = command.replace(TEMPLATE_PATTERN, "'VALUE'").toLowerCase();
  if (
    /(^|[;&|]\s*|\bsudo\s+)(rm|rmdir|mkfs|wipefs|fdisk|parted|shutdown|reboot|poweroff)\b/.test(structural)
    || /\b(dd\s+[^\n]*\bof=|git\s+reset\s+--hard|kubectl\s+delete|docker\s+system\s+prune|drop\s+(database|table)|truncate\s+table|kill\s+-9)\b/.test(structural)
  ) return 'destructive';
  if (
    /(^|[;&|]\s*|\bsudo\s+)(cp|mv|mkdir|touch|chmod|chown|install|tee|truncate|mount|umount|kill|apt|apt-get|yum|dnf|brew)\b/.test(structural)
    || /\b(systemctl|service)\s+(start|stop|restart|reload|enable|disable)\b/.test(structural)
    || /\b(kubectl\s+(apply|patch|scale)|docker\s+(start|stop|restart|rm)|sed\s+-i)\b/.test(structural)
    || /(^|[^<])>{1,2}([^>]|$)/.test(structural)
  ) return 'stateChange';
  return 'readOnly';
}

function riskRank(risk: RunbookRisk): number {
  return { readOnly: 0, stateChange: 1, destructive: 2 }[risk];
}

function validateReadOnlyArguments(program: string, args: string[], field: string): void {
  const combinedFlag = (flag: string): boolean => args.some((argument) => (
    argument === flag || (flag.length === 2 && /^-[^-]+$/.test(argument) && argument.includes(flag[1]))
  ));
  if (program === 'tail' && (combinedFlag('-f') || combinedFlag('-F') || args.some((argument) => argument.startsWith('--follow')))) {
    fail(`${field}.command cannot follow an unbounded stream`);
  }
  if (program === 'cat' && (
    !args.some((argument) => !argument.startsWith('-'))
    || args.some((argument) => /^\/dev\/(?:full|null|random|urandom|zero)$/.test(argument))
  )) fail(`${field}.command has no safe bounded input`);
  if (program === 'date' && args.some((argument) => !(
    argument === '-u'
    || argument === '--utc'
    || argument === '--help'
    || argument === '--version'
    || argument.startsWith('+')
    || argument.startsWith('--iso-8601')
    || argument.startsWith('--rfc-3339')
  ))) fail(`${field}.command contains a mutating date option`);
  if (program === 'hostname' && args.some((argument) => ![
    '-A', '-d', '-f', '-i', '-I', '-s', '--all-fqdns', '--all-ip-addresses', '--domain',
    '--fqdn', '--help', '--ip-address', '--short', '--version',
  ].includes(argument))) fail(`${field}.command contains a mutating hostname argument`);
  if (program === 'journalctl') {
    const forbidden = args.some((argument) => (
      combinedFlag('-f')
      || argument.startsWith('--follow')
      || ['--flush', '--relinquish-var', '--rotate', '--setup-keys', '--sync', '--update-catalog'].includes(argument)
      || argument.startsWith('--vacuum-')
    ));
    const bounded = args.some((argument, index) => (
      /^--lines=\d+$/.test(argument)
      || (argument === '--lines' && /^\d+$/.test(args[index + 1] ?? ''))
      || /^-n\d+$/.test(argument)
      || (argument === '-n' && /^\d+$/.test(args[index + 1] ?? ''))
    ));
    if (forbidden || !bounded) fail(`${field}.command must use a bounded, non-mutating journal query`);
  }
  if (program === 'ss' && args.some((argument) => argument === '-K' || argument === '--kill')) {
    fail(`${field}.command contains a mutating socket option`);
  }
  if (program === 'systemctl') {
    const action = args.find((argument) => !argument.startsWith('-'));
    if (!action || !['status', 'show', 'is-active', 'is-enabled', 'list-units', 'list-unit-files'].includes(action)) {
      fail(`${field}.command contains a mutating systemctl action`);
    }
  }
}

function validateDeclaredRisk(command: string, declared: RunbookRisk, field: string): void {
  const detected = commandRisk(command);
  if (riskRank(declared) < riskRank(detected)) fail(`${field}.risk understates detected ${detected} behavior`);
  if (declared === 'readOnly') {
    const normalized = command.replace(TEMPLATE_PATTERN, "'VALUE'");
    if (/[;&|`<>\n\r]/.test(normalized) || /\$\(/.test(normalized)) {
      fail(`${field}.command uses shell control syntax not allowed for readOnly actions`);
    }
    const program = normalized.trim().split(/\s+/, 1)[0];
    if (!READ_ONLY_PROGRAMS.has(program)) fail(`${field}.command is not in the readOnly command set`);
    validateReadOnlyArguments(program, normalized.trim().split(/\s+/).slice(1), field);
  }
}

function parseActionBase(value: unknown, field: string): RunbookPrecheck {
  const entry = objectValue(value, field);
  const command = stringValue(entry.command, `${field}.command`, MAX_COMMAND_LENGTH);
  if (hasSecretLiteral(command)) fail(`${field}.command appears to contain a literal secret; use a keychain variable`);
  return {
    id: idValue(entry.id, `${field}.id`),
    description: stringValue(entry.description, `${field}.description`),
    command,
    expected: parseExpected(entry.expected, `${field}.expected`),
    timeoutSeconds: integerValue(entry.timeoutSeconds, `${field}.timeoutSeconds`, 1, 300),
  };
}

function parsePrecheck(value: unknown, index: number): RunbookPrecheck {
  const field = `prechecks[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'description', 'command', 'expected', 'timeoutSeconds'], field);
  const precheck = parseActionBase(entry, field);
  validateDeclaredRisk(precheck.command, 'readOnly', field);
  return precheck;
}

function parseStep(value: unknown, index: number): RunbookStep {
  const field = `steps[${index}]`;
  const entry = objectValue(value, field);
  exactKeys(entry, ['id', 'description', 'command', 'expected', 'timeoutSeconds', 'risk', 'impact', 'safeToRetry'], field);
  const risk: RunbookRisk = entry.risk as RunbookRisk;
  if (risk !== 'readOnly' && risk !== 'stateChange' && risk !== 'destructive') fail(`${field}.risk is invalid`);
  if (typeof entry.safeToRetry !== 'boolean') fail(`${field}.safeToRetry must be boolean`);
  const step = {
    ...parseActionBase(entry, field),
    risk,
    impact: stringValue(entry.impact, `${field}.impact`),
    safeToRetry: entry.safeToRetry,
  };
  validateDeclaredRisk(step.command, step.risk, field);
  return step;
}

function placeholders(command: string): string[] {
  return [...command.matchAll(TEMPLATE_PATTERN)].map((match) => match[1]);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function interpolatePreview(
  command: string,
  variables: Map<string, RunbookVariable>,
  values: Record<string, string>,
): string {
  return command.replace(TEMPLATE_PATTERN, (_match, name: string) => {
    const variable = variables.get(name);
    if (!variable) fail(`command references undeclared variable ${name}`);
    if (variable.keychainRef) return shellQuote(`<${variable.keychainRef}>`);
    const value = values[name] ?? variable.default ?? '';
    if (variable.required && !value) fail(`variable ${name} is required`);
    return shellQuote(value);
  });
}

export function parseRunbookText(text: string): RunbookDocument {
  if (!text.trim()) fail('text is empty');
  if (text.length > MAX_TEXT_LENGTH) fail('text exceeds 512 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('text is not valid JSON');
  }
  const document = objectValue(value, 'document');
  exactKeys(document, [
    'schemaVersion', 'id', 'name', 'description', 'evidenceMaxAgeSeconds', 'variables', 'prechecks', 'steps',
  ], 'document');
  if (document.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!Array.isArray(document.variables) || document.variables.length > 32) fail('variables must contain at most 32 entries');
  if (!Array.isArray(document.prechecks) || document.prechecks.length === 0 || document.prechecks.length > 16) {
    fail('prechecks must contain 1-16 entries');
  }
  if (!Array.isArray(document.steps) || document.steps.length === 0 || document.steps.length > 64) {
    fail('steps must contain 1-64 entries');
  }
  const result: RunbookDocument = {
    schemaVersion: 1,
    id: idValue(document.id, 'id'),
    name: stringValue(document.name, 'name', 200),
    description: stringValue(document.description, 'description'),
    evidenceMaxAgeSeconds: integerValue(document.evidenceMaxAgeSeconds, 'evidenceMaxAgeSeconds', 30, 3600),
    variables: document.variables.map(parseVariable),
    prechecks: document.prechecks.map(parsePrecheck),
    steps: document.steps.map(parseStep),
  };
  const variableNames = new Set<string>();
  for (const variable of result.variables) {
    if (variableNames.has(variable.name)) fail(`duplicate variable ${variable.name}`);
    variableNames.add(variable.name);
  }
  const itemIds = new Set<string>();
  for (const item of [...result.prechecks, ...result.steps]) {
    if (itemIds.has(item.id)) fail(`duplicate action id ${item.id}`);
    itemIds.add(item.id);
    for (const name of placeholders(item.command)) {
      if (!variableNames.has(name)) fail(`action ${item.id} references undeclared variable ${name}`);
    }
  }
  return result;
}

export function serializeRunbook(document: RunbookDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function runbookSourceDigest(text: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export interface PreparedRunbook {
  document: RunbookDocument;
  sourceText: string;
  sourceDigest: string;
  target: RunbookTarget;
  resolvedVariables: Record<string, string>;
  items: RunbookRunItem[];
}

export function prepareRunbook(
  sourceText: string,
  values: Record<string, string>,
  target: RunbookTarget,
): PreparedRunbook {
  const document = parseRunbookText(sourceText);
  const variables = new Map(document.variables.map((variable) => [variable.name, variable]));
  const resolvedVariables = Object.fromEntries(document.variables.map((variable) => [
    variable.name,
    variable.keychainRef ? `<${variable.keychainRef}>` : values[variable.name] ?? variable.default ?? '',
  ]));
  for (const variable of document.variables) {
    if (variable.required && !variable.keychainRef && !resolvedVariables[variable.name]) {
      fail(`variable ${variable.name} is required`);
    }
  }
  const items: RunbookRunItem[] = [
    ...document.prechecks.map((precheck) => ({
      ...precheck,
      kind: 'precheck' as const,
      risk: 'readOnly' as const,
      impact: 'Read-only prerequisite evidence for this target.',
      safeToRetry: true,
      commandPreview: interpolatePreview(precheck.command, variables, values),
      status: 'queued' as const,
    })),
    ...document.steps.map((step) => ({
      ...step,
      kind: 'step' as const,
      commandPreview: interpolatePreview(step.command, variables, values),
      status: 'queued' as const,
    })),
  ];
  return {
    document,
    sourceText: serializeRunbook(document),
    sourceDigest: runbookSourceDigest(serializeRunbook(document)),
    target,
    resolvedVariables,
    items,
  };
}

function activeIndex(run: RunbookRun): number {
  return run.activeItemId ? run.items.findIndex((item) => item.id === run.activeItemId) : -1;
}

export function isRunbookEvidenceStale(
  evidence: RunbookRunItem['evidence'],
  maxAgeSeconds: number,
  now = Date.now(),
): boolean {
  return !evidence?.expectedMatched || now - evidence.completedAt >= maxAgeSeconds * 1000;
}

function prechecksFresh(run: RunbookRun, now: number): boolean {
  return run.items
    .filter((item) => item.kind === 'precheck')
    .every((item) => item.status === 'completed'
      && !isRunbookEvidenceStale(item.evidence, run.evidenceMaxAgeSeconds, now));
}

function advance(run: RunbookRun, now: number): RunbookRun {
  const next = run.items.find((item) => item.status === 'queued');
  if (!next) return { ...run, phase: 'completed', activeItemId: undefined, error: undefined };
  if (next.kind === 'step' && !prechecksFresh(run, now)) {
    return {
      ...run,
      phase: 'staleEvidence',
      activeItemId: undefined,
      error: 'Runbook prerequisite evidence is stale; retry from a safe precheck.',
    };
  }
  return {
    ...run,
    phase: 'awaitingApproval',
    activeItemId: next.id,
    error: undefined,
    items: run.items.map((item) => item.id === next.id
      ? { ...item, status: 'awaitingApproval' }
      : item),
  };
}

export function startRunbookRun(prepared: PreparedRunbook, runId: string, now = Date.now()): RunbookRun {
  return advance({
    id: runId,
    runbookId: prepared.document.id,
    sourceDigest: prepared.sourceDigest,
    target: prepared.target,
    resolvedVariables: prepared.resolvedVariables,
    startedAt: now,
    evidenceMaxAgeSeconds: prepared.document.evidenceMaxAgeSeconds,
    phase: 'awaitingApproval',
    items: prepared.items,
  }, now);
}

export function markRunbookItemRunning(run: RunbookRun, now = Date.now()): RunbookRun {
  if (run.phase !== 'awaitingApproval' || activeIndex(run) < 0) return run;
  const active = run.items[activeIndex(run)];
  if (active.kind === 'step' && !prechecksFresh(run, now)) {
    return {
      ...run,
      phase: 'staleEvidence',
      activeItemId: undefined,
      error: 'Runbook prerequisite evidence is stale; retry from a safe precheck.',
    };
  }
  return {
    ...run,
    phase: 'running',
    items: run.items.map((item) => item.id === run.activeItemId ? { ...item, status: 'running' } : item),
  };
}

export function applyRunbookStepResult(
  run: RunbookRun,
  result: RunbookStepExecutionResult,
  now = Date.now(),
): RunbookRun {
  const current = run.items.find((item) => item.id === run.activeItemId);
  if (
    run.phase !== 'running'
    || !current
    || result.runId !== run.id
    || result.sourceDigest !== run.sourceDigest
    || result.itemId !== current.id
    || result.profileId !== run.target.profileId
    || result.source.host !== run.target.host
    || result.source.port !== run.target.port
    || result.source.username !== run.target.username
  ) {
    return { ...run, phase: 'stopped', error: 'Runbook result identity mismatch.' };
  }
  const status = result.status === 'success'
    ? 'completed'
    : result.status === 'cancelled'
      ? 'cancelled'
      : result.status === 'timedOut'
        ? 'timedOut'
        : result.status === 'unauthorized'
          ? 'rejected'
          : 'failed';
  const updated: RunbookRun = {
    ...run,
    phase: status === 'completed' ? run.phase : status === 'cancelled' ? 'cancelled' : 'stopped',
    activeItemId: status === 'completed' ? undefined : current.id,
    error: status === 'completed' ? undefined : result.error ?? `Runbook item ${status}.`,
    items: run.items.map((item) => item.id === current.id
      ? {
          ...item,
          commandPreview: result.commandPreview,
          status,
          error: result.error,
          evidence: {
            operationId: result.operationId,
            profileId: result.profileId,
            host: result.source.host,
            port: result.source.port,
            username: result.source.username,
            startedAt: result.startedAt,
            completedAt: result.completedAt,
            exitCode: result.exitCode,
            expectedMatched: result.expectedMatched,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        }
      : item),
  };
  return status === 'completed' ? advance(updated, now) : updated;
}

export function rejectRunbookItem(run: RunbookRun): RunbookRun {
  if (run.phase !== 'awaitingApproval' || !run.activeItemId) return run;
  return {
    ...run,
    phase: 'stopped',
    error: 'Runbook step approval was rejected.',
    items: run.items.map((item) => item.id === run.activeItemId ? { ...item, status: 'rejected' } : item),
  };
}

export function pauseRunbook(run: RunbookRun): RunbookRun {
  return run.phase === 'awaitingApproval' ? { ...run, phase: 'paused' } : run;
}

export function resumeRunbook(run: RunbookRun, now = Date.now()): RunbookRun {
  if (run.phase !== 'paused' || !run.activeItemId) return run;
  const active = run.items.find((item) => item.id === run.activeItemId);
  if (active?.kind === 'step' && !prechecksFresh(run, now)) {
    return { ...run, phase: 'staleEvidence', activeItemId: undefined, error: 'Runbook prerequisite evidence is stale; retry from a safe precheck.' };
  }
  return { ...run, phase: 'awaitingApproval', error: undefined };
}

export function skipRunbookItem(run: RunbookRun, now = Date.now()): RunbookRun {
  if (run.phase !== 'awaitingApproval' || !run.activeItemId) return run;
  const active = run.items.find((item) => item.id === run.activeItemId);
  if (active?.kind !== 'step') return run;
  return advance({
    ...run,
    activeItemId: undefined,
    items: run.items.map((item) => item.id === active.id ? { ...item, status: 'skipped' } : item),
  }, now);
}

export function retryRunbookFrom(run: RunbookRun, itemId: string, now = Date.now()): RunbookRun {
  if (!['stopped', 'cancelled', 'staleEvidence'].includes(run.phase)) return run;
  const index = run.items.findIndex((item) => item.id === itemId);
  if (index < 0 || !run.items[index].safeToRetry) return run;
  const reset: RunbookRun = {
    ...run,
    phase: 'awaitingApproval',
    activeItemId: undefined,
    error: undefined,
    items: run.items.map((item, itemIndex) => itemIndex >= index
      ? { ...item, status: 'queued', evidence: undefined, error: undefined }
      : item),
  };
  return advance(reset, now);
}

export const RUNBOOK_EXAMPLE = `{
  "schemaVersion": 1,
  "id": "nginx-reload",
  "name": "Reload nginx safely",
  "description": "Validate nginx configuration before reloading the service.",
  "evidenceMaxAgeSeconds": 300,
  "variables": [
    {
      "name": "SERVICE",
      "description": "Service unit to inspect and reload.",
      "required": true,
      "default": "nginx"
    }
  ],
  "prechecks": [
    {
      "id": "service-status",
      "description": "Confirm the service currently exists.",
      "command": "systemctl status {{SERVICE}}",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 15
    }
  ],
  "steps": [
    {
      "id": "reload-service",
      "description": "Reload the validated service configuration.",
      "command": "sudo systemctl reload {{SERVICE}}",
      "risk": "stateChange",
      "impact": "Reloads the selected service without stopping it.",
      "expected": { "exitCode": 0 },
      "timeoutSeconds": 30,
      "safeToRetry": true
    }
  ]
}`;
