import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStore } from '@/stores/agentStore';
import {
  makeAgentActionResult,
  makeCompletedToolCall,
  makeAgentSnapshot,
} from '@/test/agent-fixtures';
import type { AgentCommandErrorV1, AgentRunSnapshotV1 } from '@/types/agent';
import { AgentWorkspace, type AgentWorkspaceTransport } from '../agent-workspace';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const runNotFound: AgentCommandErrorV1 = {
  schemaVersion: 1,
  category: 'runNotFound',
  message: 'No active Agent run.',
};

function transportFor(
  getSnapshot: AgentWorkspaceTransport['getSnapshot'],
  overrides: Partial<AgentWorkspaceTransport> = {},
): AgentWorkspaceTransport {
  return {
    listen: vi.fn(async () => vi.fn()),
    getSnapshot,
    start: vi.fn(async () => ({ schemaVersion: 1 as const, runId: 'run-1', acceptedAt: 1_000 })),
    pause: vi.fn(async (request) => makeAgentActionResult('pause', request.clientActionId)),
    resume: vi.fn(async (request) => makeAgentActionResult('resume', request.clientActionId)),
    stop: vi.fn(async (request) => makeAgentActionResult('stop', request.clientActionId)),
    sendMessage: vi.fn(async (request) => (
      makeAgentActionResult('sendMessage', request.clientActionId)
    )),
    ...overrides,
  };
}

function WorkspaceHarness({
  transport,
  providerCompatible = true,
  initialDraft = '',
  currentProfileId = 'profile-1',
  onStaticFallback = vi.fn(),
}: {
  transport: AgentWorkspaceTransport;
  providerCompatible?: boolean;
  initialDraft?: string;
  currentProfileId?: string;
  onStaticFallback?: (goal: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <AgentWorkspace
      profileId="profile-1"
      providerId="provider-1"
      providerCompatible={providerCompatible}
      currentProfileId={currentProfileId}
      terminalContext={{
        sessionId: 'session-1',
        capturedAt: 900,
        label: 'operator@prod',
        redactedText: 'load average: 2.0',
        truncated: false,
      }}
      draft={draft}
      onDraftChange={setDraft}
      canUseStaticFallback
      onStaticFallback={onStaticFallback}
      onClearStaticFallback={vi.fn()}
      transport={transport}
    />
  );
}

describe('AgentWorkspace', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
  });

  it('subscribes before its authoritative mount snapshot and recovers after remount', async () => {
    const order: string[] = [];
    const snapshot = makeAgentSnapshot();
    const unlisten = vi.fn();
    const transport = transportFor(vi.fn(async (request) => {
      order.push(`snapshot:${request.runId ?? 'active'}`);
      return snapshot;
    }), {
      listen: vi.fn(async () => {
        order.push('listen');
        return unlisten;
      }),
    });

    const first = render(<WorkspaceHarness transport={transport} />);
    expect(await screen.findByText(/prod\.example\.test/)).toBeInTheDocument();
    expect(order.slice(0, 2)).toEqual(['listen', 'snapshot:active']);
    first.unmount();
    expect(unlisten).toHaveBeenCalledOnce();

    render(<WorkspaceHarness transport={transport} />);
    expect(await screen.findByText(/prod\.example\.test/)).toBeInTheDocument();
    await waitFor(() => expect(transport.getSnapshot).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      runId: 'run-1',
    }));
    expect(transport.listen).toHaveBeenCalledTimes(2);
  });

  it('routes pause, resume, and stop only through the narrow transport and snapshots each result', async () => {
    const snapshots: AgentRunSnapshotV1[] = [
      makeAgentSnapshot({ state: 'thinking', lastSequence: 5 }),
      makeAgentSnapshot({ state: 'paused', lastSequence: 6 }),
      makeAgentSnapshot({ state: 'thinking', lastSequence: 7 }),
      makeAgentSnapshot({ state: 'cancelled', lastSequence: 8 }),
    ];
    const getSnapshot = vi.fn(async () => snapshots.shift() ?? makeAgentSnapshot({
      state: 'cancelled',
      lastSequence: 8,
    }));
    const transport = transportFor(getSnapshot);
    render(<WorkspaceHarness transport={transport} />);

    fireEvent.click(await screen.findByRole('button', { name: 'ai.dynamicAgent.pause' }));
    await waitFor(() => expect(transport.pause).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'ai.dynamicAgent.resume' }));
    await waitFor(() => expect(transport.resume).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'ai.dynamicAgent.stop' }));
    await waitFor(() => expect(transport.stop).toHaveBeenCalledOnce());
    expect((await screen.findAllByText('ai.dynamicAgent.state.cancelled')).length)
      .toBeGreaterThan(0);
    expect(getSnapshot).toHaveBeenCalledTimes(4);
  });

  it('accepts an awaiting-user answer and later steering with Enter, but not Shift+Enter', async () => {
    const awaiting = makeAgentSnapshot({
      state: 'awaitingUser',
      pendingQuestion: {
        questionId: 'question-1',
        question: 'Which service is affected?',
        askedAt: 1_500,
      },
    });
    const thinking = makeAgentSnapshot({ state: 'thinking', lastSequence: 6 });
    const transport = transportFor(vi.fn()
      .mockResolvedValueOnce(awaiting)
      .mockResolvedValueOnce(thinking)
      .mockResolvedValueOnce(makeAgentSnapshot({ state: 'thinking', lastSequence: 7 })));
    render(<WorkspaceHarness transport={transport} />);

    const answer = await screen.findByRole('textbox', {
      name: 'ai.dynamicAgent.composer.question',
    });
    fireEvent.change(answer, { target: { value: 'nginx' } });
    fireEvent.keyDown(answer, { key: 'Enter', shiftKey: true });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(answer, { key: 'Enter' });
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('nginx')).toBeInTheDocument();
    expect(screen.getAllByText('ai.dynamicAgent.message.answer').length).toBeGreaterThan(0);

    const steering = await screen.findByRole('textbox', {
      name: 'ai.dynamicAgent.composer.steering',
    });
    fireEvent.change(steering, { target: { value: 'also inspect memory' } });
    fireEvent.keyDown(steering, { key: 'Enter' });
    await waitFor(() => expect(transport.sendMessage).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('also inspect memory')).toBeInTheDocument();
    expect(screen.getAllByText('ai.dynamicAgent.message.steering').length).toBeGreaterThan(0);
    expect(screen.getByText('ai.dynamicAgent.state.thinking', {
      selector: '[aria-live]',
    })).toBeInTheDocument();
  });

  it('surfaces production p1Blocked and preserves the explicit static fallback', async () => {
    const onStaticFallback = vi.fn();
    const blocked: AgentCommandErrorV1 = {
      schemaVersion: 1,
      category: 'p1Blocked',
      message: 'P1 dynamic Agent execution remains blocked.',
    };
    const transport = transportFor(vi.fn(async () => Promise.reject(runNotFound)), {
      start: vi.fn(async () => Promise.reject(blocked)),
    });
    render(
      <WorkspaceHarness
        transport={transport}
        initialDraft="diagnose disk"
        onStaticFallback={onStaticFallback}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'ai.dynamicAgent.start' }));
    await waitFor(() => expect(transport.start).toHaveBeenCalledOnce());
    expect(await screen.findByText('P1 dynamic Agent execution remains blocked.'))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.dynamicAgent.staticFallback' }));
    expect(onStaticFallback).toHaveBeenCalledWith('diagnose disk');
  });

  it('blocks an incompatible provider locally while keeping diagnostic fallback available', async () => {
    const onStaticFallback = vi.fn();
    const transport = transportFor(vi.fn(async () => Promise.reject(runNotFound)));
    render(
      <WorkspaceHarness
        transport={transport}
        providerCompatible={false}
        initialDraft="diagnose load"
        onStaticFallback={onStaticFallback}
      />,
    );

    expect(await screen.findByText('ai.dynamicAgent.providerIncompatibleTitle'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ai.dynamicAgent.start' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ai.dynamicAgent.staticFallback' }));
    expect(onStaticFallback).toHaveBeenCalledWith('diagnose load');
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('renders frozen target, budgets, tools, evidence, report, errors, and evidence navigation', async () => {
    const base = makeAgentSnapshot();
    const evidence = {
      evidenceId: 'evidence-1',
      runId: 'run-1',
      targetDigest: base.target.targetDigest,
      source: 'shell.execReadOnly' as const,
      toolCallId: 'tool-1',
      observedAt: 1_350,
      summary: 'The root filesystem is 80% full.',
      stdoutExcerpt: '/dev/root 80%',
      exitCode: 0,
      truncated: true,
      observationDigest: 'sha256-v1:evidence-fixture',
    };
    const snapshot = makeAgentSnapshot({
      state: 'blocked',
      lastSequence: 10,
      budgets: {
        ...base.budgets,
        usage: {
          ...base.budgets.usage,
          modelTurnsUsed: base.budgets.policy.maxModelTurns,
          toolCallsUsed: base.budgets.policy.maxToolCalls,
        },
      },
      toolCalls: [makeCompletedToolCall()],
      evidence: [evidence],
      report: {
        outcome: 'blocked',
        summary: 'Capacity pressure is diagnosed; remediation requires review.',
        findings: [{
          title: 'Disk pressure',
          detail: 'The root filesystem is nearing capacity.',
          confidence: 'verified',
          evidenceIds: ['evidence-1'],
        }],
        changes: [],
        warnings: ['No cleanup was performed.'],
        nextActions: [{ title: 'Review cleanup candidates.', requiresChange: true }],
      },
      error: {
        schemaVersion: 1,
        category: 'providerIncompatible',
        message: 'The provider cannot guarantee strict schema output.',
        retryable: false,
        suggestion: 'Use the static diagnostic fallback.',
      },
    });
    const transport = transportFor(vi.fn(async () => snapshot));
    render(
      <WorkspaceHarness
        transport={transport}
        currentProfileId="profile-2"
        initialDraft="diagnose disk"
      />,
    );

    expect((await screen.findAllByText(/operator@prod\.example\.test:22/)).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByText('ai.dynamicAgent.frozenTargetHint').length).toBeGreaterThan(0);
    expect(screen.getByText('ai.dynamicAgent.budget.toolCalls')).toBeInTheDocument();
    expect(screen.getByText('ai.dynamicAgent.budget.modelTurns')).toBeInTheDocument();
    expect(screen.getByText('ai.dynamicAgent.budget.exhausted')).toBeInTheDocument();
    expect(screen.getByText("'df' '-h'")).toBeInTheDocument();
    expect(screen.getAllByText('ai.dynamicAgent.tool.truncated').length).toBeGreaterThan(0);
    expect(screen.getByText('Capacity pressure is diagnosed; remediation requires review.'))
      .toBeInTheDocument();
    expect(screen.getByText(/The provider cannot guarantee strict schema output\./))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ai.dynamicAgent.tool.outputDetails' }));
    expect(await screen.findByText('/dev/root 80%')).toBeInTheDocument();
    const evidenceLinks = screen.getAllByRole('button', { name: 'evidence-1' });
    fireEvent.click(evidenceLinks[evidenceLinks.length - 1]);
    expect(document.activeElement).toHaveAttribute('id', 'agent-evidence-run-1-evidence-1');
  });
});
