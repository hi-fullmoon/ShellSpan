import type {
  AgentTerminalSnapshotV1,
  TerminalActionSnapshotV1,
  TerminalApprovalSnapshotV1,
  TerminalModelObservationV1,
  TerminalRiskSnapshotV1,
} from '@/lib/agent-terminal-control';

export const terminalRiskFixture: TerminalRiskSnapshotV1 = {
  severity: 'medium',
  verdict: 'requiresApproval',
  stateChange: true,
  policyVersion: 'agent-terminal-policy-v1',
  riskDigest: 'sha256-v1:risk-fixture',
};

export function makeTerminalObservation(
  overrides: Partial<TerminalModelObservationV1> = {},
): TerminalModelObservationV1 {
  return {
    observationId: 'observation-1',
    captureEpoch: 1,
    observedAtMs: 1_500,
    redactedTranscript: 'Continue? [y/N]',
    transcriptDigest: 'sha256-v1:observation-fixture',
    truncated: false,
    surface: 'linePrompt',
    promptClass: 'confirm',
    untrusted: true,
    ...overrides,
  };
}

export function makeTerminalAction(
  overrides: Partial<TerminalActionSnapshotV1> = {},
): TerminalActionSnapshotV1 {
  return {
    actionId: 'action-1',
    actionKind: 'terminal.respond',
    actionDigest: 'sha256-v1:action-fixture',
    state: 'awaitingApproval',
    risk: terminalRiskFixture,
    approvalId: 'approval-1',
    observationId: 'observation-1',
    verification: null,
    verified: false,
    proposedAtMs: 1_000,
    updatedAtMs: 1_500,
    ...overrides,
  };
}

export function makeTerminalApproval(
  nowMs = Date.now(),
  overrides: Partial<TerminalApprovalSnapshotV1> = {},
): TerminalApprovalSnapshotV1 {
  return {
    approvalId: 'approval-1',
    actionId: 'action-1',
    runId: 'run-1',
    targetDigest: 'sha256-v1:target-fixture',
    sessionId: 'agent-session-1',
    actionDigest: 'sha256-v1:action-fixture',
    driver: 'fixture.shellPrompt',
    program: 'termbridge-interactive-fixture',
    scenario: 'confirm',
    observationId: 'observation-1',
    observationDigest: 'sha256-v1:observation-fixture',
    risk: terminalRiskFixture,
    leaseEpoch: 1,
    leaseRevision: 1,
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    state: 'pending',
    ...overrides,
  };
}

export function makeAgentTerminalSnapshot(
  overrides: Partial<AgentTerminalSnapshotV1> = {},
): AgentTerminalSnapshotV1 {
  const controlState = overrides.controlState ?? 'agent';
  const authority = controlState === 'agent'
    ? { leaseOwner: 'agent' as const, leaseState: 'active' as const }
    : controlState === 'user'
      ? { leaseOwner: 'user' as const, leaseState: 'active' as const }
      : { leaseOwner: 'unowned' as const, leaseState: 'revoked' as const };
  return {
    schemaVersion: 1,
    runId: 'run-1',
    targetDigest: 'sha256-v1:target-fixture',
    sessionId: 'agent-session-1',
    lastSequence: 0,
    controlState,
    captureEpoch: 1,
    ...authority,
    leaseEpoch: 1,
    leaseRevision: 1,
    currentObservation: null,
    actions: [],
    pendingApproval: null,
    events: [],
    ...overrides,
  };
}

export function makePendingTerminalApprovalSnapshot(
  nowMs = Date.now(),
  overrides: Partial<AgentTerminalSnapshotV1> = {},
): AgentTerminalSnapshotV1 {
  return makeAgentTerminalSnapshot({
    lastSequence: 1,
    currentObservation: makeTerminalObservation(),
    actions: [makeTerminalAction()],
    pendingApproval: makeTerminalApproval(nowMs),
    ...overrides,
  });
}
