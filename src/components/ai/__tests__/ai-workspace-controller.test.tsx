import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import {
  useAiSessionController,
  type AiSessionControllerAdapters,
} from '@/components/ai/workspace/use-ai-session-controller';
import type { AiSessionAdapter, AiSessionView, AiSubmitReceipt } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';

const provider = {
  id: 'provider-test',
  preset: 'custom' as const,
  name: 'Provider test',
  kind: 'openAiCompatible' as const,
  baseUrl: 'https://example.invalid',
  model: 'model-test',
  requiresApiKey: true,
};

function adapter<Kind extends 'ask' | 'agent'>(
  kind: Kind,
  changes: Partial<AiSessionAdapter<Kind>> = {},
): AiSessionAdapter<Kind> {
  return {
    kind,
    list: vi.fn(async () => ({ sessions: [] })),
    create: vi.fn(async () => { throw new Error('unused create'); }),
    open: vi.fn(async () => { throw new Error('unused open'); }),
    subscribe: vi.fn(() => () => undefined),
    submit: vi.fn(async () => { throw new Error('unused submit'); }),
    stop: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    mutateInbox: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    refresh: vi.fn(async () => { throw new Error('unused refresh'); }),
    loadOlder: vi.fn(async () => []),
    loadArtifact: vi.fn(async () => { throw new Error('unused artifact'); }),
    dispose: vi.fn(),
    ...changes,
  };
}

function runningAgentView(): AiSessionView {
  return {
    summary: {
      id: 'agent-session-1', kind: 'agent', title: 'Run checks',
      updatedAt: '2026-09-03T00:00:00.000Z', status: 'running',
      scopeKey: 'terminal-terminal-1', archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: 'agent-session-1', taskId: 'task-1', goal: 'Run checks',
          createdAtUnixMs: 1,
          target: { kind: 'remote', targetId: 'terminal-terminal-1', sessionId: 'terminal-1' },
        },
        status: 'running', ended: false, archived: false, eventCount: 0,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: 0 },
      },
    },
    nodes: [],
    activity: null,
    inbox: [],
    pendingApproval: null,
    status: 'running',
    error: null,
    throughSeq: 10,
    canLoadOlder: false,
  };
}

function committedAskView(): AiSessionView {
  const conversation = {
    id: 'ask-session-1', startedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:01.000Z', title: 'Committed ask', archived: false,
    scope: 'workbench' as const, host: '', port: 0, username: '',
  };
  const user = {
    kind: 'userMessage' as const,
    key: 'user:committed-1',
    sourceKind: 'ask' as const,
    sessionId: conversation.id,
    turnId: 'operation-success',
    stepId: null,
    firstSeq: 0,
    lastSeq: 0,
    timestamp: conversation.updatedAt,
    messageId: 'committed-1',
    content: 'commit once',
    delivery: 'committed' as const,
  };
  return {
    summary: {
      id: conversation.id, kind: 'ask', title: conversation.title,
      updatedAt: conversation.updatedAt, status: 'running', scopeKey: 'workbench', archived: false,
    },
    snapshot: { kind: 'ask', conversation, messages: [], phase: 'streaming' },
    nodes: [user, user],
    activity: null,
    inbox: [],
    pendingApproval: null,
    status: 'running',
    error: null,
    throughSeq: null,
    canLoadOlder: false,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  useAiStore.getState().clear();
  useAiSettingsStore.setState({
    providers: [provider],
    defaultProviderId: provider.id,
    agentEnabled: true,
  });
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

afterEach(() => cleanup());

describe('AiWorkspaceController', () => {
  it('keeps approval authority adapter-owned across failure, pending commit, and draft restoration', async () => {
    const user = userEvent.setup();
    useTerminalStore.setState({
      activeSessionId: 'terminal-1',
      sessions: [{
        sessionId: 'terminal-1', title: 'Remote', host: 'example.test', port: 22,
        username: 'tester', status: 'connected', conversationId: 'conversation-1',
        conversationStartedAt: '2026-09-03T00:00:00.000Z',
      }],
    });
    const running = runningAgentView();
    const pending = {
      ...running,
      status: 'waiting' as const,
      summary: { ...running.summary, status: 'waiting' as const },
      pendingApproval: {
        sessionId: running.summary.id,
        turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1', callId: 'call-1',
        approvalId: 'approval-1', risk: 'stateChange' as const, prompt: 'Apply change',
        reason: 'Policy requires approval', expiresAtUnixMs: null, toolName: 'terminal.exec',
        target: null, arguments: { command: 'echo safe' }, effect: 'stateChange' as const, evidenceRefs: [],
      },
    };
    let publish: ((view: AiSessionView) => void) | undefined;
    const approve = vi.fn()
      .mockRejectedValueOnce(new Error('Approval conflict'))
      .mockResolvedValueOnce(undefined);
    const agent = adapter('agent', {
      list: vi.fn(async () => ({ sessions: [running.summary] })),
      open: vi.fn(async () => running),
      subscribe: vi.fn((_id, listener) => {
        publish = listener;
        listener(running);
        return () => undefined;
      }),
      approve,
    });
    render(
      <AiWorkspaceController
        scope="terminal"
        adapters={{ ask: adapter('ask'), agent }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Session and input settings' }));
    await user.click(screen.getByRole('menuitem', { name: 'Agent' }));
    await waitFor(() => expect(screen.getByText('Run checks')).toBeVisible());
    await user.type(screen.getByRole('textbox'), 'draft survives approval');

    act(() => publish?.(pending));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Approval conflict');
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => publish?.({ ...running, pendingApproval: null }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('draft survives approval'));
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('lists, opens, and replaces a running Session subscription without stopping its Runtime', async () => {
    const user = userEvent.setup();
    const view = runningAgentView();
    const unsubscribe = vi.fn();
    const agent = adapter('agent', {
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => {
        listener(view);
        return unsubscribe;
      }),
    });
    const ask = adapter('ask');
    render(<AiWorkspaceController scope="workbench" adapters={{ ask, agent }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Conversation history' }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledWith({ limit: 200 }));
    expect(screen.getByText('Run checks')).toBeVisible();

    await user.click(screen.getByText('Run checks'));
    await waitFor(() => expect(agent.open).toHaveBeenCalledWith('agent-session-1'));
    expect(agent.stop).not.toHaveBeenCalled();
    expect(ask.stop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Conversation history' }));
    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(agent.stop).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeVisible();
  });

  it('detaches immediately and preserves newer input when Ask submit fails', async () => {
    const user = userEvent.setup();
    let rejectSubmit: ((error: Error) => void) | undefined;
    const ask = adapter('ask', {
      submit: vi.fn(() => new Promise<AiSubmitReceipt>((_resolve, reject) => { rejectSubmit = reject; })),
    });
    const adapters: AiSessionControllerAdapters = { ask, agent: adapter('agent') };
    render(<AiWorkspaceController scope="workbench" adapters={adapters} />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, 'first input');
    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(textbox).toHaveValue('');
    expect(screen.getByText('first input')).toBeVisible();
    expect(screen.getByText('Sending')).toBeVisible();
    await user.type(textbox, 'newer draft');
    rejectSubmit?.(new Error('Network disconnected'));

    await waitFor(() => expect(screen.getByText('Input was not delivered')).toBeVisible());
    expect(textbox).toHaveValue('newer draft');
    expect(screen.getAllByText('first input')).toHaveLength(2);
    expect(ask.submit).toHaveBeenCalledWith(null, expect.objectContaining({
      content: 'first input', mode: 'start', clientOperationId: expect.any(String),
      create: expect.objectContaining({ kind: 'ask' }),
    }));
  });

  it('routes Agent Enter, accelerated Enter, and Stop to distinct adapter intentions', async () => {
    const user = userEvent.setup();
    useTerminalStore.setState({
      activeSessionId: 'terminal-1',
      sessions: [{
        sessionId: 'terminal-1', title: 'Remote', host: 'example.test', port: 22,
        username: 'tester', status: 'connected', conversationId: 'conversation-1',
        conversationStartedAt: '2026-09-03T00:00:00.000Z',
      }],
    });
    const view = runningAgentView();
    const agent = adapter('agent', {
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => {
        listener(view);
        return () => undefined;
      }),
      submit: vi.fn(async (_sessionId, input) => ({
        sessionId: 'agent-session-1', clientOperationId: input.clientOperationId, mode: input.mode,
      })),
      stop: vi.fn(async () => { throw new Error('Network disconnected while stopping'); }),
    });
    const adapters: AiSessionControllerAdapters = { ask: adapter('ask'), agent };
    let sequence = 0;

    function Harness(): React.ReactNode {
      const controller = useAiSessionController({
        scope: 'terminal', initialPreset: 'agent', adapters,
        operationId: () => `operation-${++sequence}`,
        now: () => 1_000 + sequence,
      });
      return (
        <AiWorkspaceRoot
          view={controller.view}
          pendingNodes={controller.pendingNodes}
          scope="terminal"
          initialPreset="agent"
          composerState={controller.composer}
          onDraftChange={controller.setDraft}
          onSubmitGesture={controller.submit}
          onStop={controller.stop}
          onBusyPreferenceChange={controller.setBusyPreference}
        />
      );
    }

    render(<Harness />);
    await waitFor(() => expect(screen.getByText('Run checks')).toBeVisible());
    const textbox = screen.getByRole('textbox');

    await user.type(textbox, 'queue input');
    expect(screen.getByRole('button', { name: 'Queue for next turn' })).toBeVisible();
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(
      'agent-session-1', expect.objectContaining({ mode: 'nextTurn', content: 'queue input' }),
    ));

    await user.type(textbox, 'steer input');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(
      'agent-session-1', expect.objectContaining({ mode: 'nextStep', content: 'steer input' }),
    ));

    await user.click(screen.getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(agent.stop).toHaveBeenCalledWith('agent-session-1'));
    await waitFor(() => expect(screen.getByText('Network disconnected while stopping')).toBeVisible());
  });

  it('reconciles an optimistic Ask node with duplicate or late committed material into one row', async () => {
    const user = userEvent.setup();
    const view = committedAskView();
    const ask = adapter('ask', {
      open: vi.fn(async () => view),
      subscribe: vi.fn(() => () => undefined),
      submit: vi.fn(async (_sessionId, input) => ({
        sessionId: view.summary.id,
        clientOperationId: input.clientOperationId,
        mode: input.mode,
      })),
    });
    const adapters: AiSessionControllerAdapters = { ask, agent: adapter('agent') };

    function Harness(): React.ReactNode {
      const controller = useAiSessionController({
        scope: 'workbench', adapters,
        operationId: () => 'operation-success',
        now: () => Date.parse('2026-09-03T00:00:01.000Z'),
      });
      return (
        <AiWorkspaceRoot
          view={controller.view}
          pendingNodes={controller.pendingNodes}
          scope="workbench"
          composerState={controller.composer}
          onDraftChange={controller.setDraft}
          onSubmitGesture={controller.submit}
        />
      );
    }

    render(<Harness />);
    await user.type(screen.getByRole('textbox'), 'commit once');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(ask.open).toHaveBeenCalledWith('ask-session-1'));
    await waitFor(() => expect(screen.getAllByText('commit once')).toHaveLength(1));
    expect(document.querySelectorAll('[data-ai-node-kind="userMessage"]')).toHaveLength(1);
  });
});
