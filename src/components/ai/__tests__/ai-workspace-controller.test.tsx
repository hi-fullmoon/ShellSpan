import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
    answerQuestion: vi.fn(async () => undefined),
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
    activityNodes: [],
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

describe('Stage 6B cold Session Skills consumer', () => {
  it.each(['draft', 'root', 'newSession'] as const)('ignores late initial history after user intent: %s', async intent => {
    connectedTerminal();
    let release!: (value: { sessions: AiSessionView['summary'][] }) => void;
    const cold = { ...runningAgentView(), status: 'idle' as const };
    const agent = adapter({
      list: vi.fn(() => new Promise<{ sessions: AiSessionView['summary'][] }>(resolve => { release = resolve; })),
      open: vi.fn(async () => cold),
      create: vi.fn(async () => cold),
      listSkills: vi.fn(async () => ({ sessionId: cold.summary.id, status: 'fresh' as const, revision: null, entries: [], diagnostics: [] })),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    await act(async () => {
      if (intent === 'root') await result.current.listSkills('/chosen');
      else if (intent === 'newSession') result.current.newSession();
      else result.current.setDraft('keep my draft');
    });
    await act(async () => { release({ sessions: [cold.summary] }); });
    expect(result.current.view).toBeNull();
    expect(agent.open).not.toHaveBeenCalled();
    expect(agent.subscribe).not.toHaveBeenCalled();
    if (intent === 'draft') expect(result.current.composer.draft).toBe('keep my draft');
    if (intent === 'root') expect(result.current.projectTargetLabel).toContain('/chosen');
  });

  it('ignores a late automatic open but retains explicitly opened session subscriptions', async () => {
    connectedTerminal();
    let release!: (value: AiSessionView) => void;
    let publish!: (value: AiSessionView) => void;
    const view = runningAgentView();
    const agent = adapter({
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(view),
      subscribe: vi.fn((_id, callback) => { publish = callback; return () => undefined; }),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.open).toHaveBeenCalledOnce());
    act(() => result.current.newSession());
    await act(async () => { release(view); publish(view); });
    expect(result.current.view).toBeNull();
    act(() => result.current.openSession(view.summary));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    act(() => { result.current.setDraft('next input'); publish({ ...view, throughSeq: 99 }); });
    expect(result.current.view?.throughSeq).toBe(99);
    expect(result.current.composer.draft).toBe('next input');
  });

  it('new conversation revokes even an already-established automatic subscription', async () => {
    connectedTerminal();
    const view = runningAgentView();
    const unsubscribe = vi.fn();
    let publish!: (value: AiSessionView) => void;
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view),
      subscribe: vi.fn((_id, callback) => { publish = callback; callback(view); return unsubscribe; }) });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => result.current.newSession());
    expect(unsubscribe).toHaveBeenCalledOnce();
    act(() => publish({ ...view, throughSeq: 99 }));
    expect(result.current.view).toBeNull();
    expect(result.current.composer.sessionId).toBeNull();
  });

  it('freezes a cold Session, lists before model start, and submits the selected slash through the same Inbox route', async () => {
    connectedTerminal();
    const cold = { ...runningAgentView(), status: 'idle' as const, summary: { ...runningAgentView().summary, status: 'idle' as const } };
    const agent = adapter({ create: vi.fn(async () => cold), listSkills: vi.fn(async () => ({ sessionId: cold.summary.id, status: 'fresh' as const, revision: 'r', diagnostics: [], entries: [{ name: 'inspect', description: 'Inspect the target', modelInvocable: false, userInvocable: true, relativePath: '.agents/skills/inspect.md', resourceBase: '.agents/skills', fileHash: 'a', instructionHash: 'b', extensions: {} }] })), submit: vi.fn(async (sessionId, input) => ({ sessionId: sessionId!, mode: input.mode, clientOperationId: input.clientOperationId })) });
    const user=userEvent.setup();render(<AiWorkspaceController scope="terminal" adapter={agent}/>);
    await user.click(screen.getByRole('button',{name:'Skills'}));expect(agent.create).not.toHaveBeenCalled();await user.type(screen.getByRole('textbox',{name:'Project directory'}),'/project');await user.click(screen.getByRole('button',{name:'Load skills'}));await waitFor(()=>expect(agent.create).toHaveBeenCalled());await waitFor(()=>expect(agent.listSkills).toHaveBeenCalled());await screen.findByText('User only');expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({request:expect.objectContaining({target:expect.objectContaining({kind:'remote',rootPath:'/project'})})}));expect(agent.create).toHaveBeenCalledTimes(1);expect(agent.submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem',{name:/inspect/}));expect(screen.getByRole('textbox')).toHaveValue('/inspect ');
    await user.click(screen.getByRole('textbox'));await user.keyboard('{Enter}');await waitFor(()=>expect(agent.submit).toHaveBeenCalledWith(cold.summary.id,expect.objectContaining({content:'/inspect ',mode:'start'})));
    expect(agent.create).toHaveBeenCalledTimes(1);
  });
});


it('keeps a new target directory when an old cold Session creation fails late', async () => {
  connectedTerminal();
  let rejectOld!: (error: Error) => void;
  let resolveNew!: (view: AiSessionView) => void;
  const create = vi.fn().mockImplementationOnce(() => new Promise<AiSessionView>((_resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise<AiSessionView>((resolve) => { resolveNew = resolve; }));
  const agent = adapter({ create, listSkills: vi.fn(async () => ({ sessionId: 'new', revision: null, status: 'fresh' as const, entries: [], diagnostics: [] })) });
  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  let old!: Promise<unknown>;
  act(() => { old = result.current.listSkills('/old').catch(() => undefined); });
  act(() => { useTerminalStore.setState({ activeSessionId: 'terminal-new', sessions: [{ sessionId: 'terminal-new', title: 'New target', host: 'new.example', port: 22, username: 'tester', status: 'connected' }] }); });
  let next!: Promise<unknown>;
  act(() => { next = result.current.listSkills('/new'); });
  await act(async () => { rejectOld(new Error('old target failed')); await old; });
  expect(result.current.skillsNeedsRoot).toBe(false);
  const cold = { ...runningAgentView(), summary: { ...runningAgentView().summary, id: 'new' } };
  await act(async () => { resolveNew(cold); await next; });
  expect(agent.listSkills).toHaveBeenCalledWith('new');
});

it('shares an explicitly frozen cold Session between paths and Skills and never guesses a root', async () => {
  connectedTerminal();
  const cold = runningAgentView();
  const paths = { entries: [], scope: null, status: 'ready' as const, code: null, excluded: 0 };
  const agent = adapter({ create: vi.fn(async()=>cold), listFileReferences: vi.fn(async()=>paths), listSkills: vi.fn(async()=>({sessionId:cold.summary.id,status:'fresh' as const,revision:null,entries:[],diagnostics:[]})) });
  const {result}=renderHook(()=>useAiSessionController({scope:'terminal',adapter:agent}));
  await expect(result.current.listFileReferences('',new AbortController().signal)).rejects.toThrow();
  expect(agent.create).not.toHaveBeenCalled();
  await act(async()=>{await result.current.listFileReferences('',new AbortController().signal,'/chosen');});
  await act(async()=>{await result.current.listSkills();});
  expect(agent.create).toHaveBeenCalledTimes(1);
  expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({request:expect.objectContaining({target:expect.objectContaining({rootPath:'/chosen',kind:'remote'})})}));
  expect(agent.listSkills).toHaveBeenCalledWith(cold.summary.id);
  expect(agent.listFileReferences).toHaveBeenCalledWith(cold.summary.id,'',expect.any(AbortSignal));
});

it('drops a delayed file result after navigation A to B to A without clearing the new target', async () => {
  connectedTerminal();let resolveOld!: (value:import('@/types/agent-file-reference').FileReferenceList)=>void;
  const paths={entries:[],scope:null,status:'ready' as const,code:null,excluded:0};
  const agent=adapter({create:vi.fn(async()=>runningAgentView()),listFileReferences:vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolveOld=r;})).mockResolvedValue(paths)});
  const {result}=renderHook(()=>useAiSessionController({scope:'terminal',adapter:agent}));
  let old!:Promise<unknown>;
  await act(async()=>{old=result.current.listFileReferences('old',new AbortController().signal,'/A').catch(e=>String(e));await Promise.resolve();});
  await waitFor(()=>expect(agent.listFileReferences).toHaveBeenCalledTimes(1));
  act(()=>useTerminalStore.setState({activeSessionId:'B',sessions:[{sessionId:'B',title:'B',host:'b.test',port:22,username:'tester',status:'connected'}]}));
  act(()=>connectedTerminal());
  await act(async()=>{await result.current.listFileReferences('new',new AbortController().signal,'/new-A');});
  await act(async()=>resolveOld(paths));
  expect(await old).toContain('AbortError');expect(result.current.projectTargetLabel).toContain('/new-A');
});
