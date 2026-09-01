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
  invokeAgentV3AuthorizeBroker,
  invokeAgentV3ConfigureOperator,
  invokeAgentV3ListAuditEvents,
  invokeAgentV3ListBrokerGrants,
  invokeAgentV3ListNotifications,
  invokeAgentV3ListOperatorGrants,
  invokeAgentV3OperatorPolicy,
  invokeAgentV3RebindRecoverySession,
  invokeAgentV3ReconcileTask,
  invokeAgentV3RecoveryStatus,
  invokeAgentV3RevokeBroker,
  invokeAgentV3RevokeOperator,
} from '@/lib/tauri';

beforeEach(() => invokeMock.mockReset());

describe('Agent M4 native IPC boundary', () => {
  it('uses dedicated recovery, notification, Operator, and audit commands', async () => {
    invokeMock.mockResolvedValue({});
    await invokeAgentV3RecoveryStatus();
    await invokeAgentV3ListNotifications();
    await invokeAgentV3ListAuditEvents();
    await invokeAgentV3OperatorPolicy();
    await invokeAgentV3ListOperatorGrants();
    await invokeAgentV3ListBrokerGrants();
    await invokeAgentV3ReconcileTask('task-1', true);
    await invokeAgentV3RebindRecoverySession('task-1', 'session-2');

    expect(invokeMock).toHaveBeenCalledWith('agent_v3_recovery_status', undefined);
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_list_notifications', undefined);
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_list_audit_events', undefined);
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_operator_policy', undefined);
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_reconcile_task', {
      taskId: 'task-1',
      continueTask: true,
    });
    expect(invokeMock).toHaveBeenCalledWith('agent_v3_rebind_recovery_session', {
      taskId: 'task-1',
      replacementSessionId: 'session-2',
    });
  });

  it('passes only bounded scope and opaque references across the WebView boundary', async () => {
    invokeMock.mockResolvedValue({ grantId: 'opaque' });
    await invokeAgentV3ConfigureOperator({
      taskId: 'task-1',
      targetIds: ['local-1'],
      toolNames: ['apply_patch'],
      effects: ['stateChange'],
      pathPrefixes: ['C:/workspace'],
      networkDestinations: [],
      allowElevation: false,
      ttlMs: 60_000,
    });
    await invokeAgentV3AuthorizeBroker({
      taskId: 'task-1',
      requestId: 'req-1',
      callId: 'call-1',
      targetId: 'local-1',
      toolName: 'exec_command',
      kind: 'elevation',
      purpose: 'elevation',
      ttlMs: 30_000,
    });
    await invokeAgentV3RevokeOperator('operator-opaque');
    await invokeAgentV3RevokeBroker('broker-opaque');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_configure_operator', {
      request: expect.objectContaining({ ttlMs: 60_000, allowElevation: false }),
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_authorize_broker', {
      request: expect.objectContaining({
        kind: 'elevation',
        purpose: 'elevation',
        callId: 'call-1',
      }),
    });
    const serialized = JSON.stringify(invokeMock.mock.calls);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secretValue');
    expect(serialized).not.toContain('elevationToken');
  });
});
