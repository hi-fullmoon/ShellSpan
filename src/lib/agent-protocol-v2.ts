import agentDecisionSchemaV2 from '../../protocol/agent/v2/agent-decision.schema.json';
import agentEventSchemaV2 from '../../protocol/agent/v2/agent-events.schema.json';
import agentSnapshotSchemaV2 from '../../protocol/agent/v2/agent-snapshot.schema.json';
import {
  canTransitionAgentRunStateV2,
  canTransitionAgentToolCallStateV2,
  isAgentApprovalStateV2,
  isAgentRunStateV2,
  isAgentToolCallStateV2,
  isAgentVerificationStateV2,
} from '@/lib/agent-state-v2';
import type {
  AgentApprovalSnapshotV2,
  AgentBudgetRequestV2,
  AgentBudgetSnapshotV2,
  AgentChangeReportV2,
  AgentChangeSnapshotV2,
  AgentDecisionV2,
  AgentEventTypeV2,
  AgentEventV2,
  AgentEvidenceSourceV2,
  AgentEvidenceV2,
  AgentFinalReportFindingV2,
  AgentFinalReportV2,
  AgentNextActionV2,
  AgentPolicySnapshotV2,
  AgentProviderBindingV2,
  AgentPublicErrorV2,
  AgentResourceRefV2,
  AgentRiskAssessmentV2,
  AgentRunNonTerminalStateV2,
  AgentRunSnapshotV2,
  AgentStartRequestV2,
  AgentTargetBindingV2,
  AgentTerminalContextV2,
  AgentToolCallSnapshotV2,
  AgentToolCallNonTerminalStateV2,
  AgentToolExecutionResultV2,
  AgentToolNameV2,
  AgentToolResultStatusV2,
  AgentVerificationSnapshotV2,
  ServiceControlArgsV2,
  ServiceInspectArgsV2,
  ServiceInspectFieldV2,
  ServiceValidateConfigArgsV2,
} from '@/types/agent-v2';
import type {
  AgentFindingConfidenceV1,
  AgentPlanItemStatusV1,
  AgentPlanItemV1,
  AgentPlanUpdateV1,
  HostInspectArgsV1,
  HostInspectFieldV1,
  ShellExecReadOnlyArgsV1,
} from '@/types/agent';

export const AGENT_PROTOCOL_SCHEMA_VERSION_V2 = 2 as const;
export const MAX_AGENT_DECISION_BYTES_V2 = 64 * 1024;
export const AGENT_DECISION_SCHEMA_V2: Readonly<Record<string, unknown>> = agentDecisionSchemaV2;
export const AGENT_EVENT_SCHEMA_V2: Readonly<Record<string, unknown>> = agentEventSchemaV2;
export const AGENT_SNAPSHOT_SCHEMA_V2: Readonly<Record<string, unknown>> = agentSnapshotSchemaV2;

const MAX_ID_CHARACTERS = 64;
const MAX_LABEL_CHARACTERS = 200;
const MAX_GOAL_CHARACTERS = 8 * 1024;
const MAX_TERMINAL_CONTEXT_CHARACTERS = 64 * 1024;
const MAX_RATIONALE_CHARACTERS = 1_000;
const MAX_TOOL_TEXT_CHARACTERS = 1_000;
const MAX_QUESTION_CHARACTERS = 4_000;
const MAX_REPORT_TEXT_CHARACTERS = 4_000;
const MAX_REPORT_ITEM_TEXT_CHARACTERS = 2_000;

export type AgentProtocolDecodeErrorKindV2 = 'tooLarge' | 'invalidJson' | 'invalidContract';

export class AgentProtocolDecodeErrorV2 extends Error {
  constructor(
    readonly kind: AgentProtocolDecodeErrorKindV2,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'AgentProtocolDecodeErrorV2';
  }
}

function fail(message: string, field?: string): never {
  throw new AgentProtocolDecodeErrorV2('invalidContract', message, field);
}

function parseJson(raw: string, name: string, maxBytes?: number): unknown {
  if (maxBytes !== undefined && new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new AgentProtocolDecodeErrorV2('tooLarge', `${name} exceeds 64 KiB`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AgentProtocolDecodeErrorV2('invalidJson', `${name} is not a single JSON document`);
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

function versionV2(value: unknown, field = 'schemaVersion'): 2 {
  if (value !== 2) fail(`${field} must be 2`, field);
  return 2;
}

function textValue(value: unknown, field: string, maxCharacters: number): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || [...value].length > maxCharacters
    || value.includes('\0')
  ) {
    return fail(`${field} is invalid`, field);
  }
  return value;
}

function stringValue(value: unknown, field: string, maxCharacters: number): string {
  if (typeof value !== 'string' || [...value].length > maxCharacters || value.includes('\0')) {
    return fail(`${field} is invalid`, field);
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

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(`${field} contains an unknown enum value`, field);
  }
  return value as T;
}

function optionalOwn<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function unique<T>(values: readonly T[], field: string): void {
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`, field);
}

const PLAN_STATUSES = ['pending', 'active', 'completed', 'skipped'] as const;
const HOST_INSPECT_FIELDS = [
  'os', 'kernel', 'architecture', 'identity', 'uptime', 'capabilities',
] as const;
const TOOL_NAMES = [
  'host.inspect',
  'shell.execReadOnly',
  'service.inspect',
  'service.validateConfig',
  'service.control',
] as const satisfies readonly AgentToolNameV2[];
const SERVICE_INSPECT_FIELDS = [
  'loadState', 'activeState', 'subState', 'mainPid', 'result',
] as const;
const FINDING_CONFIDENCES = ['verified', 'likely', 'uncertain'] as const;
const CHANGE_STATUSES = [
  'verified',
  'unverified',
  'failedNoEffect',
  'executionSucceededVerificationFailed',
  'partialUnexpectedEffect',
  'unknownEffect',
] as const;

function decodePlanItemV2(value: unknown, field: string): AgentPlanItemV1 {
  const item = objectValue(value, field);
  exactKeys(item, ['id', 'title', 'status'], field);
  return {
    id: identifierValue(item.id, `${field}.id`),
    title: textValue(item.title, `${field}.title`, MAX_LABEL_CHARACTERS),
    status: enumValue<AgentPlanItemStatusV1>(item.status, PLAN_STATUSES, `${field}.status`),
  };
}

function decodePlanItemsV2(value: unknown, field: string): AgentPlanItemV1[] {
  const items = arrayValue(value, field, 8).map((item, index) => (
    decodePlanItemV2(item, `${field}[${index}]`)
  ));
  unique(items.map((item) => item.id), field);
  if (items.filter((item) => item.status === 'active').length > 1) {
    fail(`${field} may contain at most one active item`, field);
  }
  return items;
}

function decodePlanV2(value: unknown): AgentPlanUpdateV1 {
  const plan = objectValue(value, 'plan');
  exactKeys(plan, ['items'], 'plan');
  return { items: decodePlanItemsV2(plan.items, 'plan.items') };
}

function decodeHostInspectArgsV2(value: unknown, field = 'arguments'): HostInspectArgsV1 {
  const args = objectValue(value, field);
  exactKeys(args, ['include'], field);
  const include = arrayValue(args.include, `${field}.include`, 6, 1).map((item, index) => (
    enumValue<HostInspectFieldV1>(item, HOST_INSPECT_FIELDS, `${field}.include[${index}]`)
  ));
  unique(include, `${field}.include`);
  return { include };
}

function decodeShellArgsV2(value: unknown, field = 'arguments'): ShellExecReadOnlyArgsV1 {
  const args = objectValue(value, field);
  exactKeys(args, ['program', 'args', 'timeoutSeconds'], field);
  const program = textValue(args.program, `${field}.program`, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(program)) {
    fail(`${field}.program must be a bare program name`, `${field}.program`);
  }
  const decodedArgs = arrayValue(args.args, `${field}.args`, 32).map((argument, index) => {
    if (
      typeof argument !== 'string'
      || [...argument].length > 512
      || /[\u0000-\u001f\u007f-\u009f]/u.test(argument)
    ) {
      return fail(`${field}.args[${index}] is invalid`, `${field}.args[${index}]`);
    }
    return argument;
  });
  const timeoutSeconds = args.timeoutSeconds === undefined
    ? undefined
    : integerValue(args.timeoutSeconds, `${field}.timeoutSeconds`, 1, 60);
  return { program, args: decodedArgs, ...optionalOwn(timeoutSeconds, 'timeoutSeconds') };
}

function serviceUnitValue(value: unknown, field: string): string {
  const unit = textValue(value, field, 128);
  if (!/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]*\.service$/.test(unit)) {
    fail(`${field} must be a plain systemd .service unit`, field);
  }
  return unit;
}

function decodeServiceInspectArgsV2(value: unknown, field = 'arguments'): ServiceInspectArgsV2 {
  const args = objectValue(value, field);
  exactKeys(args, ['manager', 'unit', 'include'], field);
  if (args.manager !== 'systemd') fail(`${field}.manager must be systemd`, `${field}.manager`);
  const include = arrayValue(args.include, `${field}.include`, 5, 1).map((item, index) => (
    enumValue<ServiceInspectFieldV2>(
      item,
      SERVICE_INSPECT_FIELDS,
      `${field}.include[${index}]`,
    )
  ));
  unique(include, `${field}.include`);
  return { manager: 'systemd', unit: serviceUnitValue(args.unit, `${field}.unit`), include };
}

function decodeServiceValidateConfigArgsV2(
  value: unknown,
  field = 'arguments',
): ServiceValidateConfigArgsV2 {
  const args = objectValue(value, field);
  exactKeys(args, ['validator'], field);
  return {
    validator: enumValue(args.validator, ['nginx', 'apache', 'sshd'] as const, `${field}.validator`),
  };
}

function decodeServiceControlArgsV2(value: unknown, field = 'arguments'): ServiceControlArgsV2 {
  const args = objectValue(value, field);
  exactKeys(args, ['manager', 'unit', 'action', 'timeoutSeconds', 'verificationHints'], field);
  if (args.manager !== 'systemd') fail(`${field}.manager must be systemd`, `${field}.manager`);
  const action = enumValue(
    args.action,
    ['start', 'reload', 'restart', 'stop'] as const,
    `${field}.action`,
  );
  const timeoutSeconds = args.timeoutSeconds === undefined
    ? undefined
    : integerValue(args.timeoutSeconds, `${field}.timeoutSeconds`, 1, 60);
  let verificationHints: ServiceControlArgsV2['verificationHints'];
  if (args.verificationHints !== undefined) {
    const hints = objectValue(args.verificationHints, `${field}.verificationHints`);
    exactKeys(hints, ['expectedListenerPorts'], `${field}.verificationHints`);
    let expectedListenerPorts: number[] | undefined;
    if (hints.expectedListenerPorts !== undefined) {
      expectedListenerPorts = arrayValue(
        hints.expectedListenerPorts,
        `${field}.verificationHints.expectedListenerPorts`,
        8,
        1,
      ).map((port, index) => integerValue(
        port,
        `${field}.verificationHints.expectedListenerPorts[${index}]`,
        1,
        65_535,
      ));
      unique(expectedListenerPorts, `${field}.verificationHints.expectedListenerPorts`);
      if (action === 'stop') fail('stop does not accept expected listener ports', field);
    }
    verificationHints = { ...optionalOwn(expectedListenerPorts, 'expectedListenerPorts') };
  }
  return {
    manager: 'systemd',
    unit: serviceUnitValue(args.unit, `${field}.unit`),
    action,
    ...optionalOwn(timeoutSeconds, 'timeoutSeconds'),
    ...optionalOwn(verificationHints, 'verificationHints'),
  };
}

function decodeResourceV2(value: unknown, field: string): AgentResourceRefV2 {
  const resource = objectValue(value, field);
  exactKeys(resource, ['kind', 'identity', 'targetDigest'], field);
  if (resource.kind !== 'systemdService') fail(`${field}.kind is unknown`, `${field}.kind`);
  const identity = textValue(resource.identity, `${field}.identity`, 136);
  const unit = identity.startsWith('systemd:') ? identity.slice('systemd:'.length) : '';
  serviceUnitValue(unit, `${field}.identity`);
  return {
    kind: 'systemdService',
    identity,
    targetDigest: textValue(resource.targetDigest, `${field}.targetDigest`, 200),
  };
}

export function decodeAgentResourceRefV2(value: unknown): AgentResourceRefV2 {
  return decodeResourceV2(value, 'resource');
}

function decodeEvidenceIds(value: unknown, field: string, min = 0): string[] {
  return arrayValue(value, field, 32, min).map((id, index) => (
    identifierValue(id, `${field}[${index}]`)
  ));
}

function decodeFindingV2(value: unknown, index: number): AgentFinalReportFindingV2 {
  const field = `report.findings[${index}]`;
  const finding = objectValue(value, field);
  exactKeys(finding, ['title', 'detail', 'confidence', 'evidenceIds'], field);
  const confidence = enumValue<AgentFindingConfidenceV1>(
    finding.confidence,
    FINDING_CONFIDENCES,
    `${field}.confidence`,
  );
  const evidenceIds = decodeEvidenceIds(finding.evidenceIds, `${field}.evidenceIds`);
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

function decodeChangeReportV2(value: unknown, field: string): AgentChangeReportV2 {
  const change = objectValue(value, field);
  exactKeys(
    change,
    [
      'changeId', 'toolCallId', 'approvalId', 'resource', 'action', 'status',
      'executionEvidenceIds', 'verificationEvidenceIds',
    ],
    field,
  );
  const status = enumValue(change.status, CHANGE_STATUSES, `${field}.status`);
  const verificationEvidenceIds = decodeEvidenceIds(
    change.verificationEvidenceIds,
    `${field}.verificationEvidenceIds`,
  );
  if (status === 'verified' && verificationEvidenceIds.length === 0) {
    fail(`${field} verified change requires postcondition evidence`, field);
  }
  return {
    changeId: identifierValue(change.changeId, `${field}.changeId`),
    toolCallId: identifierValue(change.toolCallId, `${field}.toolCallId`),
    approvalId: identifierValue(change.approvalId, `${field}.approvalId`),
    resource: decodeResourceV2(change.resource, `${field}.resource`),
    action: textValue(change.action, `${field}.action`, 64),
    status,
    executionEvidenceIds: decodeEvidenceIds(
      change.executionEvidenceIds,
      `${field}.executionEvidenceIds`,
      1,
    ),
    verificationEvidenceIds,
  };
}

function decodeNextActionV2(value: unknown, index: number): AgentNextActionV2 {
  const field = `report.nextActions[${index}]`;
  const action = objectValue(value, field);
  exactKeys(action, ['title', 'requiresChange'], field);
  return {
    title: textValue(action.title, `${field}.title`, MAX_REPORT_ITEM_TEXT_CHARACTERS),
    requiresChange: booleanValue(action.requiresChange, `${field}.requiresChange`),
  };
}

function decodeFinalReportV2(value: unknown): AgentFinalReportV2 {
  const report = objectValue(value, 'report');
  exactKeys(report, ['outcome', 'summary', 'findings', 'changes', 'warnings', 'nextActions'], 'report');
  return {
    outcome: enumValue(
      report.outcome,
      ['resolved', 'diagnosed', 'partial', 'failed', 'blocked', 'inconclusive'] as const,
      'report.outcome',
    ),
    summary: textValue(report.summary, 'report.summary', MAX_REPORT_TEXT_CHARACTERS),
    findings: arrayValue(report.findings, 'report.findings', 16).map(decodeFindingV2),
    changes: arrayValue(report.changes, 'report.changes', 8).map((change, index) => (
      decodeChangeReportV2(change, `report.changes[${index}]`)
    )),
    warnings: arrayValue(report.warnings, 'report.warnings', 16).map((warning, index) => (
      textValue(warning, `report.warnings[${index}]`, MAX_REPORT_ITEM_TEXT_CHARACTERS)
    )),
    nextActions: arrayValue(report.nextActions, 'report.nextActions', 16).map(decodeNextActionV2),
  };
}

export function decodeAgentDecisionV2(raw: string): AgentDecisionV2 {
  const decision = objectValue(
    parseJson(raw, 'Agent v2 decision', MAX_AGENT_DECISION_BYTES_V2),
    'Agent v2 decision',
  );
  versionV2(decision.schemaVersion);
  const kind = enumValue(decision.kind, ['toolCall', 'askUser', 'final'] as const, 'kind');
  const rationale = textValue(decision.rationale, 'rationale', MAX_RATIONALE_CHARACTERS);
  const plan = decodePlanV2(decision.plan);

  if (kind === 'askUser') {
    exactKeys(decision, ['schemaVersion', 'kind', 'rationale', 'plan', 'question'], 'Agent v2 decision');
    return {
      schemaVersion: 2,
      kind,
      rationale,
      plan,
      question: textValue(decision.question, 'question', MAX_QUESTION_CHARACTERS),
    };
  }
  if (kind === 'final') {
    exactKeys(decision, ['schemaVersion', 'kind', 'rationale', 'plan', 'report'], 'Agent v2 decision');
    return { schemaVersion: 2, kind, rationale, plan, report: decodeFinalReportV2(decision.report) };
  }

  const tool = enumValue<AgentToolNameV2>(decision.tool, TOOL_NAMES, 'tool');
  if (tool === 'service.control') {
    exactKeys(
      decision,
      [
        'schemaVersion', 'kind', 'rationale', 'plan', 'tool', 'arguments', 'purpose',
        'expectedImpact', 'rollbackGuidance', 'successCriteria', 'preconditionEvidenceIds',
        'retrySafety',
      ],
      'Agent v2 decision',
    );
    return {
      schemaVersion: 2,
      kind,
      rationale,
      plan,
      tool,
      arguments: decodeServiceControlArgsV2(decision.arguments),
      purpose: textValue(decision.purpose, 'purpose', MAX_TOOL_TEXT_CHARACTERS),
      expectedImpact: textValue(decision.expectedImpact, 'expectedImpact', MAX_TOOL_TEXT_CHARACTERS),
      rollbackGuidance: textValue(
        decision.rollbackGuidance,
        'rollbackGuidance',
        MAX_TOOL_TEXT_CHARACTERS,
      ),
      successCriteria: textValue(
        decision.successCriteria,
        'successCriteria',
        MAX_TOOL_TEXT_CHARACTERS,
      ),
      preconditionEvidenceIds: decodeEvidenceIds(
        decision.preconditionEvidenceIds,
        'preconditionEvidenceIds',
        1,
      ),
      retrySafety: enumValue(
        decision.retrySafety,
        ['never', 'verifyBeforeRetry'] as const,
        'retrySafety',
      ),
    };
  }

  exactKeys(
    decision,
    ['schemaVersion', 'kind', 'rationale', 'plan', 'tool', 'arguments', 'purpose', 'successCriteria'],
    'Agent v2 decision',
  );
  const base = {
    schemaVersion: 2 as const,
    kind,
    rationale,
    plan,
    purpose: textValue(decision.purpose, 'purpose', MAX_TOOL_TEXT_CHARACTERS),
    successCriteria: textValue(decision.successCriteria, 'successCriteria', MAX_TOOL_TEXT_CHARACTERS),
  };
  if (tool === 'host.inspect') {
    return { ...base, tool, arguments: decodeHostInspectArgsV2(decision.arguments) };
  }
  if (tool === 'shell.execReadOnly') {
    return { ...base, tool, arguments: decodeShellArgsV2(decision.arguments) };
  }
  if (tool === 'service.inspect') {
    return { ...base, tool, arguments: decodeServiceInspectArgsV2(decision.arguments) };
  }
  return { ...base, tool, arguments: decodeServiceValidateConfigArgsV2(decision.arguments) };
}

const BUDGET_REQUEST_KEYS = [
  'maxRunSeconds',
  'maxModelTurns',
  'maxToolCalls',
  'toolTimeoutSeconds',
  'maxConsecutiveInvalidDecisions',
  'maxConsecutiveToolFailures',
  'maxPendingPlanItems',
  'maxSteeringQueueItems',
  'maxUserMessageBytes',
  'stdoutCaptureBytes',
  'stderrCaptureBytes',
  'totalReadHardLimitBytes',
  'maxMutationProposals',
  'maxApprovedMutations',
  'maxVerificationAttemptsPerChange',
  'maxVerificationRuntimeSeconds',
] as const;

const BUDGET_LIMITS: Record<(typeof BUDGET_REQUEST_KEYS)[number], number> = {
  maxRunSeconds: 900,
  maxModelTurns: 20,
  maxToolCalls: 15,
  toolTimeoutSeconds: 60,
  maxConsecutiveInvalidDecisions: 2,
  maxConsecutiveToolFailures: 3,
  maxPendingPlanItems: 8,
  maxSteeringQueueItems: 16,
  maxUserMessageBytes: 8192,
  stdoutCaptureBytes: 262_144,
  stderrCaptureBytes: 65_536,
  totalReadHardLimitBytes: 16_777_216,
  maxMutationProposals: 5,
  maxApprovedMutations: 3,
  maxVerificationAttemptsPerChange: 3,
  maxVerificationRuntimeSeconds: 120,
};

function decodeBudgetRequestV2(value: unknown): AgentBudgetRequestV2 {
  const budgets = objectValue(value, 'requestedBudgets');
  exactKeys(budgets, BUDGET_REQUEST_KEYS, 'requestedBudgets');
  const decoded: AgentBudgetRequestV2 = {};
  for (const key of BUDGET_REQUEST_KEYS) {
    if (budgets[key] !== undefined) {
      decoded[key] = integerValue(budgets[key], `requestedBudgets.${key}`, 1, BUDGET_LIMITS[key]);
    }
  }
  return decoded;
}

function decodeTerminalContextV2(value: unknown): AgentTerminalContextV2 {
  const context = objectValue(value, 'terminalContext');
  exactKeys(context, ['sessionId', 'capturedAt', 'label', 'redactedText', 'truncated'], 'terminalContext');
  const redactedText = stringValue(
    context.redactedText,
    'terminalContext.redactedText',
    MAX_TERMINAL_CONTEXT_CHARACTERS,
  );
  return {
    sessionId: identifierValue(context.sessionId, 'terminalContext.sessionId'),
    capturedAt: integerValue(context.capturedAt, 'terminalContext.capturedAt'),
    label: textValue(context.label, 'terminalContext.label', MAX_LABEL_CHARACTERS),
    redactedText,
    truncated: booleanValue(context.truncated, 'terminalContext.truncated'),
  };
}

export function decodeAgentStartRequestV2(raw: string | unknown): AgentStartRequestV2 {
  const value = typeof raw === 'string' ? parseJson(raw, 'Agent v2 start request') : raw;
  const request = objectValue(value, 'Agent v2 start request');
  exactKeys(
    request,
    [
      'schemaVersion', 'clientRequestId', 'goal', 'profileId', 'providerId',
      'requestedPolicyMode', 'terminalContext', 'requestedBudgets',
    ],
    'Agent v2 start request',
  );
  versionV2(request.schemaVersion);
  const terminalContext = request.terminalContext === undefined
    ? undefined
    : decodeTerminalContextV2(request.terminalContext);
  const requestedBudgets = request.requestedBudgets === undefined
    ? undefined
    : decodeBudgetRequestV2(request.requestedBudgets);
  return {
    schemaVersion: 2,
    clientRequestId: identifierValue(request.clientRequestId, 'clientRequestId'),
    goal: textValue(request.goal, 'goal', MAX_GOAL_CHARACTERS),
    profileId: identifierValue(request.profileId, 'profileId'),
    providerId: identifierValue(request.providerId, 'providerId'),
    requestedPolicyMode: enumValue(
      request.requestedPolicyMode,
      ['strict', 'balanced'] as const,
      'requestedPolicyMode',
    ),
    ...optionalOwn(terminalContext, 'terminalContext'),
    ...optionalOwn(requestedBudgets, 'requestedBudgets'),
  };
}

function decodeTargetV2(value: unknown): AgentTargetBindingV2 {
  const target = objectValue(value, 'target');
  exactKeys(
    target,
    ['profileId', 'profileLabel', 'host', 'port', 'username', 'authMethod', 'jumpHost', 'targetDigest'],
    'target',
  );
  let jumpHost: AgentTargetBindingV2['jumpHost'];
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

function decodeProviderV2(value: unknown): AgentProviderBindingV2 {
  const provider = objectValue(value, 'provider');
  exactKeys(provider, ['providerId', 'kind', 'baseUrl', 'model', 'capabilities'], 'provider');
  const capabilities = objectValue(provider.capabilities, 'provider.capabilities');
  exactKeys(
    capabilities,
    ['streaming', 'strictJsonSchema', 'nativeToolCalling', 'usageReporting', 'responseContinuation'],
    'provider.capabilities',
  );
  return {
    providerId: identifierValue(provider.providerId, 'provider.providerId'),
    kind: enumValue(provider.kind, ['ollama', 'openAi', 'openAiCompatible'] as const, 'provider.kind'),
    baseUrl: textValue(provider.baseUrl, 'provider.baseUrl', 2_000),
    model: textValue(provider.model, 'provider.model', 200),
    capabilities: {
      streaming: booleanValue(capabilities.streaming, 'provider.capabilities.streaming'),
      strictJsonSchema: booleanValue(capabilities.strictJsonSchema, 'provider.capabilities.strictJsonSchema'),
      nativeToolCalling: booleanValue(capabilities.nativeToolCalling, 'provider.capabilities.nativeToolCalling'),
      usageReporting: booleanValue(capabilities.usageReporting, 'provider.capabilities.usageReporting'),
      responseContinuation: booleanValue(
        capabilities.responseContinuation,
        'provider.capabilities.responseContinuation',
      ),
    },
  };
}

function decodePolicyV2(value: unknown): AgentPolicySnapshotV2 {
  const policy = objectValue(value, 'policy');
  exactKeys(
    policy,
    ['mode', 'policyVersion', 'toolRegistryVersion', 'allowedTools', 'controlledMutationAllowed'],
    'policy',
  );
  const allowedTools = arrayValue(policy.allowedTools, 'policy.allowedTools', 5).map((tool, index) => (
    enumValue<AgentToolNameV2>(tool, TOOL_NAMES, `policy.allowedTools[${index}]`)
  ));
  unique(allowedTools, 'policy.allowedTools');
  return {
    mode: enumValue(policy.mode, ['strict', 'balanced'] as const, 'policy.mode'),
    policyVersion: identifierValue(policy.policyVersion, 'policy.policyVersion'),
    toolRegistryVersion: identifierValue(policy.toolRegistryVersion, 'policy.toolRegistryVersion'),
    allowedTools,
    controlledMutationAllowed: booleanValue(
      policy.controlledMutationAllowed,
      'policy.controlledMutationAllowed',
    ),
  };
}

function decodeBudgetSnapshotV2(value: unknown): AgentBudgetSnapshotV2 {
  const snapshot = objectValue(value, 'budgets');
  exactKeys(snapshot, ['schemaVersion', 'policy', 'usage'], 'budgets');
  versionV2(snapshot.schemaVersion, 'budgets.schemaVersion');
  const policy = objectValue(snapshot.policy, 'budgets.policy');
  const policyKeys = [...BUDGET_REQUEST_KEYS, 'maxPendingApprovals'] as const;
  exactKeys(policy, policyKeys, 'budgets.policy');
  const decodedPolicy = {} as AgentBudgetSnapshotV2['policy'];
  for (const key of BUDGET_REQUEST_KEYS) {
    decodedPolicy[key] = integerValue(policy[key], `budgets.policy.${key}`, 1, BUDGET_LIMITS[key]);
  }
  decodedPolicy.maxPendingApprovals = integerValue(
    policy.maxPendingApprovals,
    'budgets.policy.maxPendingApprovals',
    1,
    1,
  ) as 1;
  const usage = objectValue(snapshot.usage, 'budgets.usage');
  exactKeys(
    usage,
    [
      'elapsedMillis', 'modelTurnsUsed', 'toolCallsUsed', 'consecutiveInvalidDecisions',
      'consecutiveToolFailures', 'steeringQueueItems', 'mutationProposalsUsed',
      'approvedMutationsUsed', 'pendingApprovals',
    ],
    'budgets.usage',
  );
  const decodedUsage: AgentBudgetSnapshotV2['usage'] = {
    elapsedMillis: integerValue(usage.elapsedMillis, 'budgets.usage.elapsedMillis'),
    modelTurnsUsed: integerValue(usage.modelTurnsUsed, 'budgets.usage.modelTurnsUsed', 0, 20),
    toolCallsUsed: integerValue(usage.toolCallsUsed, 'budgets.usage.toolCallsUsed', 0, 15),
    consecutiveInvalidDecisions: integerValue(
      usage.consecutiveInvalidDecisions,
      'budgets.usage.consecutiveInvalidDecisions',
      0,
      2,
    ),
    consecutiveToolFailures: integerValue(
      usage.consecutiveToolFailures,
      'budgets.usage.consecutiveToolFailures',
      0,
      3,
    ),
    steeringQueueItems: integerValue(usage.steeringQueueItems, 'budgets.usage.steeringQueueItems', 0, 16),
    mutationProposalsUsed: integerValue(usage.mutationProposalsUsed, 'budgets.usage.mutationProposalsUsed', 0, 5),
    approvedMutationsUsed: integerValue(usage.approvedMutationsUsed, 'budgets.usage.approvedMutationsUsed', 0, 3),
    pendingApprovals: integerValue(usage.pendingApprovals, 'budgets.usage.pendingApprovals', 0, 1) as 0 | 1,
  };
  if (
    decodedUsage.mutationProposalsUsed > decodedPolicy.maxMutationProposals
    || decodedUsage.approvedMutationsUsed > decodedPolicy.maxApprovedMutations
  ) {
    fail('budgets.usage exceeds policy');
  }
  return { schemaVersion: 2, policy: decodedPolicy, usage: decodedUsage };
}

const PUBLIC_ERROR_CATEGORIES_V2 = [
  'agentBusy',
  'targetUnavailable',
  'providerIncompatible',
  'providerUnavailable',
  'providerProtocol',
  'toolDenied',
  'toolFailed',
  'staleEvidence',
  'preconditionFailed',
  'approvalRequired',
  'approvalExpired',
  'verificationFailed',
  'budgetExceeded',
  'cancelled',
  'p2Blocked',
  'policyUnavailable',
  'internal',
] as const;

function decodePublicErrorV2(value: unknown): AgentPublicErrorV2 {
  const error = objectValue(value, 'error');
  exactKeys(error, ['schemaVersion', 'category', 'message', 'retryable', 'suggestion'], 'error');
  const suggestion = error.suggestion === undefined
    ? undefined
    : textValue(error.suggestion, 'error.suggestion', 2_000);
  return {
    schemaVersion: versionV2(error.schemaVersion, 'error.schemaVersion'),
    category: enumValue(error.category, PUBLIC_ERROR_CATEGORIES_V2, 'error.category'),
    message: textValue(error.message, 'error.message', 2_000),
    retryable: booleanValue(error.retryable, 'error.retryable'),
    ...optionalOwn(suggestion, 'suggestion'),
  };
}

const TOOL_RESULT_STATUSES_V2 = [
  'completed', 'partial', 'failed', 'timedOut', 'cancelled', 'unknownEffect', 'denied',
] as const;

function decodeToolResultV2(value: unknown): AgentToolExecutionResultV2 {
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
  const error = result.error === undefined ? undefined : decodePublicErrorV2(result.error);
  return {
    schemaVersion: versionV2(result.schemaVersion, 'toolCall.result.schemaVersion'),
    runId: identifierValue(result.runId, 'toolCall.result.runId'),
    toolCallId: identifierValue(result.toolCallId, 'toolCall.result.toolCallId'),
    status: enumValue<AgentToolResultStatusV2>(
      result.status,
      TOOL_RESULT_STATUSES_V2,
      'toolCall.result.status',
    ),
    startedAt: integerValue(result.startedAt, 'toolCall.result.startedAt'),
    completedAt: integerValue(result.completedAt, 'toolCall.result.completedAt'),
    ...optionalOwn(exitCode, 'exitCode'),
    stdoutExcerpt: stringValue(result.stdoutExcerpt, 'toolCall.result.stdoutExcerpt', 262_144),
    stderrExcerpt: stringValue(result.stderrExcerpt, 'toolCall.result.stderrExcerpt', 65_536),
    stdoutBytesCaptured: integerValue(result.stdoutBytesCaptured, 'toolCall.result.stdoutBytesCaptured'),
    stderrBytesCaptured: integerValue(result.stderrBytesCaptured, 'toolCall.result.stderrBytesCaptured'),
    stdoutBytesRead: integerValue(result.stdoutBytesRead, 'toolCall.result.stdoutBytesRead'),
    stderrBytesRead: integerValue(result.stderrBytesRead, 'toolCall.result.stderrBytesRead'),
    stdoutTruncated: booleanValue(result.stdoutTruncated, 'toolCall.result.stdoutTruncated'),
    stderrTruncated: booleanValue(result.stderrTruncated, 'toolCall.result.stderrTruncated'),
    ...optionalOwn(error, 'error'),
  };
}

function decodeToolCallV2(value: unknown, field = 'toolCall'): AgentToolCallSnapshotV2 {
  const toolCall = objectValue(value, field);
  const tool = enumValue<AgentToolNameV2>(toolCall.tool, TOOL_NAMES, `${field}.tool`);
  const commonKeys = [
    'toolCallId', 'state', 'tool', 'arguments', 'rationale', 'purpose', 'successCriteria',
    'proposedAt', 'operationId', 'commandPreview', 'result', 'evidenceIds',
  ];
  const controlKeys = [
    ...commonKeys,
    'expectedImpact',
    'rollbackGuidance',
    'preconditionEvidenceIds',
    'retrySafety',
  ];
  exactKeys(toolCall, tool === 'service.control' ? controlKeys : commonKeys, field);
  if (!isAgentToolCallStateV2(toolCall.state)) fail(`${field}.state is unknown`, `${field}.state`);
  const operationId = toolCall.operationId === undefined
    ? undefined
    : identifierValue(toolCall.operationId, `${field}.operationId`);
  const commandPreview = toolCall.commandPreview === undefined
    ? undefined
    : textValue(toolCall.commandPreview, `${field}.commandPreview`, 8 * 1024);
  const result = toolCall.result === undefined ? undefined : decodeToolResultV2(toolCall.result);
  const base = {
    toolCallId: identifierValue(toolCall.toolCallId, `${field}.toolCallId`),
    state: toolCall.state,
    rationale: textValue(toolCall.rationale, `${field}.rationale`, MAX_RATIONALE_CHARACTERS),
    purpose: textValue(toolCall.purpose, `${field}.purpose`, MAX_TOOL_TEXT_CHARACTERS),
    successCriteria: textValue(
      toolCall.successCriteria,
      `${field}.successCriteria`,
      MAX_TOOL_TEXT_CHARACTERS,
    ),
    proposedAt: integerValue(toolCall.proposedAt, `${field}.proposedAt`),
    ...optionalOwn(operationId, 'operationId'),
    ...optionalOwn(commandPreview, 'commandPreview'),
    ...optionalOwn(result, 'result'),
    evidenceIds: decodeEvidenceIds(toolCall.evidenceIds, `${field}.evidenceIds`),
  };
  if (tool === 'host.inspect') {
    return { ...base, tool, arguments: decodeHostInspectArgsV2(toolCall.arguments, `${field}.arguments`) };
  }
  if (tool === 'shell.execReadOnly') {
    return { ...base, tool, arguments: decodeShellArgsV2(toolCall.arguments, `${field}.arguments`) };
  }
  if (tool === 'service.inspect') {
    return { ...base, tool, arguments: decodeServiceInspectArgsV2(toolCall.arguments, `${field}.arguments`) };
  }
  if (tool === 'service.validateConfig') {
    return {
      ...base,
      tool,
      arguments: decodeServiceValidateConfigArgsV2(toolCall.arguments, `${field}.arguments`),
    };
  }
  return {
    ...base,
    tool,
    arguments: decodeServiceControlArgsV2(toolCall.arguments, `${field}.arguments`),
    expectedImpact: textValue(toolCall.expectedImpact, `${field}.expectedImpact`, MAX_TOOL_TEXT_CHARACTERS),
    rollbackGuidance: textValue(
      toolCall.rollbackGuidance,
      `${field}.rollbackGuidance`,
      MAX_TOOL_TEXT_CHARACTERS,
    ),
    preconditionEvidenceIds: decodeEvidenceIds(
      toolCall.preconditionEvidenceIds,
      `${field}.preconditionEvidenceIds`,
      1,
    ),
    retrySafety: enumValue(
      toolCall.retrySafety,
      ['never', 'verifyBeforeRetry'] as const,
      `${field}.retrySafety`,
    ),
  };
}

const EVIDENCE_SOURCES_V2 = [
  'terminalSnapshot',
  'host.inspect',
  'shell.execReadOnly',
  'service.inspect',
  'service.validateConfig',
  'service.control',
  'service.verify',
] as const;

function decodeEvidenceV2(value: unknown, field: string): AgentEvidenceV2 {
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
  const stdoutExcerpt = evidence.stdoutExcerpt === undefined
    ? undefined
    : stringValue(evidence.stdoutExcerpt, `${field}.stdoutExcerpt`, 262_144);
  const stderrExcerpt = evidence.stderrExcerpt === undefined
    ? undefined
    : stringValue(evidence.stderrExcerpt, `${field}.stderrExcerpt`, 65_536);
  const exitCode = evidence.exitCode === undefined
    ? undefined
    : integerValue(evidence.exitCode, `${field}.exitCode`, -2_147_483_648, 2_147_483_647);
  return {
    evidenceId: identifierValue(evidence.evidenceId, `${field}.evidenceId`),
    runId: identifierValue(evidence.runId, `${field}.runId`),
    targetDigest: textValue(evidence.targetDigest, `${field}.targetDigest`, 200),
    source: enumValue<AgentEvidenceSourceV2>(evidence.source, EVIDENCE_SOURCES_V2, `${field}.source`),
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

function decodeRiskV2(value: unknown, field: string): AgentRiskAssessmentV2 {
  const risk = objectValue(value, field);
  exactKeys(
    risk,
    [
      'riskAssessmentId', 'severity', 'confidence', 'dimensions', 'findings',
      'affectedResources', 'verdict', 'policyVersion', 'assessmentDigest',
    ],
    field,
  );
  const dimensions = objectValue(risk.dimensions, `${field}.dimensions`);
  const dimensionKeys = [
    'read', 'write', 'delete', 'privilegeElevation', 'serviceInterruption', 'networkChange',
    'credentialAccess', 'externalNetwork', 'multiHost',
  ] as const;
  exactKeys(dimensions, dimensionKeys, `${field}.dimensions`);
  const findings = arrayValue(risk.findings, `${field}.findings`, 32).map((value, index) => {
    const finding = objectValue(value, `${field}.findings[${index}]`);
    exactKeys(finding, ['code', 'message'], `${field}.findings[${index}]`);
    return {
      code: identifierValue(finding.code, `${field}.findings[${index}].code`),
      message: textValue(finding.message, `${field}.findings[${index}].message`, 2_000),
    };
  });
  return {
    riskAssessmentId: identifierValue(risk.riskAssessmentId, `${field}.riskAssessmentId`),
    severity: enumValue(risk.severity, ['low', 'medium', 'high', 'critical'] as const, `${field}.severity`),
    confidence: enumValue(risk.confidence, ['known', 'heuristic', 'unknown'] as const, `${field}.confidence`),
    dimensions: {
      read: booleanValue(dimensions.read, `${field}.dimensions.read`),
      write: booleanValue(dimensions.write, `${field}.dimensions.write`),
      delete: booleanValue(dimensions.delete, `${field}.dimensions.delete`),
      privilegeElevation: booleanValue(
        dimensions.privilegeElevation,
        `${field}.dimensions.privilegeElevation`,
      ),
      serviceInterruption: booleanValue(
        dimensions.serviceInterruption,
        `${field}.dimensions.serviceInterruption`,
      ),
      networkChange: booleanValue(dimensions.networkChange, `${field}.dimensions.networkChange`),
      credentialAccess: booleanValue(
        dimensions.credentialAccess,
        `${field}.dimensions.credentialAccess`,
      ),
      externalNetwork: booleanValue(
        dimensions.externalNetwork,
        `${field}.dimensions.externalNetwork`,
      ),
      multiHost: booleanValue(dimensions.multiHost, `${field}.dimensions.multiHost`),
    },
    findings,
    affectedResources: arrayValue(risk.affectedResources, `${field}.affectedResources`, 8).map(
      (resource, index) => decodeResourceV2(resource, `${field}.affectedResources[${index}]`),
    ),
    verdict: enumValue(
      risk.verdict,
      ['autoReadOnly', 'requiresApproval', 'requiresDoubleConfirmation', 'deny'] as const,
      `${field}.verdict`,
    ),
    policyVersion: identifierValue(risk.policyVersion, `${field}.policyVersion`),
    assessmentDigest: textValue(risk.assessmentDigest, `${field}.assessmentDigest`, 200),
  };
}

export function decodeAgentRiskAssessmentV2(value: unknown): AgentRiskAssessmentV2 {
  return decodeRiskV2(value, 'riskAssessment');
}

function decodeApprovalV2(value: unknown, field = 'pendingApproval'): AgentApprovalSnapshotV2 {
  const approval = objectValue(value, field);
  exactKeys(
    approval,
    [
      'approvalId', 'runId', 'toolCallId', 'toolName', 'resource', 'riskAssessmentId',
      'commandPreview', 'preconditionEvidenceIds', 'verificationPlanDigest', 'timeoutSeconds',
      'issuedAt', 'expiresAt', 'confirmationMode', 'state',
    ],
    field,
  );
  if (!isAgentApprovalStateV2(approval.state)) fail(`${field}.state is unknown`, `${field}.state`);
  if (['rejected', 'expired', 'revoked', 'consumed'].includes(approval.state)) {
    fail(`${field} cannot contain a terminal approval`, `${field}.state`);
  }
  const toolName = enumValue<AgentToolNameV2>(approval.toolName, TOOL_NAMES, `${field}.toolName`);
  const resource = approval.resource === undefined
    ? undefined
    : decodeResourceV2(approval.resource, `${field}.resource`);
  const verificationPlanDigest = approval.verificationPlanDigest === undefined
    ? undefined
    : textValue(approval.verificationPlanDigest, `${field}.verificationPlanDigest`, 200);
  const preconditionEvidenceIds = decodeEvidenceIds(
    approval.preconditionEvidenceIds,
    `${field}.preconditionEvidenceIds`,
  );
  if (
    toolName === 'service.control'
    && (!resource || !verificationPlanDigest || preconditionEvidenceIds.length === 0)
  ) {
    fail(`${field} mutation binding is incomplete`, field);
  }
  const issuedAt = integerValue(approval.issuedAt, `${field}.issuedAt`);
  const expiresAt = integerValue(approval.expiresAt, `${field}.expiresAt`);
  if (expiresAt <= issuedAt) fail(`${field}.expiresAt must follow issuedAt`, `${field}.expiresAt`);
  return {
    approvalId: identifierValue(approval.approvalId, `${field}.approvalId`),
    runId: identifierValue(approval.runId, `${field}.runId`),
    toolCallId: identifierValue(approval.toolCallId, `${field}.toolCallId`),
    toolName,
    ...optionalOwn(resource, 'resource'),
    riskAssessmentId: identifierValue(approval.riskAssessmentId, `${field}.riskAssessmentId`),
    commandPreview: textValue(approval.commandPreview, `${field}.commandPreview`, 8 * 1024),
    preconditionEvidenceIds,
    ...optionalOwn(verificationPlanDigest, 'verificationPlanDigest'),
    timeoutSeconds: integerValue(approval.timeoutSeconds, `${field}.timeoutSeconds`, 1, 60),
    issuedAt,
    expiresAt,
    confirmationMode: enumValue(
      approval.confirmationMode,
      ['single', 'double'] as const,
      `${field}.confirmationMode`,
    ),
    state: approval.state,
  };
}

function decodeChangeSnapshotV2(value: unknown, field: string): AgentChangeSnapshotV2 {
  const change = objectValue(value, field);
  exactKeys(
    change,
    [
      'changeId', 'toolCallId', 'approvalId', 'resource', 'action', 'status',
      'executionEvidenceIds', 'verificationEvidenceIds', 'operationId', 'recordedAt',
    ],
    field,
  );
  const report = decodeChangeReportV2({
    changeId: change.changeId,
    toolCallId: change.toolCallId,
    approvalId: change.approvalId,
    resource: change.resource,
    action: change.action,
    status: change.status,
    executionEvidenceIds: change.executionEvidenceIds,
    verificationEvidenceIds: change.verificationEvidenceIds,
  }, field);
  const operationId = change.operationId === undefined
    ? undefined
    : identifierValue(change.operationId, `${field}.operationId`);
  return {
    ...report,
    ...optionalOwn(operationId, 'operationId'),
    recordedAt: integerValue(change.recordedAt, `${field}.recordedAt`),
  };
}

function decodeVerificationV2(value: unknown, field: string): AgentVerificationSnapshotV2 {
  const verification = objectValue(value, field);
  exactKeys(
    verification,
    [
      'verificationObligationId', 'changeId', 'toolCallId', 'state', 'verificationPlanDigest',
      'evidenceIds', 'startedAt', 'completedAt',
    ],
    field,
  );
  if (!isAgentVerificationStateV2(verification.state)) fail(`${field}.state is unknown`, `${field}.state`);
  const startedAt = verification.startedAt === undefined
    ? undefined
    : integerValue(verification.startedAt, `${field}.startedAt`);
  const completedAt = verification.completedAt === undefined
    ? undefined
    : integerValue(verification.completedAt, `${field}.completedAt`);
  if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
    fail(`${field}.completedAt precedes startedAt`, `${field}.completedAt`);
  }
  return {
    verificationObligationId: identifierValue(
      verification.verificationObligationId,
      `${field}.verificationObligationId`,
    ),
    changeId: identifierValue(verification.changeId, `${field}.changeId`),
    toolCallId: identifierValue(verification.toolCallId, `${field}.toolCallId`),
    state: verification.state,
    verificationPlanDigest: textValue(
      verification.verificationPlanDigest,
      `${field}.verificationPlanDigest`,
      200,
    ),
    evidenceIds: decodeEvidenceIds(verification.evidenceIds, `${field}.evidenceIds`),
    ...optionalOwn(startedAt, 'startedAt'),
    ...optionalOwn(completedAt, 'completedAt'),
  };
}

export function decodeAgentRunSnapshotV2(value: unknown): AgentRunSnapshotV2 {
  const snapshot = objectValue(value, 'Agent v2 snapshot');
  exactKeys(
    snapshot,
    [
      'schemaVersion', 'runId', 'lastSequence', 'state', 'target', 'provider', 'policy', 'budgets',
      'goal', 'plan', 'toolCalls', 'evidence', 'pendingQuestion', 'queuedSteeringCount', 'report',
      'error', 'pendingApproval', 'riskAssessments', 'changes', 'verificationObligations',
    ],
    'Agent v2 snapshot',
  );
  if (!isAgentRunStateV2(snapshot.state)) fail('Agent v2 snapshot.state is unknown');
  let pendingQuestion: AgentRunSnapshotV2['pendingQuestion'];
  if (snapshot.pendingQuestion !== undefined) {
    const question = objectValue(snapshot.pendingQuestion, 'pendingQuestion');
    exactKeys(question, ['questionId', 'question', 'askedAt'], 'pendingQuestion');
    pendingQuestion = {
      questionId: identifierValue(question.questionId, 'pendingQuestion.questionId'),
      question: textValue(question.question, 'pendingQuestion.question', MAX_QUESTION_CHARACTERS),
      askedAt: integerValue(question.askedAt, 'pendingQuestion.askedAt'),
    };
  }
  const report = snapshot.report === undefined ? undefined : decodeFinalReportV2(snapshot.report);
  const error = snapshot.error === undefined ? undefined : decodePublicErrorV2(snapshot.error);
  const pendingApproval = snapshot.pendingApproval === undefined
    ? undefined
    : decodeApprovalV2(snapshot.pendingApproval);
  return {
    schemaVersion: versionV2(snapshot.schemaVersion, 'Agent v2 snapshot.schemaVersion'),
    runId: identifierValue(snapshot.runId, 'Agent v2 snapshot.runId'),
    lastSequence: integerValue(snapshot.lastSequence, 'Agent v2 snapshot.lastSequence'),
    state: snapshot.state,
    target: decodeTargetV2(snapshot.target),
    provider: decodeProviderV2(snapshot.provider),
    policy: decodePolicyV2(snapshot.policy),
    budgets: decodeBudgetSnapshotV2(snapshot.budgets),
    goal: textValue(snapshot.goal, 'Agent v2 snapshot.goal', MAX_GOAL_CHARACTERS),
    plan: decodePlanItemsV2(snapshot.plan, 'Agent v2 snapshot.plan'),
    toolCalls: arrayValue(snapshot.toolCalls, 'Agent v2 snapshot.toolCalls', 15).map((tool, index) => (
      decodeToolCallV2(tool, `Agent v2 snapshot.toolCalls[${index}]`)
    )),
    evidence: arrayValue(snapshot.evidence, 'Agent v2 snapshot.evidence', 64).map((item, index) => (
      decodeEvidenceV2(item, `Agent v2 snapshot.evidence[${index}]`)
    )),
    ...optionalOwn(pendingQuestion, 'pendingQuestion'),
    queuedSteeringCount: integerValue(
      snapshot.queuedSteeringCount,
      'Agent v2 snapshot.queuedSteeringCount',
      0,
      16,
    ),
    ...optionalOwn(report, 'report'),
    ...optionalOwn(error, 'error'),
    ...optionalOwn(pendingApproval, 'pendingApproval'),
    riskAssessments: arrayValue(
      snapshot.riskAssessments,
      'Agent v2 snapshot.riskAssessments',
      15,
    ).map((risk, index) => decodeRiskV2(risk, `riskAssessments[${index}]`)),
    changes: arrayValue(snapshot.changes, 'Agent v2 snapshot.changes', 8).map((change, index) => (
      decodeChangeSnapshotV2(change, `changes[${index}]`)
    )),
    verificationObligations: arrayValue(
      snapshot.verificationObligations,
      'Agent v2 snapshot.verificationObligations',
      8,
    ).map((verification, index) => (
      decodeVerificationV2(verification, `verificationObligations[${index}]`)
    )),
  };
}

const EVENT_TYPES_V2 = [
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
  'risk.evaluated',
  'approval.requested',
  'approval.confirmationRequired',
  'approval.resolved',
  'approval.expired',
  'approval.revoked',
  'change.executionStarted',
  'change.executionCompleted',
  'verification.started',
  'verification.completed',
  'change.recorded',
] as const satisfies readonly AgentEventTypeV2[];

export function decodeAgentEventV2(value: unknown): AgentEventV2 {
  const event = objectValue(value, 'Agent v2 event');
  exactKeys(event, ['schemaVersion', 'runId', 'sequence', 'occurredAt', 'type', 'payload'], 'Agent v2 event');
  const envelope = {
    schemaVersion: versionV2(event.schemaVersion, 'Agent v2 event.schemaVersion'),
    runId: identifierValue(event.runId, 'Agent v2 event.runId'),
    sequence: integerValue(event.sequence, 'Agent v2 event.sequence', 1),
    occurredAt: integerValue(event.occurredAt, 'Agent v2 event.occurredAt'),
  };
  const type = enumValue<AgentEventTypeV2>(event.type, EVENT_TYPES_V2, 'Agent v2 event.type');
  const payload = objectValue(event.payload, 'Agent v2 event.payload');

  if (type === 'run.created') {
    exactKeys(payload, ['state'], 'Agent v2 event.payload');
    if (payload.state !== 'created') fail('run.created must carry created state');
    return { ...envelope, type, payload: { state: 'created' } };
  }
  if (type === 'run.stateChanged') {
    exactKeys(payload, ['previousState', 'state', 'reason'], 'Agent v2 event.payload');
    if (!isAgentRunStateV2(payload.previousState) || !isAgentRunStateV2(payload.state)) {
      fail('run.stateChanged contains an unknown state');
    }
    if (!canTransitionAgentRunStateV2(payload.previousState, payload.state)) {
      fail('run.stateChanged contains an illegal transition');
    }
    const reason = payload.reason === undefined
      ? undefined
      : textValue(payload.reason, 'Agent v2 event.payload.reason', 2_000);
    return {
      ...envelope,
      type,
      payload: {
        previousState: payload.previousState as AgentRunNonTerminalStateV2,
        state: payload.state,
        ...optionalOwn(reason, 'reason'),
      },
    };
  }
  if (type === 'plan.updated') {
    exactKeys(payload, ['plan'], 'Agent v2 event.payload');
    return { ...envelope, type, payload: { plan: decodePlanItemsV2(payload.plan, 'payload.plan') } };
  }
  if (type === 'model.started' || type === 'model.completed') {
    exactKeys(payload, ['modelTurn'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: { modelTurn: integerValue(payload.modelTurn, 'payload.modelTurn', 1, 20) },
    };
  }
  if (type === 'tool.proposed') {
    exactKeys(payload, ['toolCall'], 'Agent v2 event.payload');
    const toolCall = decodeToolCallV2(payload.toolCall, 'payload.toolCall');
    if (toolCall.state !== 'proposed') fail('tool.proposed must carry proposed state');
    return { ...envelope, type, payload: { toolCall: { ...toolCall, state: 'proposed' } } };
  }
  if (type === 'tool.stateChanged') {
    exactKeys(payload, ['toolCallId', 'previousState', 'state'], 'Agent v2 event.payload');
    if (!isAgentToolCallStateV2(payload.previousState) || !isAgentToolCallStateV2(payload.state)) {
      fail('tool.stateChanged contains an unknown state');
    }
    if (!canTransitionAgentToolCallStateV2(payload.previousState, payload.state)) {
      fail('tool.stateChanged contains an illegal transition');
    }
    return {
      ...envelope,
      type,
      payload: {
        toolCallId: identifierValue(payload.toolCallId, 'payload.toolCallId'),
        previousState: payload.previousState as AgentToolCallNonTerminalStateV2,
        state: payload.state,
      },
    };
  }
  if (type === 'evidence.created') {
    exactKeys(payload, ['evidence'], 'Agent v2 event.payload');
    return { ...envelope, type, payload: { evidence: decodeEvidenceV2(payload.evidence, 'payload.evidence') } };
  }
  if (type === 'budget.updated') {
    exactKeys(payload, ['budgets'], 'Agent v2 event.payload');
    return { ...envelope, type, payload: { budgets: decodeBudgetSnapshotV2(payload.budgets) } };
  }
  if (type === 'user.messageAccepted') {
    exactKeys(payload, ['clientActionId', 'messageKind'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        clientActionId: identifierValue(payload.clientActionId, 'payload.clientActionId'),
        messageKind: enumValue(payload.messageKind, ['answer', 'steering'] as const, 'payload.messageKind'),
      },
    };
  }
  if (type === 'run.reportCreated') {
    exactKeys(payload, ['report'], 'Agent v2 event.payload');
    return { ...envelope, type, payload: { report: decodeFinalReportV2(payload.report) } };
  }
  if (type === 'run.warning') {
    exactKeys(payload, ['code', 'message'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        code: identifierValue(payload.code, 'payload.code'),
        message: textValue(payload.message, 'payload.message', 2_000),
      },
    };
  }
  if (type === 'run.terminal') {
    exactKeys(payload, ['state', 'error'], 'Agent v2 event.payload');
    const state = enumValue(
      payload.state,
      ['completed', 'failed', 'cancelled', 'blocked'] as const,
      'payload.state',
    );
    const error = payload.error === undefined ? undefined : decodePublicErrorV2(payload.error);
    return { ...envelope, type, payload: { state, ...optionalOwn(error, 'error') } };
  }
  if (type === 'risk.evaluated') {
    exactKeys(payload, ['toolCallId', 'riskAssessment'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        toolCallId: identifierValue(payload.toolCallId, 'payload.toolCallId'),
        riskAssessment: decodeRiskV2(payload.riskAssessment, 'payload.riskAssessment'),
      },
    };
  }
  if (type === 'approval.requested') {
    exactKeys(payload, ['approval'], 'Agent v2 event.payload');
    const approval = decodeApprovalV2(payload.approval, 'payload.approval');
    if (approval.state !== 'pending') fail('approval.requested must carry pending state');
    return { ...envelope, type, payload: { approval: { ...approval, state: 'pending' } } };
  }
  if (type === 'approval.confirmationRequired') {
    exactKeys(payload, ['approvalId', 'challengeId', 'expiresAt'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        approvalId: identifierValue(payload.approvalId, 'payload.approvalId'),
        challengeId: identifierValue(payload.challengeId, 'payload.challengeId'),
        expiresAt: integerValue(payload.expiresAt, 'payload.expiresAt'),
      },
    };
  }
  if (type === 'approval.resolved') {
    exactKeys(payload, ['approvalId', 'state'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        approvalId: identifierValue(payload.approvalId, 'payload.approvalId'),
        state: enumValue(payload.state, ['approved', 'rejected'] as const, 'payload.state'),
      },
    };
  }
  if (type === 'approval.expired') {
    exactKeys(payload, ['approvalId'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: { approvalId: identifierValue(payload.approvalId, 'payload.approvalId') },
    };
  }
  if (type === 'approval.revoked') {
    exactKeys(payload, ['approvalId', 'reason'], 'Agent v2 event.payload');
    return {
      ...envelope,
      type,
      payload: {
        approvalId: identifierValue(payload.approvalId, 'payload.approvalId'),
        reason: textValue(payload.reason, 'payload.reason', 2_000),
      },
    };
  }
  if (
    type === 'change.executionStarted'
    || type === 'change.executionCompleted'
    || type === 'change.recorded'
  ) {
    exactKeys(payload, ['change'], 'Agent v2 event.payload');
    return { ...envelope, type, payload: { change: decodeChangeSnapshotV2(payload.change, 'payload.change') } };
  }
  exactKeys(payload, ['verification'], 'Agent v2 event.payload');
  const verification = decodeVerificationV2(payload.verification, 'payload.verification');
  if (type === 'verification.started' && verification.state !== 'running') {
    fail('verification.started must carry running state');
  }
  if (
    type === 'verification.completed'
    && !['satisfied', 'failed', 'inconclusive', 'timedOut', 'cancelled'].includes(verification.state)
  ) {
    fail('verification.completed must carry terminal state');
  }
  return { ...envelope, type, payload: { verification } } as AgentEventV2;
}
