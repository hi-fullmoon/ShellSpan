import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  invokeAgentV3ExecuteFleetTool,
  invokeAgentV3FleetPolicy,
  invokeAgentV3GetFleet,
  invokeAgentV3ListFleets,
  invokeAgentV3ReconcileFleetTarget,
  invokeAgentV3RecordFleetRollback,
  invokeAgentV3RegisterFleet,
  invokeAgentV3RegisterSubAgent,
  invokeAgentV3SubmitFleetVerification,
} from '@/lib/tauri';
import type { AgentToolCallV3 } from '@/types/agent-v3';

beforeEach(() => invokeMock.mockReset());

describe('Agent M5 Fleet native IPC boundary', () => {
  it('registers only frozen host metadata and bounded rollout policy', async () => {
    invokeMock.mockResolvedValue({ fleetId: 'fleet-1' });
    await invokeAgentV3RegisterFleet({
      fleetId: 'fleet-1',
      goal: 'Roll out a verified configuration',
      members: [
        {
          taskId: 'task-a',
          targetId: 'host-a',
          displayName: 'API A',
          labels: { service: 'api' },
          group: 'production',
          environment: 'prod',
        },
        {
          taskId: 'task-b',
          targetId: 'host-b',
          displayName: 'API B',
          labels: { service: 'api' },
          group: 'production',
          environment: 'prod',
        },
      ],
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
        jitterMs: 500,
        maxCallsTotal: 16,
        maxCallsPerTarget: 8,
      },
    });
    await invokeAgentV3RegisterSubAgent({
      fleetId: 'fleet-1',
      role: 'verifier',
      targetIds: ['host-a', 'host-b'],
      toolNames: ['read_file'],
      effects: ['readOnly'],
      maxCalls: 4,
    });
    await invokeAgentV3FleetPolicy();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_register_fleet', {
      request: expect.objectContaining({
        fleetId: 'fleet-1',
        policy: expect.objectContaining({ canarySize: 1, maxFailures: 0 }),
      }),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_register_sub_agent', {
      request: expect.objectContaining({
        role: 'verifier',
        effects: ['readOnly'],
      }),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'agent_v3_fleet_policy', undefined);
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('password');
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('secretValue');
  });

  it('routes execution, independent verification, reconciliation, and rollback through Rust', async () => {
    invokeMock.mockResolvedValue({});
    const call: AgentToolCallV3 = {
      requestId: 'req-a',
      callId: 'call-a',
      toolName: 'read_file',
      arguments: { path: 'config.toml', encoding: 'utf8' },
      target: {
        kind: 'local',
        targetId: 'host-a',
        sessionId: 'session-a',
        cwd: '/workspace',
      },
      capabilityId: 'opaque-capability',
    };

    await invokeAgentV3ExecuteFleetTool('fleet-1', 'subagent-verifier', call);
    await invokeAgentV3SubmitFleetVerification({
      fleetId: 'fleet-1',
      subAgentId: 'subagent-verifier',
      targetId: 'host-a',
      evidenceCallId: 'call-a',
      succeeded: true,
      summary: 'Read-back matched',
    });
    await invokeAgentV3ReconcileFleetTarget('fleet-1', 'host-b', true);
    await invokeAgentV3RecordFleetRollback('fleet-1', 'host-b', 'checkpoint-1');
    await invokeAgentV3GetFleet('fleet-1');
    await invokeAgentV3ListFleets();

    expect(invokeMock).toHaveBeenCalledWith('agent_v3_execute_fleet_tool', {
      fleetId: 'fleet-1',
      subAgentId: 'subagent-verifier',
      call,
    });
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_submit_fleet_verification', {
      request: expect.objectContaining({ evidenceCallId: 'call-a', succeeded: true }),
    });
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_reconcile_fleet_target', {
      fleetId: 'fleet-1',
      targetId: 'host-b',
      continueWithVerification: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_record_fleet_rollback', {
      fleetId: 'fleet-1',
      targetId: 'host-b',
      checkpointId: 'checkpoint-1',
    });
  });
});
