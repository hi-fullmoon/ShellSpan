import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/types';
import type { MultiHostRunbookDispatch, MultiHostRunbookTask } from '@/types/multi-host-runbook';
import type { RunbookStepExecutionResult } from '@/types/runbook';
import {
  applyMultiHostRunbookResult,
  approveMultiHostRunbookHost,
  createMultiHostRunbookTask,
  planMultiHostRunbookDispatches,
} from '@/lib/multi-host-runbook';
import { MultiHostRunbookExecution } from '../multi-host-runbook-execution';

const tauriMocks = vi.hoisted(() => ({
  cancel: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/tauri', () => ({
  buildRemoteConnectionRequest: vi.fn(),
  invokeCancelRunbookStep: tauriMocks.cancel,
  invokeExecuteRunbookStep: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

const TEXT = JSON.stringify({
  schemaVersion: 1,
  id: 'ui-multi',
  name: 'UI multi host',
  description: 'UI evidence',
  evidenceMaxAgeSeconds: 300,
  variables: [],
  prechecks: [{
    id: 'check',
    description: 'Check host',
    command: 'uname -s',
    expected: { exitCode: 0 },
    timeoutSeconds: 10,
  }],
  steps: [{
    id: 'change',
    description: 'Change host',
    command: 'sudo systemctl reload nginx',
    risk: 'stateChange',
    impact: 'One host',
    rollback: 'Restore the previous state on that host.',
    expected: { exitCode: 0 },
    timeoutSeconds: 10,
    safeToRetry: true,
  }],
});

const profiles: ConnectionProfile[] = [1, 2].map((index) => ({
  id: `profile-${index}`,
  name: `host-${index}`,
  host: `host-${index}.test`,
  port: 22,
  username: 'operator',
  authMethod: 'password',
  tags: ['production'],
  createdAt: index,
  updatedAt: index,
}));

function result(
  dispatch: MultiHostRunbookDispatch,
  status: RunbookStepExecutionResult['status'],
  stdout: string,
): RunbookStepExecutionResult {
  return {
    operationId: dispatch.operationId,
    runId: dispatch.runId,
    runbookId: dispatch.runbookId,
    sourceDigest: dispatch.sourceDigest,
    itemId: dispatch.itemId,
    itemKind: dispatch.itemKind,
    profileId: dispatch.profileId,
    status,
    risk: dispatch.risk,
    commandPreview: dispatch.commandPreview,
    startedAt: 1,
    completedAt: 2,
    source: {
      kind: 'sshRunbook',
      profileId: dispatch.profileId,
      host: dispatch.target.host,
      port: dispatch.target.port,
      username: dispatch.target.username,
    },
    exitCode: status === 'success' ? 0 : 1,
    expectedMatched: status === 'success',
    stdout,
    error: status === 'success' ? undefined : 'host failed',
  };
}

function partialTask(): MultiHostRunbookTask {
  let operation = 0;
  let task = createMultiHostRunbookTask({
    id: 'ui-task',
    sourceText: TEXT,
    variableValues: {},
    profiles,
    selectedTag: 'production',
    concurrencyLimit: 2,
    batchSize: 2,
    now: 1,
    createRunId: (profileId) => `run:${profileId}`,
  });
  let planned = planMultiHostRunbookDispatches(task, () => `operation:${operation += 1}`, 1);
  task = planned.dispatches.reduce(
    (current, dispatch) => applyMultiHostRunbookResult(current, dispatch.profileId, result(dispatch, 'success', `${dispatch.profileId}-preflight`), 2),
    planned.task,
  );
  task = approveMultiHostRunbookHost(task, 'profile-1', 3);
  task = approveMultiHostRunbookHost(task, 'profile-2', 3);
  planned = planMultiHostRunbookDispatches(task, () => `operation:${operation += 1}`, 3);
  task = applyMultiHostRunbookResult(planned.task, 'profile-1', result(planned.dispatches[0], 'success', 'alpha-step'), 4);
  return applyMultiHostRunbookResult(task, 'profile-2', result(planned.dispatches[1], 'failed', 'bravo-step'), 4);
}

describe('MultiHostRunbookExecution', () => {
  beforeEach(() => {
    tauriMocks.cancel.mockClear();
  });

  it('renders partial success and keeps evidence inside its host card', () => {
    render(<MultiHostRunbookExecution initialTask={partialTask()} profiles={profiles} onTaskChange={vi.fn()} />);

    expect(screen.getByText('runbook.multi.outcome.partialSuccess')).toBeInTheDocument();
    expect(screen.getByText('runbook.multi.partialSuccessTitle')).toBeInTheDocument();
    const firstCard = screen.getByText('host-1').closest('[data-slot="card"]');
    const secondCard = screen.getByText('host-2').closest('[data-slot="card"]');
    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();
    expect(within(firstCard as HTMLElement).getByText('alpha-step')).toBeInTheDocument();
    expect(within(firstCard as HTMLElement).queryByText('bravo-step')).not.toBeInTheDocument();
    expect(within(secondCard as HTMLElement).getByText('bravo-step')).toBeInTheDocument();
    expect(within(secondCard as HTMLElement).queryByText('alpha-step')).not.toBeInTheDocument();
  });

  it('cancels only active per-host operation IDs when the panel unmounts', async () => {
    const activeTask = createMultiHostRunbookTask({
      id: 'active-ui-task',
      sourceText: TEXT,
      variableValues: {},
      profiles: [profiles[0]],
      selectedTag: 'production',
      concurrencyLimit: 1,
      batchSize: 1,
      now: 1,
      createRunId: () => 'run:active',
    });
    const planned = planMultiHostRunbookDispatches(activeTask, () => 'operation:active', 1);
    const { unmount } = render(
      <MultiHostRunbookExecution initialTask={planned.task} profiles={profiles} onTaskChange={vi.fn()} />,
    );

    unmount();
    await waitFor(() => expect(tauriMocks.cancel).toHaveBeenCalledWith('operation:active'));
    expect(tauriMocks.cancel).toHaveBeenCalledTimes(1);
  });
});
