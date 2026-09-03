import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiWorkspaceController } from '@/components/ai/workspace/ai-workspace-controller';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import {
  useAiSessionController,
  type AiSessionControllerAdapter,
} from '@/components/ai/workspace/use-ai-session-controller';
import type { AiSessionView, AiSubmitReceipt } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
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

function adapter(changes: Partial<AiSessionControllerAdapter> = {}): AiSessionControllerAdapter {
  return {
    kind: 'agent',
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

function connectedTerminal(): void {
  useTerminalStore.setState({
    activeSessionId: 'terminal-1',
    sessions: [{
      sessionId: 'terminal-1',
      title: 'Remote',
      host: 'example.test',
      port: 22,
      username: 'tester',
      status: 'connected',
    }],
  });
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
    inbox: [],
    pendingApproval: null,
    status: 'running',
    error: null,
    throughSeq: 10,
    canLoadOlder: false,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  useAgentPermissionStore.getState().resetAll();
  useAiSettingsStore.setState({
    providers: [provider],
    defaultProviderId: provider.id,
    agentEnabled: true,
  });
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

afterEach(() => cleanup());

describe('AiWorkspaceController', () => {
  it('shows an explicit disabled Agent state in Workbench without submitting a fallback', async () => {
    const agent = adapter();
    render(<AiWorkspaceController scope="workbench" adapter={agent} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Agent is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Open a connected terminal');
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledTimes(1));
    expect(agent.submit).not.toHaveBeenCalled();
  });

  it('requires the active terminal to remain connected before accepting Agent input', () => {
    connectedTerminal();
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((session) => (
        session.sessionId === 'terminal-1' ? { ...session, status: 'disconnected' } : session
      )),
    }));
    const agent = adapter();
    render(<AiWorkspaceController scope="terminal" adapter={agent} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Open a connected terminal');
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(agent.submit).not.toHaveBeenCalled();
  });

  it('retries Agent history through the single production adapter', async () => {
    const agent = adapter({
      list: vi.fn()
        .mockRejectedValueOnce(new Error('Agent history unavailable'))
        .mockResolvedValueOnce({ sessions: [runningAgentView().summary] }),
    });
    render(<AiWorkspaceController scope="workbench" adapter={agent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent history unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Run checks')).toBeVisible();
    expect(agent.list).toHaveBeenCalledTimes(2);
  });

  it('keeps approval authority adapter-owned across failure, pending commit, and draft restoration', async () => {
    const user = userEvent.setup();
    connectedTerminal();
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
    const agent = adapter({
      list: vi.fn(async () => ({ sessions: [running.summary] })),
      open: vi.fn(async () => running),
      subscribe: vi.fn((_id, listener) => {
        publish = listener;
        listener(running);
        return () => undefined;
      }),
      approve,
    });
    render(<AiWorkspaceController scope="terminal" adapter={agent} />);
    await waitFor(() => expect(screen.getByText('Run checks')).toBeVisible());
    await user.type(screen.getByRole('textbox'), 'draft survives approval');

    act(() => publish?.(pending));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Approval conflict');

    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    act(() => publish?.({ ...running, pendingApproval: null }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('draft survives approval'));
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('opens Agent history without stopping the Runtime and disables new Workbench sessions', async () => {
    const user = userEvent.setup();
    const view = runningAgentView();
    const unsubscribe = vi.fn();
    const agent = adapter({
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => {
        listener(view);
        return unsubscribe;
      }),
    });
    render(<AiWorkspaceController scope="workbench" adapter={agent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    expect(await screen.findByText('Run checks')).toBeVisible();
    await user.click(screen.getByText('Run checks'));
    await waitFor(() => expect(agent.open).toHaveBeenCalledWith('agent-session-1'));
    expect(agent.stop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Conversation history' }));
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('detaches a new Agent input, maps read-only auto approval, and preserves newer input on failure', async () => {
    const user = userEvent.setup();
    connectedTerminal();
    let rejectSubmit: ((error: Error) => void) | undefined;
    const agent = adapter({
      submit: vi.fn(() => new Promise<AiSubmitReceipt>((_resolve, reject) => { rejectSubmit = reject; })),
    });
    render(<AiWorkspaceController scope="terminal" adapter={agent} />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, 'first input');
    fireEvent.keyDown(textbox, { key: 'Enter' });

    expect(textbox).toHaveValue('');
    expect(screen.getByText('first input')).toBeVisible();
    expect(screen.getByText('Sending')).toBeVisible();
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(null, expect.objectContaining({
      content: 'first input',
      mode: 'start',
      create: expect.objectContaining({
        kind: 'agent',
        request: expect.objectContaining({ permissionMode: 'scopedAutopilot' }),
      }),
    })));

    await user.type(textbox, 'newer draft');
    rejectSubmit?.(new Error('Network disconnected'));
    await waitFor(() => expect(screen.getByText('Input was not delivered')).toBeVisible());
    expect(textbox).toHaveValue('newer draft');
    expect(screen.getAllByText('first input')).toHaveLength(2);
  });

  it('maps the full-access UI choice to the Runtime operator mode', async () => {
    connectedTerminal();
    useAgentPermissionStore.getState().setMode('terminal-1', 'fullAccess');
    const agent = adapter({
      submit: vi.fn(async (_sessionId, input) => ({
        sessionId: 'agent-created',
        clientOperationId: input.clientOperationId,
        mode: input.mode,
      })),
    });
    render(<AiWorkspaceController scope="terminal" adapter={agent} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Run with operator access' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(null, expect.objectContaining({
      create: expect.objectContaining({
        request: expect.objectContaining({ permissionMode: 'operator' }),
      }),
    })));
  });

  it('routes Agent Enter, accelerated Enter, and Stop to distinct adapter intentions', async () => {
    const user = userEvent.setup();
    connectedTerminal();
    const view = runningAgentView();
    const agent = adapter({
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => {
        listener(view);
        return () => undefined;
      }),
      submit: vi.fn(async (_sessionId, input) => ({
        sessionId: view.summary.id,
        clientOperationId: input.clientOperationId,
        mode: input.mode,
      })),
      stop: vi.fn(async () => { throw new Error('Network disconnected while stopping'); }),
    });
    let sequence = 0;

    function Harness(): React.ReactNode {
      const controller = useAiSessionController({
        scope: 'terminal',
        adapter: agent,
        operationId: () => `operation-${++sequence}`,
        now: () => 1_000 + sequence,
      });
      return (
        <AiWorkspaceRoot
          view={controller.view}
          pendingNodes={controller.pendingNodes}
          scope="terminal"
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
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(
      view.summary.id,
      expect.objectContaining({ mode: 'nextTurn', content: 'queue input' }),
    ));

    await user.type(textbox, 'steer input');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(
      view.summary.id,
      expect.objectContaining({ mode: 'nextStep', content: 'steer input' }),
    ));

    await user.click(screen.getByRole('button', { name: 'Stop task' }));
    await waitFor(() => expect(agent.stop).toHaveBeenCalledWith(view.summary.id));
    expect(await screen.findByText('Network disconnected while stopping')).toBeVisible();
  });
});
