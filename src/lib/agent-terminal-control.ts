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

type TerminalControlCommandV1 =
  | 'agent_terminal_get_snapshot'
  | 'agent_terminal_resolve_approval'
  | 'agent_terminal_takeover_and_write'
  | 'agent_terminal_return_control'
  | 'agent_terminal_pause'
  | 'agent_terminal_stop';

function invokeTerminalControlV1(
  command: TerminalControlCommandV1,
  request: object,
): Promise<AgentTerminalSnapshotV1> {
  // This dedicated path intentionally bypasses generic invocation logging.
  // In particular, takeover `data` must never enter logs or operation history.
  return invoke<AgentTerminalSnapshotV1>(command, { request });
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
