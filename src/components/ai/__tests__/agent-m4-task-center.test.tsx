import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTaskSnapshotV3 } from '@/types/agent-v3';

const mocks = vi.hoisted(() => ({
  rollout: vi.fn(),
  listTasks: vi.fn(),
  operatorPolicy: vi.fn(),
  listOperatorGrants: vi.fn(),
  recoveryStatus: vi.fn(),
  listAudit: vi.fn(),
  reconcile: vi.fn(),
  configureOperator: vi.fn(),
  revokeOperator: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  isTauriRuntime: () => true,
  invokeAgentV3RolloutPolicy: mocks.rollout,
  invokeAgentV3ListTasks: mocks.listTasks,
  invokeAgentV3OperatorPolicy: mocks.operatorPolicy,
  invokeAgentV3ListOperatorGrants: mocks.listOperatorGrants,
  invokeAgentV3RecoveryStatus: mocks.recoveryStatus,
  invokeAgentV3ListAuditEvents: mocks.listAudit,
  invokeAgentV3ReconcileTask: mocks.reconcile,
  invokeAgentV3ConfigureOperator: mocks.configureOperator,
  invokeAgentV3RevokeOperator: mocks.revokeOperator,
}));

import { AgentM4TaskCenter } from '@/components/ai/agent-m4-task-center';

const task: AgentTaskSnapshotV3 = {
  request: {
    contractVersion: 3,
    requestId: 'req-m4',
    userSessionId: 'user-m4',
    taskId: 'task-m4',
    goal: 'Recover a background task',
    successCriteria: ['Verified evidence'],
    targets: [{
      kind: 'local',
      targetId: 'local-m4',
      sessionId: 'session-m4',
      cwd: 'C:/workspace',
    }],
    permissionMode: 'operator',
    sourceContract: 'v3',
  },
  state: 'needsReconciliation',
  sequence: 8,
  results: [],
  processes: [],
  plan: {
    version: 1,
    steps: [{
      id: 'patch',
      description: 'Patch config',
      dependencies: [],
      targetIds: ['local-m4'],
      requiredTools: ['apply_patch'],
      expectedEffect: 'stateChange',
      successCriteria: ['Verified'],
      rollbackOrCompensation: 'Restore checkpoint',
      status: 'inProgress',
      evidenceRefs: [],
    }],
    updatedAtUnixMs: 1,
  },
  checkpoints: [],
  context: {
    generation: 1,
    fragments: [],
    artifacts: [],
    usage: {
      sourceBytes: 0,
      modelVisibleBytes: 0,
      estimatedInputTokens: 0,
      costReason: 'unavailable',
    },
  },
  extensions: {
    generation: 1,
    workspaceLoaded: false,
    skills: [],
    hooks: [],
    runbooks: [],
    recentHookEvents: [],
  },
  mcpServers: [],
  mcpResults: [],
  recovery: {
    disposition: 'needsReconciliation',
    phase: 'reconciliation',
    progressCompleted: 0,
    progressTotal: 1,
    calls: [{
      callId: 'call-write',
      toolName: 'apply_patch',
      targetId: 'local-m4',
      effect: 'stateChange',
      state: 'started',
      startedAtUnixMs: 1,
      updatedAtUnixMs: 2,
      automaticReplayAllowed: false,
    }],
    processes: [{
      processHandle: 'proc-opaque',
      targetId: 'process-1',
      ownerTargetId: 'local-m4',
      channel: 'direct',
      state: 'lost',
      startedAtUnixMs: 1,
      updatedAtUnixMs: 2,
      recoveryAdvice: 'Cannot reattach; inspect the target.',
    }],
    recoveryAdvice: 'Inspect the target; the uncertain write will not be replayed.',
    requiresHumanAction: true,
  },
  notifications: [{
    notificationId: 'notice-1',
    taskId: 'task-m4',
    kind: 'humanActionRequired',
    title: 'ShellSpan reconciliation required',
    body: 'A restarted task has an uncertain operation.',
    createdAtUnixMs: 2,
    delivered: true,
  }],
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
  mocks.listTasks.mockResolvedValue([task]);
  mocks.operatorPolicy.mockResolvedValue({
    stage: 'enabled',
    defaultEnabled: false,
    maximumTtlMs: 1_800_000,
    grantsSurviveRestart: false,
  });
  mocks.listOperatorGrants.mockResolvedValue([]);
  mocks.recoveryStatus.mockResolvedValue({
    formatVersion: 1,
    loaded: true,
    migrated: false,
    taskCount: 1,
    corruptionRecovered: false,
  });
  mocks.listAudit.mockResolvedValue([{ eventId: 'audit-1' }]);
  mocks.reconcile.mockResolvedValue(task);
  mocks.configureOperator.mockResolvedValue({ grantId: 'operator-1' });
});

describe('Agent M4 background task center', () => {
  it('renders only Rust snapshots and exposes honest lost/reconciliation actions', async () => {
    const user = userEvent.setup();
    render(<AgentM4TaskCenter />);

    expect(await screen.findByText('Background task center')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Recover a background task')).toBeInTheDocument();
    expect(screen.getAllByText('needsReconciliation')).toHaveLength(2);
    expect(screen.getByText('process lost')).toBeInTheDocument();
    expect(screen.getByText(/will not be replayed/)).toBeInTheDocument();
    expect(screen.queryByText(/terminal output/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revalidate & continue' }));
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith('task-m4', true));
  });

  it('configures the minimum plan-derived Operator scope with a bounded TTL', async () => {
    const user = userEvent.setup();
    mocks.listTasks.mockResolvedValue([{ ...task, state: 'active', recovery: {
      ...task.recovery,
      disposition: 'safeToResume',
      phase: 'running',
      requiresHumanAction: false,
    } }]);
    render(<AgentM4TaskCenter />);
    expect(await screen.findByText('Background task center')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Enable for 5 minutes' }));

    await waitFor(() => expect(mocks.configureOperator).toHaveBeenCalledWith({
      taskId: 'task-m4',
      targetIds: ['local-m4'],
      toolNames: ['apply_patch'],
      effects: ['stateChange'],
      pathPrefixes: ['C:/workspace'],
      networkDestinations: [],
      allowElevation: false,
      ttlMs: 300_000,
    }));
  });
});
