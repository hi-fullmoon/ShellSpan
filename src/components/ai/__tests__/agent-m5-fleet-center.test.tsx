import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentFleetSnapshotV3 } from '@/types/agent-v3';

const mocks = vi.hoisted(() => ({
  rollout: vi.fn(),
  listFleets: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  isTauriRuntime: () => true,
  invokeAgentV3RolloutPolicy: mocks.rollout,
  invokeAgentV3ListFleets: mocks.listFleets,
}));

import { AgentM5FleetCenter } from '@/components/ai/agent-m5-fleet-center';

const fleet: AgentFleetSnapshotV3 = {
  fleetId: 'fleet-prod',
  goal: 'Roll out API configuration',
  state: 'failStopped',
  selector: {
    labels: { service: 'api' },
    groups: ['production'],
    environments: ['prod'],
  },
  policy: {
    maxConcurrency: 2,
    batchSize: 2,
    canarySize: 1,
    maxFailures: 0,
    jitterMs: 250,
    maxCallsTotal: 16,
    maxCallsPerTarget: 8,
  },
  targetSnapshotSha256: 'a'.repeat(64),
  writeIntent: true,
  waves: [['host-a'], ['host-b', 'host-c']],
  currentWave: 0,
  targets: [
    {
      taskId: 'task-a',
      targetId: 'host-a',
      displayName: 'API canary',
      labels: { service: 'api' },
      group: 'production',
      environment: 'prod',
      waveIndex: 0,
      state: 'failed',
      planVersion: 1,
      allowedTools: ['apply_patch', 'read_file'],
      allowedEffects: ['stateChange', 'readOnly'],
      callsUsed: 1,
      lastCallId: 'write-a',
      lastWriterSubAgentId: 'operator-a',
      lastError: 'Native verification failed on canary',
    },
    {
      taskId: 'task-b',
      targetId: 'host-b',
      displayName: 'API B',
      labels: { service: 'api' },
      group: 'production',
      environment: 'prod',
      waveIndex: 1,
      state: 'blocked',
      planVersion: 1,
      allowedTools: ['apply_patch', 'read_file'],
      allowedEffects: ['stateChange', 'readOnly'],
      callsUsed: 0,
      lastError: 'blocked by native Fleet failure threshold',
    },
    {
      taskId: 'task-c',
      targetId: 'host-c',
      displayName: 'API C',
      labels: { service: 'api' },
      group: 'production',
      environment: 'prod',
      waveIndex: 1,
      state: 'blocked',
      planVersion: 1,
      allowedTools: ['apply_patch', 'read_file'],
      allowedEffects: ['stateChange', 'readOnly'],
      callsUsed: 0,
      lastError: 'blocked by native Fleet failure threshold',
    },
  ],
  subAgents: [],
  callsUsed: 1,
  activeCallCount: 0,
  failureCount: 1,
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollout.mockResolvedValue({
    stage: 'runtime',
    contractAvailable: true,
    executionContractVersion: 3,
    rollbackContractVersion: 2,
  });
  mocks.listFleets.mockResolvedValue([fleet]);
});

describe('Agent M5 Fleet result matrix', () => {
  it('renders every Rust target and never hides canary failure behind an aggregate', async () => {
    const user = userEvent.setup();
    render(<AgentM5FleetCenter />);

    expect(await screen.findByText('Fleet rollout matrix')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Matrix' }));

    expect(screen.getByText('Roll out API configuration')).toBeInTheDocument();
    expect(screen.getByText('API canary')).toBeInTheDocument();
    expect(screen.getByText('API B')).toBeInTheDocument();
    expect(screen.getByText('API C')).toBeInTheDocument();
    expect(screen.getByText('Native verification failed on canary')).toBeInTheDocument();
    expect(screen.getAllByText('blocked by native Fleet failure threshold')).toHaveLength(2);
    expect(screen.getByText(/1 failed target/)).toBeInTheDocument();
    expect(screen.queryByText(/all hosts succeeded/i)).not.toBeInTheDocument();
  });
});
