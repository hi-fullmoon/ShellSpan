vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/test/llm-resolver-fixture')).fixtureResolve }));
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
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
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ResolvedModel } from '@/lib/ai/provider-contract';
import * as imageDraftModule from '@/components/ai/workspace/use-image-draft';
import * as visionContract from '@/lib/ai/vision-contract';

const provider = {
  id: 'provider-test',
  preset: 'custom' as const,
  name: 'Provider test',
  kind: 'openAiCompatible' as const,
  baseUrl: 'https://example.invalid',
  model: 'model-test',
  requiresApiKey: true,
};

const routeCompat = {
  protocol: 'openAiCompatible' as const, cumulativeStream: false, supportsStreamUsage: true,
  nativeReasoning: false, splitReasoning: false, replayReasoningContent: false,
  thinkTagFallback: false, parallelToolCalls: true, strictSchema: true,
  preservesReasoningAcrossTurns: false, reasoningEncoding: 'effort' as const,
  clearThinking: false, defaultThinking: false,
};

function routeModel(routeId: string, modelId: string): ResolvedModel {
  return {
    catalogVersion: 1, routeId, providerId: routeId, modelId, profile: 'generic',
    kind: 'openAiCompatible', source: 'userDeclaration', capacityPolicy: 'explicit',
    contextWindow: 8192, maxOutputTokens: 1024, toolCalling: 'supported',
    textInput: 'supported', imageInput: 'unsupported', reasoning: [], compat: routeCompat,
  };
}

function setNativeRoute(routeId: string, modelId: string, routeRevision: number): void {
  const resolved = routeModel(routeId, modelId);
  useLlmRoutesStore.setState({
    snapshot: {
      schemaVersion: 1, revision: 12, migrationComplete: true, migrationIssues: [],
      defaultSelection: { routeId, modelId },
      routes: [{
        id: routeId, revision: routeRevision, displayName: 'RouteStore default',
        adapterId: 'chat-completions', baseUrl: 'https://route.example',
        auth: { kind: 'none' }, replayDomainId: 'route-domain', presetId: 'custom',
        models: { [modelId]: {
          contextWindow: resolved.contextWindow, maxOutputTokens: resolved.maxOutputTokens,
          toolCalling: resolved.toolCalling, textInput: resolved.textInput,
          imageInput: resolved.imageInput, reasoning: resolved.reasoning, compat: resolved.compat,
        } },
        defaults: { routeId, modelId },
        retryPolicy: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30_000, jitterRatio: 0.2 },
        timeouts: { requestHeadersMs: 30_000, firstByteMs: 30_000, streamIdleMs: 300_000 },
      }],
    },
    status: 'ready', error: undefined, modelsByRoute: { [routeId]: [resolved] },
  });
}

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

function connectedTerminal(sessionId = 'terminal-1'): void {
  useTerminalStore.setState({
    activeSessionId: sessionId,
    sessions: [{
      sessionId,
      title: 'Remote',
      host: 'example.test',
      port: 22,
      username: 'tester',
      status: 'connected',
    }],
  });
}

it('allows changing model and permissions in a running conversation without changing defaults', async () => {
  connectedTerminal();
  const user = userEvent.setup();
  const view = runningAgentView();
  const second = { ...provider, id: 'second', model: 'second-model' };
  useAiSettingsStore.setState({ providers: [provider, second], defaultProviderId: provider.id });
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [view.summary] })),
    open: vi.fn(async () => view),
    selectModel: vi.fn(async () => undefined),
    setPermission: vi.fn(async () => undefined),
  });
  render(<AiWorkspaceController scope="terminal" adapter={agent} />);
  await waitFor(() => expect(agent.open).toHaveBeenCalledWith(view.summary.id));
  const model = await screen.findByRole('button', { name: /Model selection: model-test/ });
  expect(model).toBeEnabled();
  await user.click(model);
  await user.click(await screen.findByRole('menuitem', { name: /Model.*model-test/ }));
  await user.click(screen.getByRole('menuitemradio', { name: 'second-model' }));
  await waitFor(() => expect(agent.selectModel).toHaveBeenCalledWith(view.summary.id, expect.objectContaining({ id: second.id })));
  expect(useAiSettingsStore.getState().defaultProviderId).toBe(provider.id);
  await user.click(screen.getByRole('button', { name: /Permission mode:/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: 'Full access' }));
  await user.click(await screen.findByRole('button', { name: 'Enable full access' }));
  await waitFor(() => expect(agent.setPermission).toHaveBeenCalledWith(view.summary.id, 'operator'));
  expect(useAgentPermissionStore.getState().getMode('terminal-1')).toBe('autoApproveReadOnly');
});

it('keeps the current session selection when a model change fails', async () => {
  connectedTerminal();
  const view = runningAgentView();
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [view.summary] })),
    open: vi.fn(async () => view),
    selectModel: vi.fn(async () => { throw new Error('Provider unavailable'); }),
  });
  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
  await act(async () => result.current.selectModel({ ...provider, model: 'second-model' }));
  expect(result.current.announcement).toBe('Provider unavailable');
  expect(result.current.settingsBusy).toBe(false);
  expect(result.current.modelLabel).toBe(provider.model);
});

function runningAgentView(sessionId = 'agent-session-1', terminalId = 'terminal-1'): AiSessionView {
  return {
    summary: {
      id: sessionId, kind: 'agent', title: 'Run checks',
      updatedAt: '2026-09-03T00:00:00.000Z', status: 'running',
      scopeKey: `terminal-${terminalId}`, archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId, taskId: 'task-1', goal: 'Run checks',
          createdAtUnixMs: 1,
          target: { kind: 'remote', targetId: `terminal-${terminalId}`, sessionId: terminalId },
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
  });
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
  useLlmRoutesStore.setState({ snapshot: undefined, status: 'idle', error: undefined, modelsByRoute: {} });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it.each(['', ' \n\t '])('routes image-only text %j through image submission', async draft => {
  connectedTerminal();
  const send = vi.fn(async () => undefined), reportError = vi.fn();
  const imageDraft = vi.spyOn(imageDraftModule, 'useImageDraft').mockReturnValue({
    owner: 'test', draft: { owner: 'test', revision: 1, text: draft,
      images: [{ name: 'fixture.png', mediaType: 'image/png', data: 'aGVsbG8=' }] },
    pendingFiles: [], busy: false, locked: false, error: null,
    send, reportError, add: vi.fn(), remove: vi.fn(), cancel: vi.fn(),
  });
  const vision = vi.spyOn(visionContract, 'requireVision').mockImplementation(() => undefined);
  try {
    const view = runningAgentView();
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view) });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    act(() => result.current.setDraft(draft));
    act(() => result.current.submit('primary'));
    expect(send).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
  } finally {
    imageDraft.mockRestore(); vision.mockRestore();
  }
});

it('uses the RouteStore global selection when the legacy default id differs', () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  setNativeRoute('route-default', 'route-model', 7);
  useAiSettingsStore.setState({ providers: [provider], defaultProviderId: provider.id });

  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: adapter() }));

  expect(result.current.providerLabel).toBe('RouteStore default');
  expect(result.current.modelLabel).toBe('route-model');
});

it('shows an invalid frozen route revision without crashing or falling back', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  connectedTerminal();
  setNativeRoute('route-default', 'route-model', 9);
  const base = runningAgentView();
  const current: AiSessionView = {
    ...base,
    snapshot: {
      ...base.snapshot,
      value: {
        ...base.snapshot.value,
        header: {
          ...base.snapshot.value.header,
          modelSelection: { routeId: 'route-default', modelId: 'route-model', routeRevision: 8 },
        },
      },
    },
  };
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [current.summary] })),
    open: vi.fn(async () => current),
  });

  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(result.current.view?.summary.id).toBe(current.summary.id));

  expect(result.current.selectedProvider).toBeUndefined();
  expect(result.current.agentUnavailableReason).toContain('INVALID_MODEL_SELECTION');
  expect(result.current.modelLabel).toBe('route-model');
});

describe('AiWorkspaceController', () => {
  it.each(['terminal', 'roundTrip', 'newSession', 'otherSession'] as const)(
    'keeps the current conversation when an old submission returns after %s navigation', async (destination) => {
      connectedTerminal();
      const first = runningAgentView();
      const second = runningAgentView('agent-session-2', 'terminal-2');
      let release!: (receipt: AiSubmitReceipt) => void;
      const agent = adapter({
        list: vi.fn(async (input) => ({
          sessions: [input.scopeKey === second.summary.scopeKey ? second.summary : first.summary],
        })),
        open: vi.fn(async (id) => id === second.summary.id ? second : first),
        submit: vi.fn(() => new Promise<AiSubmitReceipt>((resolve) => { release = resolve; })),
      });
      const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
      await waitFor(() => expect(result.current.view?.summary.id).toBe(first.summary.id));
      act(() => { result.current.setDraft('inspect server A'); result.current.submit('primary'); });
      await waitFor(() => expect(agent.submit).toHaveBeenCalledOnce());
      if (destination === 'newSession') {
        act(() => result.current.newSession());
      } else if (destination === 'otherSession') {
        act(() => result.current.openSession(second.summary));
        await waitFor(() => expect(result.current.view?.summary.id).toBe(second.summary.id));
      } else {
        act(() => connectedTerminal('terminal-2'));
        await waitFor(() => expect(result.current.view?.summary.id).toBe(second.summary.id));
        if (destination === 'roundTrip') {
          act(() => connectedTerminal());
          await waitFor(() => expect(result.current.view?.summary.id).toBe(first.summary.id));
        }
      }
      const expectedSession = result.current.composer.sessionId;
      act(() => result.current.setDraft('draft for the current conversation'));
      const input = vi.mocked(agent.submit).mock.calls[0][1];
      await act(async () => release({
        sessionId: first.summary.id, mode: input.mode, clientOperationId: input.clientOperationId,
      }));
      expect(result.current.composer.sessionId).toBe(expectedSession);
      expect(result.current.view?.summary.id ?? null).toBe(expectedSession);
      expect(result.current.navigation.route).toEqual({ kind: 'conversation', sessionId: expectedSession });
      expect(result.current.composer.draft).toBe('draft for the current conversation');
      expect(result.current.composer.pendingSubmissions).toEqual([]);
      expect(result.current.pendingNodes).toEqual([]);
      if (expectedSession) {
        act(() => result.current.submit('primary'));
        expect(agent.submit).toHaveBeenLastCalledWith(expectedSession, expect.objectContaining({
          content: 'draft for the current conversation',
        }));
      }
    },
  );

  it.each(['accepted', 'failed'] as const)(
    'isolates a cold submission that is %s after opening a new conversation', async (outcome) => {
      connectedTerminal();
      let release!: (receipt: AiSubmitReceipt) => void;
      let reject!: (error: Error) => void;
      const agent = adapter({
        submit: vi.fn(() => new Promise<AiSubmitReceipt>((resolve, fail) => { release = resolve; reject = fail; })),
      });
      const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
      await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
      act(() => { result.current.setDraft('old input'); result.current.submit('primary'); });
      await waitFor(() => expect(agent.submit).toHaveBeenCalledOnce());
      act(() => result.current.newSession());
      expect(result.current.composer.phase).toBe('idle');
      expect(result.current.composer.detached).toBeNull();
      expect(result.current.pendingNodes).toEqual([]);
      act(() => result.current.setDraft('new draft'));
      const input = vi.mocked(agent.submit).mock.calls[0][1];
      await act(async () => {
        if (outcome === 'failed') reject(new Error('old request failed'));
        else release({ sessionId: 'late-session', mode: input.mode, clientOperationId: input.clientOperationId });
      });
      expect(result.current.view).toBeNull();
      expect(result.current.composer).toMatchObject({
        sessionId: null, phase: 'idle', draft: 'new draft', lastError: null, pendingSubmissions: [],
      });
      expect(agent.open).not.toHaveBeenCalled();
    },
  );

  it('saves and restores independent new-conversation drafts for each terminal', async () => {
    connectedTerminal();
    const agent = adapter();
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    act(() => result.current.setDraft('server A draft'));
    act(() => connectedTerminal('terminal-2'));
    expect(result.current.composer.draft).toBe('');
    act(() => result.current.setDraft('server B draft'));
    act(() => connectedTerminal());
    expect(result.current.composer.draft).toBe('server A draft');
    act(() => connectedTerminal('terminal-2'));
    expect(result.current.composer.draft).toBe('server B draft');
  });

  it('does not reopen an explicitly selected session in a terminal with no history', async () => {
    connectedTerminal();
    const first = runningAgentView();
    const agent = adapter({
      open: vi.fn(async () => first),
      subscribe: vi.fn((_id, listener) => { listener(first); return () => undefined; }),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    act(() => result.current.openSession(first.summary));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(first.summary.id));
    act(() => result.current.setDraft('session A draft'));
    act(() => connectedTerminal('terminal-2'));
    await waitFor(() => expect(agent.list).toHaveBeenLastCalledWith(expect.objectContaining({ scopeKey: 'terminal-terminal-2' })));
    expect(agent.open).toHaveBeenCalledOnce();
    expect(result.current.view).toBeNull();
    expect(result.current.composer).toMatchObject({ sessionId: null, draft: '', phase: 'idle' });
  });

  it('renews the subscription when history selects the current session again', async () => {
    connectedTerminal();
    const view = runningAgentView();
    const listeners: ((value: AiSessionView) => void)[] = [];
    const agent = adapter({
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => { listeners.push(listener); return () => undefined; }),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    act(() => result.current.openSession(view.summary));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    act(() => result.current.setDraft('keep this draft'));
    act(() => result.current.openSession(view.summary));
    await waitFor(() => expect(agent.subscribe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.view?.throughSeq).toBe(10));
    expect(result.current.composer.draft).toBe('keep this draft');
    act(() => listeners[0]({ ...view, throughSeq: 999 }));
    expect(result.current.view?.throughSeq).toBe(10);
    act(() => listeners[1]({ ...view, throughSeq: 20 }));
    expect(result.current.view?.throughSeq).toBe(20);
  });

  it('keeps Workbench and terminal drafts separate', async () => {
    connectedTerminal();
    const agent = adapter();
    const { result, rerender } = renderHook(({ scope }: { scope: 'terminal' | 'workbench' }) => (
      useAiSessionController({ scope, adapter: agent })
    ), { initialProps: { scope: 'terminal' } });
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    act(() => result.current.setDraft('terminal draft'));
    rerender({ scope: 'workbench' });
    expect(result.current.composer.draft).toBe('');
    rerender({ scope: 'terminal' });
    expect(result.current.composer.draft).toBe('terminal draft');
  });

  it('moves a saved new-conversation draft into its created session without losing newer typing', async () => {
    connectedTerminal();
    const view = runningAgentView();
    let release!: (receipt: AiSubmitReceipt) => void;
    const agent = adapter({
      open: vi.fn(async () => view),
      submit: vi.fn(() => new Promise<AiSubmitReceipt>((resolve) => { release = resolve; })),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(agent.list).toHaveBeenCalledOnce());
    act(() => result.current.setDraft('saved prompt'));
    act(() => connectedTerminal('terminal-2'));
    act(() => connectedTerminal());
    expect(result.current.composer.draft).toBe('saved prompt');
    act(() => result.current.submit('primary'));
    await waitFor(() => expect(agent.submit).toHaveBeenCalledOnce());
    act(() => result.current.setDraft('newer unsent text'));
    const input = vi.mocked(agent.submit).mock.calls[0][1];
    await act(async () => release({
      sessionId: view.summary.id, mode: input.mode, clientOperationId: input.clientOperationId,
    }));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    expect(result.current.composer.draft).toBe('newer unsent text');
    act(() => result.current.newSession());
    expect(result.current.composer.draft).toBe('');
    act(() => result.current.openSession(view.summary));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    expect(result.current.composer.draft).toBe('newer unsent text');
  });

  it('restores saved session drafts when terminal history opens automatically', async () => {
    connectedTerminal();
    const first = runningAgentView();
    const second = runningAgentView('agent-session-2', 'terminal-2');
    const agent = adapter({
      list: vi.fn(async (input) => ({ sessions: [input.scopeKey === second.summary.scopeKey ? second.summary : first.summary] })),
      open: vi.fn(async (id) => id === second.summary.id ? second : first),
    });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(first.summary.id));
    act(() => result.current.setDraft('session A draft'));
    act(() => connectedTerminal('terminal-2'));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(second.summary.id));
    expect(result.current.composer.draft).toBe('');
    act(() => result.current.setDraft('session B draft'));
    act(() => connectedTerminal());
    await waitFor(() => expect(result.current.view?.summary.id).toBe(first.summary.id));
    expect(result.current.composer.draft).toBe('session A draft');
    act(() => connectedTerminal('terminal-2'));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(second.summary.id));
    expect(result.current.composer.draft).toBe('session B draft');
  });

  it('remembers reading positions for navigation without rerendering on scroll', async () => {
    connectedTerminal();
    const view = runningAgentView();
    const agent = adapter({
      list: vi.fn(async () => ({ sessions: [view.summary] })),
      open: vi.fn(async () => view),
      subscribe: vi.fn((_id, listener) => { listener(view); return () => {}; }),
    });
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useAiSessionController({ scope: 'terminal', adapter: agent });
    });
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    const count = renders.mock.calls.length;
    const anchor = { nodeKey: 'node-250', offset: -50, scrollTop: 25_050 };
    act(() => {
      for (let index = 0; index < 60; index += 1) {
        result.current.saveScrollAnchor({ ...anchor, scrollTop: index * 100 });
      }
      result.current.saveScrollAnchor(anchor);
    });
    expect(renders).toHaveBeenCalledTimes(count);

    act(() => result.current.openSessions());
    await waitFor(() => expect(result.current.navigation.route.kind).toBe('sessions'));
    act(() => result.current.back());
    expect(result.current.navigation.scrollAnchorBySession[`agent:${view.summary.id}`]).toEqual(anchor);
  });

  it('shows an explicit disabled Agent state in Workbench without submitting a fallback', async () => {
    const agent = adapter();
    render(<AiWorkspaceController scope="workbench" adapter={agent} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Agent is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Open a connected terminal');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-disabled', 'true');
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
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-disabled', 'true');
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
    const history = await screen.findByRole('dialog', { name: 'Session history' });
    expect(await within(history).findByRole('alert')).toHaveTextContent('Agent history unavailable');
    fireEvent.click(within(history).getByRole('button', { name: 'Retry' }));

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
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('draft survives approval'));
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('opens Agent history without stopping the Runtime and hides unavailable new Workbench sessions', async () => {
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
    expect(await screen.findByRole('dialog', { name: 'Session history' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
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

    expect(textbox.textContent).toBe('');
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
    expect(textbox.textContent).toBe('newer draft');
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

    await userEvent.setup().type(screen.getByRole('textbox'), 'Run with operator access');
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

  it('previews builtins without creating a Session and sends the selected slash without a root', async () => {
    connectedTerminal();
    const cold = { ...runningAgentView(), status: 'idle' as const, summary: { ...runningAgentView().summary, status: 'idle' as const } };
    const agent = adapter({ create: vi.fn(async () => cold), listSkills: vi.fn(), submit: vi.fn(async (sessionId, input) => ({ sessionId: sessionId!, mode: input.mode, clientOperationId: input.clientOperationId })) });
    const user = userEvent.setup(); render(<AiWorkspaceController scope="terminal" adapter={agent} />);
    await user.type(screen.getByRole('textbox'), '/sys');
    await user.click(await screen.findByRole('option', { name: /system-status/ }));
    expect(agent.create).not.toHaveBeenCalled(); expect(agent.listSkills).not.toHaveBeenCalled(); expect(agent.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').textContent).toBe('/system-status ');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(null, expect.objectContaining({ content: '/system-status ', mode: 'start' })));
    expect(agent.create).not.toHaveBeenCalled();
    const request = vi.mocked(agent.submit).mock.calls[0][1].create;
    expect(request?.kind === 'agent' && request.request.target?.rootPath).toBeUndefined();
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


function steerableView(): AiSessionView {
  return { ...runningAgentView(), revision: 7, inbox: [{ id: 'queued', clientSubmissionId: 'original-submission', lane: 'nextTurn', content: 'queued text', state: 'queued', source: 'user' }] };
}

describe('Queue mutation controller', () => {
  it('guards same-render double clicks, keeps the projected row, and waits for the committed adapter', async () => {
    connectedTerminal();
    const view = steerableView();
    let finish: (() => void) | undefined;
    const mutateInbox = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view), mutateInbox });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent, operationId: () => 'steer-operation' }));
    await waitFor(() => expect(result.current.view?.summary.id).toBe(view.summary.id));
    act(() => { result.current.steerQueueItem(view.inbox[0]); result.current.steerQueueItem(view.inbox[0]); });
    expect(mutateInbox).toHaveBeenCalledOnce();
    expect(mutateInbox).toHaveBeenCalledWith({ sessionId: view.summary.id, type: 'steer', itemId: 'queued', expectedRevision: 7, clientOperationId: 'steer-operation' });
    expect(result.current.queueMutation?.status).toBe('pending');
    expect(result.current.view?.inbox).toEqual(view.inbox);
    await act(async () => finish?.());
    expect(result.current.queueMutation).toBeNull();
    expect(agent.submit).not.toHaveBeenCalled();
  });

  it('refreshes conflicts and retries with the same operation identity and latest revision', async () => {
    connectedTerminal();
    const view = steerableView();
    const refreshed = { ...view, revision: 9 };
    const mutateInbox = vi.fn().mockRejectedValueOnce(new Error('Agent Runtime revision conflict: expected revision 7, current revision 9')).mockResolvedValueOnce(undefined);
    const operationId = vi.fn(() => 'steer-retry');
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view), refresh: vi.fn(async () => refreshed), mutateInbox });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent, operationId }));
    await waitFor(() => expect(result.current.view?.revision).toBe(7));
    act(() => result.current.steerQueueItem(view.inbox[0]));
    await waitFor(() => expect(result.current.queueMutation?.status).toBe('failed'));
    expect(result.current.queueMutation?.conflict).toBe(true);
    expect(agent.refresh).toHaveBeenCalledWith(view.summary.id);
    act(() => result.current.retryQueueMutation());
    await waitFor(() => expect(result.current.queueMutation).toBeNull());
    expect(mutateInbox).toHaveBeenLastCalledWith({ sessionId: view.summary.id, type: 'steer', itemId: 'queued', expectedRevision: 9, clientOperationId: 'steer-retry' });
    expect(operationId).toHaveBeenCalledOnce();
  });

  it('retries an ambiguous failure with the same identity after consumption, and ignores navigation-stale failures', async () => {
    connectedTerminal();
    const view = steerableView();
    let publish: ((next: AiSessionView) => void) | undefined;
    const mutateInbox = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(undefined);
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view), subscribe: vi.fn((_id, callback) => { publish = callback; return () => undefined; }), mutateInbox });
    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent, operationId: () => 'same' }));
    await waitFor(() => expect(result.current.view?.revision).toBe(7));
    act(() => result.current.steerQueueItem(view.inbox[0]));
    await waitFor(() => expect(result.current.queueMutation?.status).toBe('failed'));
    act(() => publish?.({ ...view, revision: 12, inbox: [], status: 'idle' }));
    act(() => result.current.retryQueueMutation());
    await waitFor(() => expect(result.current.queueMutation).toBeNull());
    expect(mutateInbox).toHaveBeenLastCalledWith(expect.objectContaining({ clientOperationId: 'same', expectedRevision: 12 }));
    let reject: ((error: Error) => void) | undefined;
    mutateInbox.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    act(() => publish?.(view));
    act(() => result.current.steerQueueItem(view.inbox[0]));
    act(() => result.current.newSession());
    await act(async () => reject?.(new Error('old session failure')));
    expect(result.current.view).toBeNull();
    expect(result.current.queueMutation).toBeNull();
  });

  it('wires the production root/composer queue action to mutateInbox and removes a claimed row', async () => {
    connectedTerminal();
    const view = steerableView();
    let publish: ((next: AiSessionView) => void) | undefined;
    const agent = adapter({ list: vi.fn(async () => ({ sessions: [view.summary] })), open: vi.fn(async () => view), subscribe: vi.fn((_id, callback) => { publish = callback; return () => undefined; }) });
    render(<AiWorkspaceController scope="terminal" adapter={agent} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Steer now' }));
    await waitFor(() => expect(agent.mutateInbox).toHaveBeenCalledWith(expect.objectContaining({ type: 'steer', itemId: 'queued' })));
    act(() => publish?.({ ...view, inbox: [{ ...view.inbox[0], lane: 'nextStep', state: 'claimed' }] }));
    expect(screen.queryByText('queued text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Steer now' })).toBeNull();
  });
});
