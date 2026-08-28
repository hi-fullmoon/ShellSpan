import { describe, expect, it } from 'vitest';
import coordinatorFixture from '../../../tests/fixtures/agent-terminal-protocol/v1/terminal-coordinator.json';
import acceptanceFixture from '../../../tests/fixtures/agent-terminal-protocol/v1/terminal-acceptance.json';
import controlSource from '../agent-terminal-control.ts?raw';
import backendIpcSource from '../../../src-tauri/src/agent/terminal_ipc.rs?raw';

describe('Agent terminal narrow control plane v1', () => {
  it('shares the complete coordinator state and safety vocabulary with Rust', () => {
    expect(coordinatorFixture.schemaVersion).toBe(1);
    expect(coordinatorFixture.stateNames).toEqual([
      'proposed', 'validating', 'evaluatingRisk', 'awaitingApproval', 'approved',
      'rejected', 'expired', 'revoked', 'writing', 'awaitingObservation',
      'handoffRequired', 'completed', 'failed', 'cancelled', 'unknownEffect',
    ]);
    for (const surface of coordinatorFixture.unsupportedSurfaces) {
      expect(['fullScreen', 'editor', 'installer', 'unknown']).toContain(surface);
    }
  });

  it('exposes only the six narrow backend commands', () => {
    for (const command of coordinatorFixture.controlCommands) {
      expect(controlSource).toContain(`'${command}'`);
      expect(backendIpcSource).toContain(`fn ${command}`);
    }
    for (const command of coordinatorFixture.forbiddenControlCommands) {
      expect(controlSource).not.toContain(`'${command}'`);
      expect(backendIpcSource).not.toContain(`fn ${command}`);
    }
  });

  it('keeps takeover raw data off generic logging and all public snapshots token-free', () => {
    expect(controlSource).not.toContain('invokeLogged');
    expect(backendIpcSource).not.toContain('request.data');
    for (const field of coordinatorFixture.forbiddenSnapshotFields) {
      expect(controlSource).not.toMatch(new RegExp(`\\b${field}\\??:`));
    }
  });

  it('shares the phase-5 acceptance matrix with Rust without opening admission', () => {
    expect(acceptanceFixture.schemaVersion).toBe(1);
    expect(acceptanceFixture.startCommit).toBe(
      '18cd213d426d650e6c6229f28897308f7a0b22c9',
    );
    expect(acceptanceFixture.requirements.map((requirement) => requirement.id)).toEqual([
      'AT-OWNERSHIP-001',
      'AT-PROTOCOL-002',
      'AT-COORDINATOR-003',
      'AT-HANDOFF-004',
      'AT-CAPTURE-005',
      'AT-VERIFICATION-006',
      'AT-UI-AUTHORITY-007',
      'AT-XTERM-ISOLATION-008',
      'AT-LIFECYCLE-009',
      'AT-ADMISSION-010',
    ]);
    expect(acceptanceFixture.admission).toEqual({
      p0: 'blocked',
      p1: 'blocked',
      p2: 'blocked',
      p3: 'planned',
      productionAgentTerminal: 'blocked',
    });
    expect(controlSource).toContain('AGENT_TERMINAL_PRODUCTION_ADMITTED_V1 = false');
  });
});
