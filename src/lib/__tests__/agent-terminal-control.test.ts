import { describe, expect, it } from 'vitest';
import coordinatorFixture from '../../../tests/fixtures/agent-terminal-protocol/v1/terminal-coordinator.json';
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
});
