import { invoke } from '@tauri-apps/api/core';
import type {
  TerminalDriverIdV1,
  TerminalFixtureScenarioV1,
  TerminalProgramIdV1,
} from './agent-terminal-protocol';

export type TerminalInteractionStateV1 =
  | 'proposed' | 'validating' | 'evaluatingRisk' | 'awaitingApproval'
  | 'approved' | 'rejected' | 'expired' | 'revoked' | 'writing'
  | 'awaitingObservation' | 'handoffRequired' | 'completed' | 'failed'
  | 'cancelled' | 'unknownEffect';

export type TerminalRunControlStateV1 =
  | 'agent' | 'user' | 'paused' | 'stopped' | 'disconnected' | 'handoffRequired';
export type TerminalApprovalStateV1 =
  | 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'consumed';
export type TerminalPromptSurfaceV1 =
  | 'linePrompt' | 'fullScreen' | 'editor' | 'installer' | 'unknown';
export type TerminalPromptClassV1 =
  | 'confirm' | 'choice' | 'password' | 'passphrase' | 'mfa' | 'otp'
  | 'token' | 'credential' | 'unknownSensitive' | 'unknown';

export interface TerminalRiskSnapshotV1 {
  severity: 'low' | 'medium' | 'critical';
  verdict: 'allowRegisteredStart' | 'requiresApproval' | 'denyAndHandoff';
  stateChange: boolean;
  policyVersion: string;
  riskDigest: string;
}

export interface TerminalApprovalSnapshotV1 {
  approvalId: string;
  actionId: string;
  runId: string;
  targetDigest: string;
  sessionId: string;
  actionDigest: string;
  driver: TerminalDriverIdV1;
  program: TerminalProgramIdV1;
  scenario: TerminalFixtureScenarioV1;
  observationId: string;
  observationDigest: string;
  risk: TerminalRiskSnapshotV1;
  leaseEpoch: number;
  leaseRevision: number;
  issuedAtMs: number;
  expiresAtMs: number;
  state: TerminalApprovalStateV1;
}

export interface TerminalModelObservationV1 {
  observationId: string;
  captureEpoch: number;
  observedAtMs: number;
  redactedTranscript: string;
  transcriptDigest: string;
  truncated: boolean;
  surface: TerminalPromptSurfaceV1;
  promptClass: TerminalPromptClassV1;
  untrusted: true;
}

export interface TerminalVerificationSnapshotV1 {
  obligationId: string;
  actionId: string;
  state: 'pending' | 'running' | 'satisfied' | 'failed' | 'inconclusive' | 'cancelled';
  evidenceId: string | null;
  evidenceDigest: string | null;
  independent: boolean;
}

export interface TerminalActionSnapshotV1 {
  actionId: string;
  actionKind: string;
  actionDigest: string;
  state: TerminalInteractionStateV1;
  risk: TerminalRiskSnapshotV1 | null;
  approvalId: string | null;
  observationId: string | null;
  verification: TerminalVerificationSnapshotV1 | null;
  verified: boolean;
  proposedAtMs: number;
  updatedAtMs: number;
}

export interface TerminalJournalEventV1 {
  schemaVersion: 1;
  runId: string;
  actionId: string;
  sequence: number;
  occurredAtMs: number;
  state: TerminalInteractionStateV1;
  eventDigest: string;
  redactedPreview: string;
}

export interface AgentTerminalSnapshotV1 {
  schemaVersion: 1;
  runId: string;
  targetDigest: string;
  sessionId: string;
  lastSequence: number;
  controlState: TerminalRunControlStateV1;
  captureEpoch: number;
  leaseOwner: 'agent' | 'user' | 'unowned';
  leaseState: 'active' | 'revoked';
  leaseEpoch: number;
  leaseRevision: number;
  currentObservation: TerminalModelObservationV1 | null;
  actions: TerminalActionSnapshotV1[];
  pendingApproval: TerminalApprovalSnapshotV1 | null;
  events: TerminalJournalEventV1[];
}

export interface TerminalRunControlRequestV1 {
  schemaVersion: 1;
  runId: string;
  clientActionId: string;
}

export interface TerminalResolveApprovalRequestV1 extends TerminalRunControlRequestV1 {
  approvalId: string;
  decision: 'approve' | 'reject';
}

export interface TerminalTakeoverAndWriteRequestV1 extends TerminalRunControlRequestV1 {
  data: string;
}

export type TerminalCoordinatorErrorCodeV1 =
  | 'admissionBlocked' | 'invalidContract' | 'runNotFound' | 'actionNotFound'
  | 'approvalNotFound' | 'approvalReplay' | 'approvalExpired' | 'bindingMismatch'
  | 'observationMissing' | 'verificationMissing' | 'invalidState' | 'replay'
  | 'auditPrewriteFailed' | 'leaseRejected' | 'rendererRejected'
  | 'sequenceExhausted' | 'lockUnavailable' | 'unknown';

export interface TerminalCoordinatorErrorV1 {
  code: TerminalCoordinatorErrorCodeV1;
  message: string;
}

export const AGENT_TERMINAL_PRODUCTION_ADMITTED_V1 = false;

const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_TEXT_CHARACTERS = 4 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 64 * 1024;
const MAX_ACTIONS = 512;
const MAX_EVENTS = 512;

const INTERACTION_STATES: readonly TerminalInteractionStateV1[] = [
  'proposed', 'validating', 'evaluatingRisk', 'awaitingApproval', 'approved',
  'rejected', 'expired', 'revoked', 'writing', 'awaitingObservation',
  'handoffRequired', 'completed', 'failed', 'cancelled', 'unknownEffect',
];
const CONTROL_STATES: readonly TerminalRunControlStateV1[] = [
  'agent', 'user', 'paused', 'stopped', 'disconnected', 'handoffRequired',
];
const APPROVAL_STATES: readonly TerminalApprovalStateV1[] = [
  'pending', 'approved', 'rejected', 'expired', 'revoked', 'consumed',
];
const PROMPT_SURFACES: readonly TerminalPromptSurfaceV1[] = [
  'linePrompt', 'fullScreen', 'editor', 'installer', 'unknown',
];
const PROMPT_CLASSES: readonly TerminalPromptClassV1[] = [
  'confirm', 'choice', 'password', 'passphrase', 'mfa', 'otp', 'token',
  'credential', 'unknownSensitive', 'unknown',
];
const VERIFICATION_STATES: readonly TerminalVerificationSnapshotV1['state'][] = [
  'pending', 'running', 'satisfied', 'failed', 'inconclusive', 'cancelled',
];

export class AgentTerminalSnapshotDecodeError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = 'AgentTerminalSnapshotDecodeError';
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new AgentTerminalSnapshotDecodeError(message, field);
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(field, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) fail(field, `${field} contains unknown field ${unknown}`);
  const missing = keys.find((key) => !(key in value));
  if (missing) fail(`${field}.${missing}`, `${field} is missing ${missing}`);
}

function textValue(
  value: unknown,
  field: string,
  maxCharacters = MAX_TEXT_CHARACTERS,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || [...value].length > maxCharacters
    || value.includes('\0')
  ) {
    return fail(field, `${field} is not a bounded string`);
  }
  return value;
}

function identifierValue(value: unknown, field: string): string {
  return textValue(value, field, MAX_IDENTIFIER_CHARACTERS);
}

function integerValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(field, `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return fail(field, `${field} must be boolean`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return fail(field, `${field} contains an unknown enum value`);
  }
  return value as T;
}

function arrayValue(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    return fail(field, `${field} must contain at most ${max} items`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : identifierValue(value, field);
}

function decodeRisk(value: unknown, field: string): TerminalRiskSnapshotV1 {
  const risk = objectValue(value, field);
  exactKeys(risk, [
    'severity', 'verdict', 'stateChange', 'policyVersion', 'riskDigest',
  ], field);
  return {
    severity: enumValue(risk.severity, ['low', 'medium', 'critical'] as const, `${field}.severity`),
    verdict: enumValue(
      risk.verdict,
      ['allowRegisteredStart', 'requiresApproval', 'denyAndHandoff'] as const,
      `${field}.verdict`,
    ),
    stateChange: booleanValue(risk.stateChange, `${field}.stateChange`),
    policyVersion: identifierValue(risk.policyVersion, `${field}.policyVersion`),
    riskDigest: identifierValue(risk.riskDigest, `${field}.riskDigest`),
  };
}

function decodeApproval(value: unknown, field: string): TerminalApprovalSnapshotV1 {
  const approval = objectValue(value, field);
  exactKeys(approval, [
    'approvalId', 'actionId', 'runId', 'targetDigest', 'sessionId', 'actionDigest',
    'driver', 'program', 'scenario', 'observationId', 'observationDigest', 'risk',
    'leaseEpoch', 'leaseRevision', 'issuedAtMs', 'expiresAtMs', 'state',
  ], field);
  const issuedAtMs = integerValue(approval.issuedAtMs, `${field}.issuedAtMs`);
  const expiresAtMs = integerValue(approval.expiresAtMs, `${field}.expiresAtMs`);
  if (expiresAtMs <= issuedAtMs) fail(`${field}.expiresAtMs`, 'approval expiry must follow issue time');
  return {
    approvalId: identifierValue(approval.approvalId, `${field}.approvalId`),
    actionId: identifierValue(approval.actionId, `${field}.actionId`),
    runId: identifierValue(approval.runId, `${field}.runId`),
    targetDigest: identifierValue(approval.targetDigest, `${field}.targetDigest`),
    sessionId: identifierValue(approval.sessionId, `${field}.sessionId`),
    actionDigest: identifierValue(approval.actionDigest, `${field}.actionDigest`),
    driver: enumValue(approval.driver, ['fixture.shellPrompt'] as const, `${field}.driver`),
    program: enumValue(
      approval.program,
      ['termbridge-interactive-fixture'] as const,
      `${field}.program`,
    ),
    scenario: enumValue(approval.scenario, ['confirm', 'choice'] as const, `${field}.scenario`),
    observationId: identifierValue(approval.observationId, `${field}.observationId`),
    observationDigest: identifierValue(approval.observationDigest, `${field}.observationDigest`),
    risk: decodeRisk(approval.risk, `${field}.risk`),
    leaseEpoch: integerValue(approval.leaseEpoch, `${field}.leaseEpoch`),
    leaseRevision: integerValue(approval.leaseRevision, `${field}.leaseRevision`),
    issuedAtMs,
    expiresAtMs,
    state: enumValue(approval.state, APPROVAL_STATES, `${field}.state`),
  };
}

function decodeObservation(value: unknown, field: string): TerminalModelObservationV1 {
  const observation = objectValue(value, field);
  exactKeys(observation, [
    'observationId', 'captureEpoch', 'observedAtMs', 'redactedTranscript',
    'transcriptDigest', 'truncated', 'surface', 'promptClass', 'untrusted',
  ], field);
  if (observation.untrusted !== true) fail(`${field}.untrusted`, 'terminal observations must be untrusted');
  return {
    observationId: identifierValue(observation.observationId, `${field}.observationId`),
    captureEpoch: integerValue(observation.captureEpoch, `${field}.captureEpoch`),
    observedAtMs: integerValue(observation.observedAtMs, `${field}.observedAtMs`),
    redactedTranscript: textValue(
      observation.redactedTranscript,
      `${field}.redactedTranscript`,
      MAX_TRANSCRIPT_CHARACTERS,
      true,
    ),
    transcriptDigest: identifierValue(observation.transcriptDigest, `${field}.transcriptDigest`),
    truncated: booleanValue(observation.truncated, `${field}.truncated`),
    surface: enumValue(observation.surface, PROMPT_SURFACES, `${field}.surface`),
    promptClass: enumValue(observation.promptClass, PROMPT_CLASSES, `${field}.promptClass`),
    untrusted: true,
  };
}

function decodeVerification(value: unknown, field: string): TerminalVerificationSnapshotV1 {
  const verification = objectValue(value, field);
  exactKeys(verification, [
    'obligationId', 'actionId', 'state', 'evidenceId', 'evidenceDigest', 'independent',
  ], field);
  const evidenceId = nullableText(verification.evidenceId, `${field}.evidenceId`);
  const evidenceDigest = nullableText(verification.evidenceDigest, `${field}.evidenceDigest`);
  if ((evidenceId === null) !== (evidenceDigest === null)) {
    fail(field, 'verification evidence identity and digest must appear together');
  }
  return {
    obligationId: identifierValue(verification.obligationId, `${field}.obligationId`),
    actionId: identifierValue(verification.actionId, `${field}.actionId`),
    state: enumValue(verification.state, VERIFICATION_STATES, `${field}.state`),
    evidenceId,
    evidenceDigest,
    independent: booleanValue(verification.independent, `${field}.independent`),
  };
}

function decodeAction(value: unknown, field: string): TerminalActionSnapshotV1 {
  const action = objectValue(value, field);
  exactKeys(action, [
    'actionId', 'actionKind', 'actionDigest', 'state', 'risk', 'approvalId',
    'observationId', 'verification', 'verified', 'proposedAtMs', 'updatedAtMs',
  ], field);
  const actionId = identifierValue(action.actionId, `${field}.actionId`);
  const verification = action.verification === null
    ? null
    : decodeVerification(action.verification, `${field}.verification`);
  if (verification && verification.actionId !== actionId) {
    fail(`${field}.verification.actionId`, 'verification is bound to another action');
  }
  const verified = booleanValue(action.verified, `${field}.verified`);
  if (verified && (!verification || verification.state !== 'satisfied' || !verification.independent)) {
    fail(`${field}.verified`, 'verified action requires satisfied independent evidence');
  }
  const proposedAtMs = integerValue(action.proposedAtMs, `${field}.proposedAtMs`);
  const updatedAtMs = integerValue(action.updatedAtMs, `${field}.updatedAtMs`);
  if (updatedAtMs < proposedAtMs) fail(`${field}.updatedAtMs`, 'action update predates proposal');
  return {
    actionId,
    actionKind: textValue(action.actionKind, `${field}.actionKind`, MAX_IDENTIFIER_CHARACTERS),
    actionDigest: identifierValue(action.actionDigest, `${field}.actionDigest`),
    state: enumValue(action.state, INTERACTION_STATES, `${field}.state`),
    risk: action.risk === null ? null : decodeRisk(action.risk, `${field}.risk`),
    approvalId: nullableText(action.approvalId, `${field}.approvalId`),
    observationId: nullableText(action.observationId, `${field}.observationId`),
    verification,
    verified,
    proposedAtMs,
    updatedAtMs,
  };
}

function decodeEvent(value: unknown, field: string): TerminalJournalEventV1 {
  const event = objectValue(value, field);
  exactKeys(event, [
    'schemaVersion', 'runId', 'actionId', 'sequence', 'occurredAtMs', 'state',
    'eventDigest', 'redactedPreview',
  ], field);
  if (event.schemaVersion !== 1) fail(`${field}.schemaVersion`, 'event schemaVersion must be 1');
  return {
    schemaVersion: 1,
    runId: identifierValue(event.runId, `${field}.runId`),
    actionId: identifierValue(event.actionId, `${field}.actionId`),
    sequence: integerValue(event.sequence, `${field}.sequence`),
    occurredAtMs: integerValue(event.occurredAtMs, `${field}.occurredAtMs`),
    state: enumValue(event.state, INTERACTION_STATES, `${field}.state`),
    eventDigest: identifierValue(event.eventDigest, `${field}.eventDigest`),
    redactedPreview: textValue(event.redactedPreview, `${field}.redactedPreview`, MAX_TEXT_CHARACTERS, true),
  };
}

export function decodeAgentTerminalSnapshotV1(value: unknown): AgentTerminalSnapshotV1 {
  const snapshot = objectValue(value, 'Agent terminal snapshot');
  exactKeys(snapshot, [
    'schemaVersion', 'runId', 'targetDigest', 'sessionId', 'lastSequence',
    'controlState', 'captureEpoch', 'leaseOwner', 'leaseState', 'leaseEpoch',
    'leaseRevision', 'currentObservation', 'actions', 'pendingApproval', 'events',
  ], 'Agent terminal snapshot');
  if (snapshot.schemaVersion !== 1) fail('schemaVersion', 'snapshot schemaVersion must be 1');
  const runId = identifierValue(snapshot.runId, 'runId');
  const targetDigest = identifierValue(snapshot.targetDigest, 'targetDigest');
  const sessionId = identifierValue(snapshot.sessionId, 'sessionId');
  const lastSequence = integerValue(snapshot.lastSequence, 'lastSequence');
  const controlState = enumValue(snapshot.controlState, CONTROL_STATES, 'controlState');
  const captureEpoch = integerValue(snapshot.captureEpoch, 'captureEpoch');
  const leaseOwner = enumValue(snapshot.leaseOwner, ['agent', 'user', 'unowned'] as const, 'leaseOwner');
  const leaseState = enumValue(snapshot.leaseState, ['active', 'revoked'] as const, 'leaseState');
  if (
    (controlState === 'agent' && (leaseOwner !== 'agent' || leaseState !== 'active'))
    || (controlState === 'user' && (leaseOwner !== 'user' || leaseState !== 'active'))
    || (!['agent', 'user'].includes(controlState) && (leaseOwner !== 'unowned' || leaseState !== 'revoked'))
  ) {
    fail('controlState', 'control state and lease authority are inconsistent');
  }
  const currentObservation = snapshot.currentObservation === null
    ? null
    : decodeObservation(snapshot.currentObservation, 'currentObservation');
  if (currentObservation && currentObservation.captureEpoch !== captureEpoch) {
    fail('currentObservation.captureEpoch', 'observation is bound to another capture epoch');
  }
  const actions = arrayValue(snapshot.actions, 'actions', MAX_ACTIONS)
    .map((action, index) => decodeAction(action, `actions[${index}]`));
  if (new Set(actions.map((action) => action.actionId)).size !== actions.length) {
    fail('actions', 'actions contain duplicate IDs');
  }
  const events = arrayValue(snapshot.events, 'events', MAX_EVENTS)
    .map((event, index) => decodeEvent(event, `events[${index}]`));
  let previousSequence = 0;
  for (const event of events) {
    if (event.runId !== runId || event.sequence <= previousSequence || event.sequence > lastSequence) {
      fail('events', 'events are not a monotonic projection of this run');
    }
    previousSequence = event.sequence;
  }
  const pendingApproval = snapshot.pendingApproval === null
    ? null
    : decodeApproval(snapshot.pendingApproval, 'pendingApproval');
  if (pendingApproval) {
    const action = actions.find((candidate) => candidate.actionId === pendingApproval.actionId);
    if (
      controlState !== 'agent'
      || leaseOwner !== 'agent'
      || leaseState !== 'active'
      || pendingApproval.runId !== runId
      || pendingApproval.targetDigest !== targetDigest
      || pendingApproval.sessionId !== sessionId
      || pendingApproval.leaseEpoch !== snapshot.leaseEpoch
      || pendingApproval.leaseRevision !== snapshot.leaseRevision
      || pendingApproval.state !== 'pending'
      || !action
      || action.state !== 'awaitingApproval'
      || action.approvalId !== pendingApproval.approvalId
      || action.actionDigest !== pendingApproval.actionDigest
      || action.observationId !== pendingApproval.observationId
      || action.risk?.severity !== pendingApproval.risk.severity
      || action.risk.verdict !== pendingApproval.risk.verdict
      || action.risk.stateChange !== pendingApproval.risk.stateChange
      || action.risk.policyVersion !== pendingApproval.risk.policyVersion
      || action.risk.riskDigest !== pendingApproval.risk.riskDigest
      || !currentObservation
      || currentObservation.surface !== 'linePrompt'
      || !['confirm', 'choice'].includes(currentObservation.promptClass)
      || currentObservation.observationId !== pendingApproval.observationId
      || currentObservation.transcriptDigest !== pendingApproval.observationDigest
    ) {
      fail('pendingApproval', 'pending approval binding is inconsistent with the snapshot');
    }
  }
  return {
    schemaVersion: 1,
    runId,
    targetDigest,
    sessionId,
    lastSequence,
    controlState,
    captureEpoch,
    leaseOwner,
    leaseState,
    leaseEpoch: integerValue(snapshot.leaseEpoch, 'leaseEpoch'),
    leaseRevision: integerValue(snapshot.leaseRevision, 'leaseRevision'),
    currentObservation,
    actions,
    pendingApproval,
    events,
  };
}

const COORDINATOR_ERROR_CODES: readonly Exclude<TerminalCoordinatorErrorCodeV1, 'unknown'>[] = [
  'admissionBlocked', 'invalidContract', 'runNotFound', 'actionNotFound',
  'approvalNotFound', 'approvalReplay', 'approvalExpired', 'bindingMismatch',
  'observationMissing', 'verificationMissing', 'invalidState', 'replay',
  'auditPrewriteFailed', 'leaseRejected', 'rendererRejected', 'sequenceExhausted',
  'lockUnavailable',
];

export function parseTerminalCoordinatorErrorV1(value: unknown): TerminalCoordinatorErrorV1 {
  let candidate = value;
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') {
      try {
        candidate = JSON.parse(message) as unknown;
      } catch {
        candidate = value;
      }
    }
  }
  if (candidate && typeof candidate === 'object') {
    const code = (candidate as { code?: unknown }).code;
    const message = (candidate as { message?: unknown }).message;
    if (typeof message === 'string') {
      return {
        code: COORDINATOR_ERROR_CODES.includes(code as never)
          ? code as Exclude<TerminalCoordinatorErrorCodeV1, 'unknown'>
          : 'unknown',
        message,
      };
    }
  }
  return {
    code: 'unknown',
    message: value instanceof Error ? value.message : 'Agent terminal control failed.',
  };
}

type TerminalControlCommandV1 =
  | 'agent_terminal_get_snapshot'
  | 'agent_terminal_resolve_approval'
  | 'agent_terminal_takeover_and_write'
  | 'agent_terminal_return_control'
  | 'agent_terminal_pause'
  | 'agent_terminal_stop';

async function invokeTerminalControlV1(
  command: TerminalControlCommandV1,
  request: object,
): Promise<AgentTerminalSnapshotV1> {
  // This dedicated path intentionally bypasses generic invocation logging.
  // In particular, takeover `data` must never enter logs or operation history.
  const result = await invoke<unknown>(command, { request });
  return decodeAgentTerminalSnapshotV1(result);
}

export function getAgentTerminalSnapshotV1(runId: string): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_get_snapshot', { schemaVersion: 1, runId });
}

export function resolveAgentTerminalApprovalV1(
  request: TerminalResolveApprovalRequestV1,
): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_resolve_approval', request);
}

export function takeoverAgentTerminalAndWriteV1(
  request: TerminalTakeoverAndWriteRequestV1,
): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_takeover_and_write', request);
}

export function returnAgentTerminalControlV1(
  request: TerminalRunControlRequestV1,
): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_return_control', request);
}

export function pauseAgentTerminalV1(
  request: TerminalRunControlRequestV1,
): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_pause', request);
}

export function stopAgentTerminalV1(
  request: TerminalRunControlRequestV1,
): Promise<AgentTerminalSnapshotV1> {
  return invokeTerminalControlV1('agent_terminal_stop', request);
}
