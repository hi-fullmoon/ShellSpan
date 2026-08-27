import agentDecisionSchemaV1 from '../../protocol/agent/v1/agent-decision.schema.json';
import {
  decodeAgentBudgetRequestV1,
  decodeAgentBudgetSnapshotV1,
  resolveAgentBudgetPolicyV1,
} from '@/lib/agent-budgets';
import {
  isAgentRunStateV1,
  isAgentToolCallStateV1,
} from '@/lib/agent-state';
import type {
  AgentActionKindV1,
  AgentActionResultV1,
  AgentActiveRunSummaryV1,
  AgentCommandErrorCategoryV1,
  AgentCommandErrorV1,
  AgentDecisionV1,
  AgentEventTypeV1,
  AgentEventV1,
  AgentEvidenceSourceV1,
  AgentEvidenceV1,
  AgentFinalReportFindingV1,
  AgentFinalReportV1,
  AgentFindingConfidenceV1,
  AgentNextActionV1,
  AgentPlanItemStatusV1,
  AgentPlanItemV1,
  AgentPlanUpdateV1,
  AgentPolicySnapshotV1,
  AgentProviderBindingV1,
  AgentProviderCapabilitiesV1,
  AgentProviderKindV1,
  AgentPublicErrorCategoryV1,
  AgentPublicErrorV1,
  AgentQuestionV1,
  AgentReportOutcomeV1,
  AgentRunSnapshotV1,
  AgentStartRequestV1,
  AgentStartResultV1,
  AgentTargetBindingV1,
  AgentTerminalContextV1,
  AgentToolCallSnapshotV1,
  AgentToolExecutionResultV1,
  AgentToolNameV1,
  AgentToolResultStatusV1,
  HostInspectArgsV1,
  HostInspectFieldV1,
  ShellExecReadOnlyArgsV1,
} from '@/types/agent';

export const AGENT_PROTOCOL_SCHEMA_VERSION_V1 = 1 as const;
export const MAX_AGENT_DECISION_BYTES_V1 = 64 * 1024;
export const AGENT_DECISION_SCHEMA_V1: Readonly<Record<string, unknown>> = agentDecisionSchemaV1;

const MAX_ID_CHARACTERS = 64;
const MAX_LABEL_CHARACTERS = 200;
const MAX_GOAL_CHARACTERS = 8 * 1024;
const MAX_TERMINAL_CONTEXT_CHARACTERS = 64 * 1024;
const MAX_RATIONALE_CHARACTERS = 1_000;
const MAX_PURPOSE_CHARACTERS = 1_000;
const MAX_SUCCESS_CRITERIA_CHARACTERS = 1_000;
const MAX_QUESTION_CHARACTERS = 4_000;
const MAX_REPORT_TEXT_CHARACTERS = 4_000;
const MAX_REPORT_ITEM_TEXT_CHARACTERS = 2_000;
const MAX_SHELL_ARGUMENTS = 32;
const MAX_SHELL_ARGUMENT_CHARACTERS = 512;

export type AgentProtocolDecodeErrorKind = 'tooLarge' | 'invalidJson' | 'invalidContract';

export class AgentProtocolDecodeError extends Error {
  readonly kind: AgentProtocolDecodeErrorKind;
  readonly field?: string;

  constructor(kind: AgentProtocolDecodeErrorKind, message: string, field?: string) {
    super(message);
    this.name = 'AgentProtocolDecodeError';
    this.kind = kind;
    this.field = field;
  }
}

function fail(message: string, field?: string): never {
  throw new AgentProtocolDecodeError('invalidContract', message, field);
}

function parseJson(raw: string, name: string, maxBytes?: number): unknown {
  if (maxBytes !== undefined && new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new AgentProtocolDecodeError('tooLarge', `${name} exceeds 64 KiB`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AgentProtocolDecodeError('invalidJson', `${name} is not a single JSON document`);
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${field} contains unknown field ${unknown}`, field);
}

function versionV1(value: unknown, field = 'schemaVersion'): 1 {
  if (value !== 1) fail(`${field} must be 1`, field);
  return 1;
}

function textValue(value: unknown, field: string, maxCharacters: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || [...value].length > maxCharacters
    || value.includes('\0')
  ) {
    return fail(`${field} must be a non-empty string of at most ${maxCharacters} characters`, field);
  }
  return value;
}

function optionalTextValue(
  value: unknown,
  field: string,
  maxCharacters: number,
): string | undefined {
  return value === undefined ? undefined : textValue(value, field, maxCharacters);
}

function optionalStringValue(
  value: unknown,
  field: string,
  maxCharacters: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || [...value].length > maxCharacters || value.includes('\0')) {
    return fail(`${field} must be a string of at most ${maxCharacters} characters`, field);
  }
  return value;
}

function identifierValue(value: unknown, field: string): string {
  const identifier = textValue(value, field, MAX_ID_CHARACTERS);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(identifier)) {
    return fail(`${field} is not a valid protocol identifier`, field);
  }
  return identifier;
}

function integerValue(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return fail(`${field} must be boolean`, field);
  return value;
}

function arrayValue(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return fail(`${field} must contain ${min}-${max} items`, field);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(`${field} contains an unknown enum value`, field);
  }
  return value as T;
}

function optionalOwn<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

const PLAN_STATUSES = ['pending', 'active', 'completed', 'skipped'] as const;
const HOST_INSPECT_FIELDS = [
  'os', 'kernel', 'architecture', 'identity', 'uptime', 'capabilities',
] as const;
const REPORT_OUTCOMES = ['resolved', 'diagnosed', 'inconclusive', 'blocked'] as const;
const FINDING_CONFIDENCES = ['verified', 'likely', 'uncertain'] as const;

function decodePlanItemV1(value: unknown, field: string): AgentPlanItemV1 {
  const item = objectValue(value, field);
  exactKeys(item, ['id', 'title', 'status'], field);
  return {
    id: identifierValue(item.id, `${field}.id`),
    title: textValue(item.title, `${field}.title`, MAX_LABEL_CHARACTERS),
    status: enumValue<AgentPlanItemStatusV1>(item.status, PLAN_STATUSES, `${field}.status`),
  };
}

function decodePlanV1(value: unknown): AgentPlanUpdateV1 {
  const plan = objectValue(value, 'plan');
  exactKeys(plan, ['items'], 'plan');
  const items = arrayValue(plan.items, 'plan.items', 8).map((item, index) => (
    decodePlanItemV1(item, `plan.items[${index}]`)
  ));
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) fail('plan.items contains duplicate IDs', 'plan.items');
  if (items.filter((item) => item.status === 'active').length > 1) {
    fail('plan.items may contain at most one active item', 'plan.items');
  }
  return { items };
}

function decodeHostInspectArgsV1(value: unknown): HostInspectArgsV1 {
  const args = objectValue(value, 'arguments');
  exactKeys(args, ['include'], 'arguments');
  const include = arrayValue(args.include, 'arguments.include', 6, 1).map((field, index) => (
    enumValue<HostInspectFieldV1>(field, HOST_INSPECT_FIELDS, `arguments.include[${index}]`)
  ));
  if (new Set(include).size !== include.length) fail('arguments.include contains duplicates');
  return { include };
}

function decodeShellArgsV1(value: unknown): ShellExecReadOnlyArgsV1 {
  const args = objectValue(value, 'arguments');
  exactKeys(args, ['program', 'args', 'timeoutSeconds'], 'arguments');
  const program = textValue(args.program, 'arguments.program', MAX_ID_CHARACTERS);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(program)) {
    fail('arguments.program must be a bare program name', 'arguments.program');
  }
  const decodedArgs = arrayValue(args.args, 'arguments.args', MAX_SHELL_ARGUMENTS).map((argument, index) => {
    if (
      typeof argument !== 'string'
      || [...argument].length > MAX_SHELL_ARGUMENT_CHARACTERS
      || [...argument].some((character) => /[\u0000-\u001f\u007f-\u009f]/u.test(character))
    ) {
      return fail(`arguments.args[${index}] is invalid`, `arguments.args[${index}]`);
    }
    return argument;
  });
  const timeoutSeconds = args.timeoutSeconds === undefined
    ? undefined
    : integerValue(args.timeoutSeconds, 'arguments.timeoutSeconds', 1, 60);
  return { program, args: decodedArgs, ...optionalOwn(timeoutSeconds, 'timeoutSeconds') };
}

function decodeFindingV1(value: unknown, index: number): AgentFinalReportFindingV1 {
  const field = `report.findings[${index}]`;
  const finding = objectValue(value, field);
  exactKeys(finding, ['title', 'detail', 'confidence', 'evidenceIds'], field);
  const confidence = enumValue<AgentFindingConfidenceV1>(
    finding.confidence,
    FINDING_CONFIDENCES,
    `${field}.confidence`,
  );
  const evidenceIds = arrayValue(finding.evidenceIds, `${field}.evidenceIds`, 32).map((id, idIndex) => (
    identifierValue(id, `${field}.evidenceIds[${idIndex}]`)
  ));
  if (confidence === 'verified' && evidenceIds.length === 0) {
    fail(`${field} verified finding requires evidence`, `${field}.evidenceIds`);
  }
  return {
    title: textValue(finding.title, `${field}.title`, MAX_LABEL_CHARACTERS),
    detail: textValue(finding.detail, `${field}.detail`, MAX_REPORT_TEXT_CHARACTERS),
    confidence,
    evidenceIds,
  };
}

function decodeNextActionV1(value: unknown, index: number): AgentNextActionV1 {
  const field = `report.nextActions[${index}]`;
  const action = objectValue(value, field);
  exactKeys(action, ['title', 'requiresChange'], field);
  return {
    title: textValue(action.title, `${field}.title`, MAX_REPORT_ITEM_TEXT_CHARACTERS),
    requiresChange: booleanValue(action.requiresChange, `${field}.requiresChange`),
  };
}

function decodeFinalReportV1(value: unknown): AgentFinalReportV1 {
  const report = objectValue(value, 'report');
  exactKeys(report, ['outcome', 'summary', 'findings', 'changes', 'warnings', 'nextActions'], 'report');
  const changes = arrayValue(report.changes, 'report.changes', 0);
  if (changes.length !== 0) fail('report.changes must remain empty in P1', 'report.changes');
  return {
    outcome: enumValue<AgentReportOutcomeV1>(report.outcome, REPORT_OUTCOMES, 'report.outcome'),
    summary: textValue(report.summary, 'report.summary', MAX_REPORT_TEXT_CHARACTERS),
    findings: arrayValue(report.findings, 'report.findings', 16).map(decodeFindingV1),
    changes: [],
    warnings: arrayValue(report.warnings, 'report.warnings', 16).map((warning, index) => (
      textValue(warning, `report.warnings[${index}]`, MAX_REPORT_ITEM_TEXT_CHARACTERS)
    )),
    nextActions: arrayValue(report.nextActions, 'report.nextActions', 16).map(decodeNextActionV1),
  };
}

export function decodeAgentDecisionV1(raw: string): AgentDecisionV1 {
  const decision = objectValue(
    parseJson(raw, 'Agent decision', MAX_AGENT_DECISION_BYTES_V1),
    'Agent decision',
  );
  versionV1(decision.schemaVersion);
  const kind = enumValue(decision.kind, ['toolCall', 'askUser', 'final'] as const, 'kind');
  const rationale = textValue(decision.rationale, 'rationale', MAX_RATIONALE_CHARACTERS);
  const plan = decodePlanV1(decision.plan);

  if (kind === 'toolCall') {
    exactKeys(
      decision,
      ['schemaVersion', 'kind', 'rationale', 'plan', 'tool', 'arguments', 'purpose', 'successCriteria'],
      'Agent decision',
    );
    const purpose = textValue(decision.purpose, 'purpose', MAX_PURPOSE_CHARACTERS);
    const successCriteria = textValue(
      decision.successCriteria,
      'successCriteria',
      MAX_SUCCESS_CRITERIA_CHARACTERS,
    );
    const tool = enumValue<AgentToolNameV1>(
      decision.tool,
      ['host.inspect', 'shell.execReadOnly'],
      'tool',
    );
    if (tool === 'host.inspect') {
      return {
        schemaVersion: 1,
        kind,
        rationale,
        plan,
        tool,
        arguments: decodeHostInspectArgsV1(decision.arguments),
        purpose,
        successCriteria,
      };
    }
    return {
      schemaVersion: 1,
      kind,
      rationale,
      plan,
      tool,
      arguments: decodeShellArgsV1(decision.arguments),
      purpose,
      successCriteria,
    };
  }

  if (kind === 'askUser') {
    exactKeys(decision, ['schemaVersion', 'kind', 'rationale', 'plan', 'question'], 'Agent decision');
    return {
      schemaVersion: 1,
      kind,
      rationale,
      plan,
      question: textValue(decision.question, 'question', MAX_QUESTION_CHARACTERS),
    };
  }

  exactKeys(decision, ['schemaVersion', 'kind', 'rationale', 'plan', 'report'], 'Agent decision');
  return {
    schemaVersion: 1,
    kind,
    rationale,
    plan,
    report: decodeFinalReportV1(decision.report),
  };
}

function decodeTerminalContextV1(value: unknown): AgentTerminalContextV1 {
  const context = objectValue(value, 'terminalContext');
  exactKeys(context, ['sessionId', 'capturedAt', 'label', 'redactedText', 'truncated'], 'terminalContext');
  if (
    typeof context.redactedText !== 'string'
    || [...context.redactedText].length > MAX_TERMINAL_CONTEXT_CHARACTERS
    || context.redactedText.includes('\0')
  ) {
    fail('terminalContext.redactedText is invalid', 'terminalContext.redactedText');
  }
  return {
    sessionId: identifierValue(context.sessionId, 'terminalContext.sessionId'),
    capturedAt: integerValue(context.capturedAt, 'terminalContext.capturedAt'),
    label: textValue(context.label, 'terminalContext.label', MAX_LABEL_CHARACTERS),
    redactedText: context.redactedText,
    truncated: booleanValue(context.truncated, 'terminalContext.truncated'),
  };
}

export function decodeAgentStartRequestV1(raw: string | unknown): AgentStartRequestV1 {
  const value = typeof raw === 'string' ? parseJson(raw, 'Agent start request') : raw;
  const request = objectValue(value, 'Agent start request');
  exactKeys(
    request,
    ['schemaVersion', 'clientRequestId', 'goal', 'profileId', 'providerId', 'terminalContext', 'requestedBudgets'],
    'Agent start request',
  );
  versionV1(request.schemaVersion);
  const terminalContext = request.terminalContext === undefined
    ? undefined
    : decodeTerminalContextV1(request.terminalContext);
  const requestedBudgets = request.requestedBudgets === undefined
    ? undefined
    : decodeAgentBudgetRequestV1(request.requestedBudgets);
  if (requestedBudgets) resolveAgentBudgetPolicyV1(requestedBudgets);
  return {
    schemaVersion: 1,
    clientRequestId: identifierValue(request.clientRequestId, 'clientRequestId'),
    goal: textValue(request.goal, 'goal', MAX_GOAL_CHARACTERS),
    profileId: identifierValue(request.profileId, 'profileId'),
    providerId: identifierValue(request.providerId, 'providerId'),
    ...optionalOwn(terminalContext, 'terminalContext'),
    ...optionalOwn(requestedBudgets, 'requestedBudgets'),
  };
}

const PUBLIC_ERROR_CATEGORIES = [
  'agentBusy',
  'targetUnavailable',
  'providerIncompatible',
  'providerUnavailable',
  'providerProtocol',
  'toolDenied',
  'toolFailed',
  'budgetExceeded',
  'cancelled',
  'internal',
] as const;

export function decodeAgentPublicErrorV1(value: unknown): AgentPublicErrorV1 {
  const error = objectValue(value, 'Agent public error');
  exactKeys(error, ['schemaVersion', 'category', 'message', 'retryable', 'suggestion'], 'Agent public error');
  versionV1(error.schemaVersion, 'Agent public error.schemaVersion');
  const suggestion = optionalTextValue(error.suggestion, 'Agent public error.suggestion', 2_000);
  return {
    schemaVersion: 1,
    category: enumValue<AgentPublicErrorCategoryV1>(
      error.category,
      PUBLIC_ERROR_CATEGORIES,
      'Agent public error.category',
    ),
    message: textValue(error.message, 'Agent public error.message', 2_000),
    retryable: booleanValue(error.retryable, 'Agent public error.retryable'),
    ...optionalOwn(suggestion, 'suggestion'),
  };
}

const EVENT_TYPES = [
  'run.created',
  'run.stateChanged',
  'plan.updated',
  'model.started',
  'model.completed',
  'tool.proposed',
  'tool.stateChanged',
  'evidence.created',
  'budget.updated',
  'user.messageAccepted',
  'run.reportCreated',
  'run.warning',
  'run.terminal',
] as const satisfies readonly AgentEventTypeV1[];

export function decodeAgentEventV1(value: unknown): AgentEventV1 {
  const event = objectValue(value, 'Agent event');
  exactKeys(event, ['schemaVersion', 'runId', 'sequence', 'occurredAt', 'type', 'payload'], 'Agent event');
  return {
    schemaVersion: versionV1(event.schemaVersion, 'Agent event.schemaVersion'),
    runId: identifierValue(event.runId, 'Agent event.runId'),
    sequence: integerValue(event.sequence, 'Agent event.sequence', 1),
    occurredAt: integerValue(event.occurredAt, 'Agent event.occurredAt'),
    type: enumValue<AgentEventTypeV1>(event.type, EVENT_TYPES, 'Agent event.type'),
    payload: event.payload,
  };
}

function decodeProviderCapabilitiesV1(value: unknown): AgentProviderCapabilitiesV1 {
  const capabilities = objectValue(value, 'provider.capabilities');
  exactKeys(
    capabilities,
    ['streaming', 'strictJsonSchema', 'nativeToolCalling', 'usageReporting', 'responseContinuation'],
    'provider.capabilities',
  );
  return {
    streaming: booleanValue(capabilities.streaming, 'provider.capabilities.streaming'),
    strictJsonSchema: booleanValue(capabilities.strictJsonSchema, 'provider.capabilities.strictJsonSchema'),
    nativeToolCalling: booleanValue(capabilities.nativeToolCalling, 'provider.capabilities.nativeToolCalling'),
    usageReporting: booleanValue(capabilities.usageReporting, 'provider.capabilities.usageReporting'),
    responseContinuation: booleanValue(
      capabilities.responseContinuation,
      'provider.capabilities.responseContinuation',
    ),
  };
}

function decodeProviderBindingV1(value: unknown): AgentProviderBindingV1 {
  const provider = objectValue(value, 'provider');
  exactKeys(provider, ['providerId', 'kind', 'baseUrl', 'model', 'capabilities'], 'provider');
  return {
    providerId: identifierValue(provider.providerId, 'provider.providerId'),
    kind: enumValue<AgentProviderKindV1>(
      provider.kind,
      ['ollama', 'openAi', 'openAiCompatible'],
      'provider.kind',
    ),
    baseUrl: textValue(provider.baseUrl, 'provider.baseUrl', 2_000),
    model: textValue(provider.model, 'provider.model', 200),
    capabilities: decodeProviderCapabilitiesV1(provider.capabilities),
  };
}

function decodeTargetBindingV1(value: unknown): AgentTargetBindingV1 {
  const target = objectValue(value, 'target');
  exactKeys(
    target,
    ['profileId', 'profileLabel', 'host', 'port', 'username', 'authMethod', 'jumpHost', 'targetDigest'],
    'target',
  );
  let jumpHost: AgentTargetBindingV1['jumpHost'];
  if (target.jumpHost !== undefined) {
    const jump = objectValue(target.jumpHost, 'target.jumpHost');
    exactKeys(jump, ['host', 'port', 'username', 'authMethod'], 'target.jumpHost');
    jumpHost = {
      host: textValue(jump.host, 'target.jumpHost.host', 1_024),
      port: integerValue(jump.port, 'target.jumpHost.port', 1, 65_535),
      username: textValue(jump.username, 'target.jumpHost.username', 256),
      authMethod: textValue(jump.authMethod, 'target.jumpHost.authMethod', 64),
    };
  }
  return {
    profileId: identifierValue(target.profileId, 'target.profileId'),
    profileLabel: textValue(target.profileLabel, 'target.profileLabel', 200),
    host: textValue(target.host, 'target.host', 1_024),
    port: integerValue(target.port, 'target.port', 1, 65_535),
    username: textValue(target.username, 'target.username', 256),
    authMethod: textValue(target.authMethod, 'target.authMethod', 64),
    ...optionalOwn(jumpHost, 'jumpHost'),
    targetDigest: textValue(target.targetDigest, 'target.targetDigest', 200),
  };
}

function decodePolicySnapshotV1(value: unknown): AgentPolicySnapshotV1 {
  const policy = objectValue(value, 'policy');
  exactKeys(policy, ['mode', 'policyVersion', 'toolRegistryVersion', 'allowedTools'], 'policy');
  if (policy.mode !== 'readOnly') fail('policy.mode contains an unknown enum value', 'policy.mode');
  const allowedTools = arrayValue(policy.allowedTools, 'policy.allowedTools', 2).map((tool, index) => (
    enumValue<AgentToolNameV1>(tool, ['host.inspect', 'shell.execReadOnly'], `policy.allowedTools[${index}]`)
  ));
  if (new Set(allowedTools).size !== allowedTools.length) fail('policy.allowedTools contains duplicates');
  return {
    mode: 'readOnly',
    policyVersion: identifierValue(policy.policyVersion, 'policy.policyVersion'),
    toolRegistryVersion: identifierValue(policy.toolRegistryVersion, 'policy.toolRegistryVersion'),
    allowedTools,
  };
}

const EVIDENCE_SOURCES = ['terminalSnapshot', 'host.inspect', 'shell.execReadOnly'] as const;

function decodeEvidenceV1(value: unknown, index: number): AgentEvidenceV1 {
  const field = `evidence[${index}]`;
  const evidence = objectValue(value, field);
  exactKeys(
    evidence,
    [
      'evidenceId', 'runId', 'targetDigest', 'source', 'toolCallId', 'observedAt', 'summary',
      'stdoutExcerpt', 'stderrExcerpt', 'exitCode', 'truncated', 'observationDigest',
    ],
    field,
  );
  const toolCallId = evidence.toolCallId === undefined
    ? undefined
    : identifierValue(evidence.toolCallId, `${field}.toolCallId`);
  const stdoutExcerpt = optionalStringValue(evidence.stdoutExcerpt, `${field}.stdoutExcerpt`, 256 * 1024);
  const stderrExcerpt = optionalStringValue(evidence.stderrExcerpt, `${field}.stderrExcerpt`, 64 * 1024);
  const exitCode = evidence.exitCode === undefined
    ? undefined
    : integerValue(evidence.exitCode, `${field}.exitCode`, -2_147_483_648, 2_147_483_647);
  return {
    evidenceId: identifierValue(evidence.evidenceId, `${field}.evidenceId`),
    runId: identifierValue(evidence.runId, `${field}.runId`),
    targetDigest: textValue(evidence.targetDigest, `${field}.targetDigest`, 200),
    source: enumValue<AgentEvidenceSourceV1>(evidence.source, EVIDENCE_SOURCES, `${field}.source`),
    ...optionalOwn(toolCallId, 'toolCallId'),
    observedAt: integerValue(evidence.observedAt, `${field}.observedAt`),
    summary: textValue(evidence.summary, `${field}.summary`, 4_000),
    ...optionalOwn(stdoutExcerpt, 'stdoutExcerpt'),
    ...optionalOwn(stderrExcerpt, 'stderrExcerpt'),
    ...optionalOwn(exitCode, 'exitCode'),
    truncated: booleanValue(evidence.truncated, `${field}.truncated`),
    observationDigest: textValue(evidence.observationDigest, `${field}.observationDigest`, 200),
  };
}

const TOOL_RESULT_STATUSES = ['completed', 'failed', 'timedOut', 'cancelled', 'denied'] as const;

function decodeToolResultV1(value: unknown): AgentToolExecutionResultV1 {
  const result = objectValue(value, 'toolCall.result');
  exactKeys(
    result,
    [
      'schemaVersion', 'runId', 'toolCallId', 'status', 'startedAt', 'completedAt', 'exitCode',
      'stdoutExcerpt', 'stderrExcerpt', 'stdoutBytesCaptured', 'stderrBytesCaptured',
      'stdoutBytesRead', 'stderrBytesRead', 'stdoutTruncated', 'stderrTruncated', 'error',
    ],
    'toolCall.result',
  );
  const exitCode = result.exitCode === undefined
    ? undefined
    : integerValue(result.exitCode, 'toolCall.result.exitCode', -2_147_483_648, 2_147_483_647);
  const error = result.error === undefined ? undefined : decodeAgentPublicErrorV1(result.error);
  return {
    schemaVersion: versionV1(result.schemaVersion, 'toolCall.result.schemaVersion'),
    runId: identifierValue(result.runId, 'toolCall.result.runId'),
    toolCallId: identifierValue(result.toolCallId, 'toolCall.result.toolCallId'),
    status: enumValue<AgentToolResultStatusV1>(result.status, TOOL_RESULT_STATUSES, 'toolCall.result.status'),
    startedAt: integerValue(result.startedAt, 'toolCall.result.startedAt'),
    completedAt: integerValue(result.completedAt, 'toolCall.result.completedAt'),
    ...optionalOwn(exitCode, 'exitCode'),
    stdoutExcerpt: typeof result.stdoutExcerpt === 'string'
      ? result.stdoutExcerpt
      : fail('toolCall.result.stdoutExcerpt must be a string'),
    stderrExcerpt: typeof result.stderrExcerpt === 'string'
      ? result.stderrExcerpt
      : fail('toolCall.result.stderrExcerpt must be a string'),
    stdoutBytesCaptured: integerValue(result.stdoutBytesCaptured, 'toolCall.result.stdoutBytesCaptured'),
    stderrBytesCaptured: integerValue(result.stderrBytesCaptured, 'toolCall.result.stderrBytesCaptured'),
    stdoutBytesRead: integerValue(result.stdoutBytesRead, 'toolCall.result.stdoutBytesRead'),
    stderrBytesRead: integerValue(result.stderrBytesRead, 'toolCall.result.stderrBytesRead'),
    stdoutTruncated: booleanValue(result.stdoutTruncated, 'toolCall.result.stdoutTruncated'),
    stderrTruncated: booleanValue(result.stderrTruncated, 'toolCall.result.stderrTruncated'),
    ...optionalOwn(error, 'error'),
  };
}

function decodeToolCallSnapshotV1(value: unknown, index: number): AgentToolCallSnapshotV1 {
  const field = `toolCalls[${index}]`;
  const toolCall = objectValue(value, field);
  exactKeys(
    toolCall,
    [
      'toolCallId', 'state', 'tool', 'arguments', 'rationale', 'purpose', 'successCriteria',
      'proposedAt', 'operationId', 'commandPreview', 'result', 'evidenceIds',
    ],
    field,
  );
  if (!isAgentToolCallStateV1(toolCall.state)) fail(`${field}.state contains an unknown enum value`);
  const tool = enumValue<AgentToolNameV1>(
    toolCall.tool,
    ['host.inspect', 'shell.execReadOnly'],
    `${field}.tool`,
  );
  const operationId = toolCall.operationId === undefined
    ? undefined
    : identifierValue(toolCall.operationId, `${field}.operationId`);
  const commandPreview = optionalTextValue(toolCall.commandPreview, `${field}.commandPreview`, 8 * 1024);
  const result = toolCall.result === undefined ? undefined : decodeToolResultV1(toolCall.result);
  return {
    toolCallId: identifierValue(toolCall.toolCallId, `${field}.toolCallId`),
    state: toolCall.state,
    tool,
    arguments: tool === 'host.inspect'
      ? decodeHostInspectArgsV1(toolCall.arguments)
      : decodeShellArgsV1(toolCall.arguments),
    rationale: textValue(toolCall.rationale, `${field}.rationale`, MAX_RATIONALE_CHARACTERS),
    purpose: textValue(toolCall.purpose, `${field}.purpose`, MAX_PURPOSE_CHARACTERS),
    successCriteria: textValue(
      toolCall.successCriteria,
      `${field}.successCriteria`,
      MAX_SUCCESS_CRITERIA_CHARACTERS,
    ),
    proposedAt: integerValue(toolCall.proposedAt, `${field}.proposedAt`),
    ...optionalOwn(operationId, 'operationId'),
    ...optionalOwn(commandPreview, 'commandPreview'),
    ...optionalOwn(result, 'result'),
    evidenceIds: arrayValue(toolCall.evidenceIds, `${field}.evidenceIds`, 32).map((id, idIndex) => (
      identifierValue(id, `${field}.evidenceIds[${idIndex}]`)
    )),
  };
}

function decodeQuestionV1(value: unknown): AgentQuestionV1 {
  const question = objectValue(value, 'pendingQuestion');
  exactKeys(question, ['questionId', 'question', 'askedAt'], 'pendingQuestion');
  return {
    questionId: identifierValue(question.questionId, 'pendingQuestion.questionId'),
    question: textValue(question.question, 'pendingQuestion.question', MAX_QUESTION_CHARACTERS),
    askedAt: integerValue(question.askedAt, 'pendingQuestion.askedAt'),
  };
}

export function decodeAgentRunSnapshotV1(value: unknown): AgentRunSnapshotV1 {
  const snapshot = objectValue(value, 'Agent run snapshot');
  exactKeys(
    snapshot,
    [
      'schemaVersion', 'runId', 'lastSequence', 'state', 'target', 'provider', 'policy', 'budgets',
      'goal', 'plan', 'toolCalls', 'evidence', 'pendingQuestion', 'queuedSteeringCount', 'report', 'error',
    ],
    'Agent run snapshot',
  );
  if (!isAgentRunStateV1(snapshot.state)) fail('Agent run snapshot.state contains an unknown enum value');
  const pendingQuestion = snapshot.pendingQuestion === undefined
    ? undefined
    : decodeQuestionV1(snapshot.pendingQuestion);
  const report = snapshot.report === undefined ? undefined : decodeFinalReportV1(snapshot.report);
  const error = snapshot.error === undefined ? undefined : decodeAgentPublicErrorV1(snapshot.error);
  return {
    schemaVersion: versionV1(snapshot.schemaVersion, 'Agent run snapshot.schemaVersion'),
    runId: identifierValue(snapshot.runId, 'Agent run snapshot.runId'),
    lastSequence: integerValue(snapshot.lastSequence, 'Agent run snapshot.lastSequence'),
    state: snapshot.state,
    target: decodeTargetBindingV1(snapshot.target),
    provider: decodeProviderBindingV1(snapshot.provider),
    policy: decodePolicySnapshotV1(snapshot.policy),
    budgets: decodeAgentBudgetSnapshotV1(snapshot.budgets),
    goal: textValue(snapshot.goal, 'Agent run snapshot.goal', MAX_GOAL_CHARACTERS),
    plan: arrayValue(snapshot.plan, 'Agent run snapshot.plan', 8).map((item, index) => (
      decodePlanItemV1(item, `Agent run snapshot.plan[${index}]`)
    )),
    toolCalls: arrayValue(snapshot.toolCalls, 'Agent run snapshot.toolCalls', 15).map(decodeToolCallSnapshotV1),
    evidence: arrayValue(snapshot.evidence, 'Agent run snapshot.evidence', 32).map(decodeEvidenceV1),
    ...optionalOwn(pendingQuestion, 'pendingQuestion'),
    queuedSteeringCount: integerValue(snapshot.queuedSteeringCount, 'Agent run snapshot.queuedSteeringCount', 0, 16),
    ...optionalOwn(report, 'report'),
    ...optionalOwn(error, 'error'),
  };
}

const COMMAND_ERROR_CATEGORIES = [
  'invalidRequest',
  'agentBusy',
  'runNotFound',
  'idempotencyConflict',
  'invalidState',
  'p1Blocked',
  'internal',
] as const satisfies readonly AgentCommandErrorCategoryV1[];

const ACTION_KINDS = [
  'pause',
  'resume',
  'stop',
  'sendMessage',
] as const satisfies readonly AgentActionKindV1[];

function decodeActiveRunSummaryV1(value: unknown): AgentActiveRunSummaryV1 {
  const summary = objectValue(value, 'Agent active run summary');
  exactKeys(
    summary,
    ['runId', 'state', 'goal', 'profileId', 'startedAt'],
    'Agent active run summary',
  );
  if (!isAgentRunStateV1(summary.state)) {
    fail('Agent active run summary.state contains an unknown enum value');
  }
  return {
    runId: identifierValue(summary.runId, 'Agent active run summary.runId'),
    state: summary.state,
    goal: textValue(summary.goal, 'Agent active run summary.goal', MAX_GOAL_CHARACTERS),
    profileId: identifierValue(summary.profileId, 'Agent active run summary.profileId'),
    startedAt: integerValue(summary.startedAt, 'Agent active run summary.startedAt'),
  };
}

export function decodeAgentStartResultV1(value: unknown): AgentStartResultV1 {
  const result = objectValue(value, 'Agent start result');
  exactKeys(result, ['schemaVersion', 'runId', 'acceptedAt'], 'Agent start result');
  return {
    schemaVersion: versionV1(result.schemaVersion, 'Agent start result.schemaVersion'),
    runId: identifierValue(result.runId, 'Agent start result.runId'),
    acceptedAt: integerValue(result.acceptedAt, 'Agent start result.acceptedAt'),
  };
}

export function decodeAgentActionResultV1(value: unknown): AgentActionResultV1 {
  const result = objectValue(value, 'Agent action result');
  exactKeys(
    result,
    ['schemaVersion', 'runId', 'clientActionId', 'action', 'acceptedAt', 'resultingSequence'],
    'Agent action result',
  );
  return {
    schemaVersion: versionV1(result.schemaVersion, 'Agent action result.schemaVersion'),
    runId: identifierValue(result.runId, 'Agent action result.runId'),
    clientActionId: identifierValue(result.clientActionId, 'Agent action result.clientActionId'),
    action: enumValue<AgentActionKindV1>(result.action, ACTION_KINDS, 'Agent action result.action'),
    acceptedAt: integerValue(result.acceptedAt, 'Agent action result.acceptedAt'),
    resultingSequence: integerValue(
      result.resultingSequence,
      'Agent action result.resultingSequence',
    ),
  };
}

export function decodeAgentCommandErrorV1(value: unknown): AgentCommandErrorV1 {
  const error = objectValue(value, 'Agent command error');
  exactKeys(
    error,
    ['schemaVersion', 'category', 'message', 'activeRun'],
    'Agent command error',
  );
  const activeRun = error.activeRun === undefined
    ? undefined
    : decodeActiveRunSummaryV1(error.activeRun);
  return {
    schemaVersion: versionV1(error.schemaVersion, 'Agent command error.schemaVersion'),
    category: enumValue<AgentCommandErrorCategoryV1>(
      error.category,
      COMMAND_ERROR_CATEGORIES,
      'Agent command error.category',
    ),
    message: textValue(error.message, 'Agent command error.message', 2_000),
    ...optionalOwn(activeRun, 'activeRun'),
  };
}

export function parseAgentCommandErrorV1(value: unknown): AgentCommandErrorV1 {
  const candidates: unknown[] = [value];
  if (value instanceof Error) candidates.push(value.message);
  if (value && typeof value === 'object' && 'message' in value) {
    candidates.push((value as { message?: unknown }).message);
  }
  for (const candidate of candidates) {
    try {
      const decoded = typeof candidate === 'string'
        ? JSON.parse(candidate) as unknown
        : candidate;
      return decodeAgentCommandErrorV1(decoded);
    } catch {
      // Continue without echoing an untrusted transport or provider body.
    }
  }
  return {
    schemaVersion: 1,
    category: 'internal',
    message: 'The Agent command failed before a versioned error was returned.',
  };
}
