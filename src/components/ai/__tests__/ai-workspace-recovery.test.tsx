vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/test/llm-resolver-fixture')).fixtureResolve }));
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@/test/composer-editor-user';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiPanelShell } from '../ai-panel';
import { AiWorkspaceController } from '../workspace/ai-workspace-controller';
import { useAiSessionController, type AiSessionControllerAdapter } from '../workspace/use-ai-session-controller';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAppStore } from '@/stores/appStore';
import { useLlmRoutesStore } from '@/stores/llmRoutesStore';
import { useTerminalStore } from '@/stores/terminalStore';
import * as vision from '@/lib/ai/vision-contract';

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/ai/image-drafts', () => ({ readImageDraft: storage.read, writeImageDraft: storage.write }));
const providerA = { id: 'provider-a', preset: 'custom' as const, profile: 'generic' as const, name: 'Provider A', kind: 'openAiCompatible' as const, baseUrl: 'https://a.invalid', model: 'model-a', requiresApiKey: false };
const providerB = { ...providerA, id: 'provider-b', name: 'Provider B', baseUrl: 'https://b.invalid', model: 'model-b' };
function view(id = 'session-a'): AiSessionView {
  return {
    summary: { id, kind: 'agent', title: id, updatedAt: '2026-09-03T00:00:00.000Z', status: 'running', scopeKey: 'terminal-terminal-1', targetId: 'terminal-terminal-1', archived: false },
    snapshot: { kind: 'agent', value: {
      header: { sessionId: id, taskId: 'task', goal: id, executionSurface: 'direct', createdAtUnixMs: 1, target: { kind: 'remote', targetId: 'terminal-terminal-1', sessionId: 'terminal-1' } },
      status: 'running', ended: false, archived: false, eventCount: 0,
      surface: { generation: 0, messages: [] }, inbox: { nextTurn: [], nextStep: [] }, task: { evidence: [] }, recovery: { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: 0 },
    } },
    nodes: [], activityNodes: [], inbox: [], pendingApproval: null, status: 'running', error: null, throughSeq: 10, canLoadOlder: false,
  };
}
function adapter(changes: Partial<AiSessionControllerAdapter> = {}): AiSessionControllerAdapter {
  return {
    kind: 'agent', list: vi.fn(async () => ({ sessions: [] })), create: vi.fn(async () => view()), open: vi.fn(async () => view()),
    subscribe: vi.fn(() => () => undefined), submit: vi.fn(async (sessionId, input) => ({ sessionId: sessionId!, clientOperationId: input.clientOperationId, mode: input.mode })),
    stop: vi.fn(async () => {}), approve: vi.fn(async () => {}), reject: vi.fn(async () => {}), answerQuestion: vi.fn(async () => {}),
    archive: vi.fn(async () => {}), delete: vi.fn(async () => {}), mutateInbox: vi.fn(async () => {}), rename: vi.fn(async () => {}), refresh: vi.fn(async () => view()),
    loadOlder: vi.fn(async () => []), loadArtifact: vi.fn(async () => { throw Error('unused'); }), dispose: vi.fn(), ...changes,
  };
}
beforeEach(async () => {
  await initI18n('en-US');
  useAppStore.setState({ locale: 'en-US' });
  useAiSettingsStore.setState({ providers: [providerA, providerB], defaultProviderId: providerA.id });
  useLlmRoutesStore.setState({ snapshot: undefined, status: 'idle', modelsByRoute: {} });
  useTerminalStore.setState({ activeSessionId: 'terminal-1', sessions: [{ sessionId: 'terminal-1', title: 'Remote', host: 'a.invalid', port: 22, username: 'tester', status: 'connected' }] });
  storage.read.mockReset().mockResolvedValue(null); storage.write.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('indexedDB', {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('preserves a plain-text draft when closing and reopening the panel', async () => {
  const agent = adapter();
  const user = userEvent.setup();
  const panel = (open: boolean) => (
    <AiPanelShell open={open} panelTitle="AI" scope="terminal" onOpenChange={() => {}}>
      <AiWorkspaceController scope="terminal" adapter={agent} />
    </AiPanelShell>
  );
  const { rerender } = render(panel(true));
  await user.type(screen.getByRole('textbox'), 'unsent work that must survive closing');
  expect(screen.getByRole('textbox')).toHaveTextContent('unsent work that must survive closing');
  rerender(panel(false));
  rerender(panel(true));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveTextContent('unsent work that must survive closing'));
});

it('shows model-change failures in the rendered panel', async () => {
  const current = view();
  const user = userEvent.setup();
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [current.summary] })),
    open: vi.fn(async () => current),
    selectModel: vi.fn(async () => { throw new Error('Provider unavailable'); }),
  });
  render(<AiWorkspaceController scope="terminal" adapter={agent} />);
  await waitFor(() => expect(agent.open).toHaveBeenCalled());
  await user.click(screen.getByRole('button', { name: /model-a/ }));
  await user.click(await screen.findByRole('menuitem', { name: /Model.*model-a/ }));
  await user.click(screen.getByRole('menuitemradio', { name: 'model-b' }));
  await waitFor(() => expect(agent.selectModel).toHaveBeenCalled());
  expect(await screen.findByText('Provider unavailable')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Action failed');
  expect(document.body.textContent).not.toContain('ai.workspace.announce.Provider unavailable');
  await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
  expect(screen.queryByText('Provider unavailable')).toBeNull();
});

it('keeps the original image provider while navigating during session creation', async () => {
  vi.spyOn(vision, 'requireVision').mockImplementation(() => {});
  storage.read.mockImplementation(async owner => owner.startsWith('new:') ? { owner, revision: 1, text: 'private image', images: [{ name: 'a.png', mediaType: 'image/png', data: 'aA==' }] } : null);
  const rawOther = view('session-b');
  const other: AiSessionView = {
    ...rawOther,
    snapshot: {
      kind: 'agent',
      value: {
        ...rawOther.snapshot.value,
        header: {
          ...rawOther.snapshot.value.header,
          modelSelection: { routeId: providerB.id, modelId: providerB.model },
        },
      },
    },
  };
  let finishCreate!: (value: AiSessionView) => void;
  const creation = new Promise<AiSessionView>(resolve => { finishCreate = resolve; });
  const agent = adapter({
    open: vi.fn(id => id === 'session-b' ? Promise.resolve(other) : Promise.reject(new Error('not yet created'))),
    create: vi.fn(() => creation),
  });
  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent, operationId: () => 'review-operation' }));
  await waitFor(() => expect(result.current.imageDraft.draft?.images).toHaveLength(1));
  act(() => result.current.submit('primary'));
  await waitFor(() => expect(agent.create).toHaveBeenCalled());
  act(() => result.current.openSession(other.summary));
  await waitFor(() => expect(result.current.view?.summary.id).toBe('session-b'));
  await act(async () => {
    finishCreate(view('agent-terminal-1-review-operation'));
  });
  await waitFor(() => expect(agent.submit).toHaveBeenCalled());
  expect(vi.mocked(agent.submit).mock.calls[0][1].provider.id).toBe(providerA.id);
});

it('loads all history pages, including an empty filtered page', async () => {
  const firstPage = Array.from({ length: 200 }, (_, i) => view(`old-${i}`).summary);
  const newest = { ...view('newest').summary, updatedAt: '2026-09-05T00:00:00.000Z' };
  const agent = adapter({ list: vi.fn(async input => input.cursor === 'page-3'
    ? { sessions: [newest] }
    : input.cursor === 'page-2' ? { sessions: [], nextCursor: 'page-3' }
    : { sessions: firstPage, nextCursor: 'page-2' }) });
  const { result } = renderHook(() => useAiSessionController({ scope: 'workbench', adapter: agent }));
  act(() => result.current.openSessions());
  await waitFor(() => expect(result.current.sessionsLoading).toBe(false));
  expect(result.current.sessions).toHaveLength(201);
  expect(result.current.sessions[0].id).toBe('newest');
});

it('restores the latest conversation from the runtime ascending session list', async () => {
  const oldest = view('oldest');
  const newest = { ...view('newest'), summary: { ...view('newest').summary, updatedAt: '2026-09-05T00:00:00.000Z' } };
  const agent = adapter({
    list: vi.fn(async input => input.cursor
      ? { sessions: [newest.summary] }
      : { sessions: [oldest.summary], nextCursor: 'page-2' }),
    open: vi.fn(async id => id === 'newest' ? newest : oldest),
  });
  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(result.current.view).not.toBeNull());
  expect(result.current.view?.summary.id).toBe('newest');
});

it('does not auto-restore a subagent as a top-level conversation', async () => {
  const parent = view('parent');
  const childSummary = {
    ...parent.summary,
    id: 'child',
    title: 'Delegated inspection',
    updatedAt: '2026-09-06T00:00:00.000Z',
    parentSessionId: parent.summary.id,
    subagent: {
      descriptorId: 'descriptor-child',
      role: 'explorer',
      continuable: false,
      depth: 1,
    },
  };
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [parent.summary, childSummary] })),
    open: vi.fn(async () => parent),
  });

  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));

  await waitFor(() => expect(result.current.view?.summary.id).toBe(parent.summary.id));
  expect(agent.open).toHaveBeenCalledWith(parent.summary.id);
  expect(agent.open).not.toHaveBeenCalledWith(childSummary.id);
});

it('auto-restores an orphaned subagent when its parent no longer exists', async () => {
  const child = view('orphan-child');
  const orphan = {
    ...child,
    summary: {
      ...child.summary,
      parentSessionId: 'deleted-parent',
      subagent: {
        descriptorId: 'descriptor-orphan',
        role: 'explorer',
        continuable: false,
        depth: 1,
      },
    },
  };
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [orphan.summary] })),
    open: vi.fn(async () => orphan),
  });

  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));

  await waitFor(() => expect(result.current.view?.summary.id).toBe(orphan.summary.id));
});

it('allows human follow-up only for a continuable subagent', async () => {
  const childBase = view('continuable-child');
  const child: AiSessionView = {
    ...childBase,
    summary: {
      ...childBase.summary,
      parentSessionId: 'parent-session',
      subagent: {
        descriptorId: 'descriptor-child',
        role: 'explorer',
        continuable: true,
        depth: 1,
      },
    },
    snapshot: {
      kind: 'agent',
      value: {
        ...childBase.snapshot.value,
        header: {
          ...childBase.snapshot.value.header,
          parentSessionId: 'parent-session',
          subagent: {
            descriptorId: 'descriptor-child',
            parentTaskId: 'parent-task',
            role: 'explorer',
            continuable: true,
            depth: 1,
            inheritance: { mode: 'blank' },
            capabilityScope: { toolNames: ['read_file'], effects: ['readOnly'], targetIds: [] },
            targetScope: [],
            budget: {
              maxStepsPerTurn: 8,
              maxTurns: 4,
              maxToolCalls: 16,
              maxTokens: 8_192,
              timeoutMs: 60_000,
            },
            provider: { routeId: providerA.id, modelId: providerA.model },
          },
        },
      },
    },
  };
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [child.summary] })),
    open: vi.fn(async () => child),
    subscribe: vi.fn((_id, listener) => { listener(child); return () => undefined; }),
  });
  const continuation = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));

  await waitFor(() => expect(continuation.result.current.view?.summary.id).toBe(child.summary.id));
  expect(continuation.result.current.readOnlySession).toBe(false);
  expect(continuation.result.current.composer.terminal).toBe(false);
  act(() => {
    continuation.result.current.setDraft('Continue the inspection.');
    continuation.result.current.submit('primary');
  });
  await waitFor(() => expect(agent.submit).toHaveBeenCalledWith(
    child.summary.id,
    expect.objectContaining({ content: 'Continue the inspection.' }),
  ));
  continuation.unmount();

  const oneShot: AiSessionView = {
    ...child,
    summary: {
      ...child.summary,
      subagent: { ...child.summary.subagent!, continuable: false },
    },
    snapshot: {
      kind: 'agent',
      value: {
        ...child.snapshot.value,
        header: {
          ...child.snapshot.value.header,
          subagent: { ...child.snapshot.value.header.subagent!, continuable: false },
        },
      },
    },
  };
  const oneShotAgent = adapter({
    list: vi.fn(async () => ({ sessions: [oneShot.summary] })),
    open: vi.fn(async () => oneShot),
    subscribe: vi.fn((_id, listener) => { listener(oneShot); return () => undefined; }),
  });
  const record = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: oneShotAgent }));
  await waitFor(() => expect(record.result.current.view?.summary.id).toBe(oneShot.summary.id));
  expect(record.result.current.readOnlySession).toBe(true);
  expect(record.result.current.composer.terminal).toBe(true);
  expect(record.result.current.agentUnavailableReason).toBe(
    'This is a one-shot subagent execution record and cannot accept follow-up messages.',
  );
});

it('restores existing session drafts independently after panel unmounts on different terminals', async () => {
  const first = view('session-a');
  const second = { ...view('session-b'),
    summary: { ...view('session-b').summary, scopeKey: 'terminal-terminal-2', targetId: 'terminal-terminal-2' },
    snapshot: { kind: 'agent' as const, value: { ...view('session-b').snapshot.value,
      header: { ...view('session-b').snapshot.value.header,
        target: { kind: 'remote' as const, targetId: 'terminal-terminal-2', sessionId: 'terminal-2' } } } } };
  const agent = adapter({
    list: vi.fn(async input => ({ sessions: [input.targetId === first.summary.targetId ? first.summary : second.summary] })),
    open: vi.fn(async id => id === first.summary.id ? first : second),
  });
  const terminalA = useTerminalStore.getState().sessions[0];
  useTerminalStore.setState({ sessions: [terminalA, { ...terminalA, sessionId: 'terminal-2' }] });
  const firstMount = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(firstMount.result.current.view?.summary.id).toBe('session-a'));
  act(() => firstMount.result.current.setDraft('draft for A'));
  firstMount.unmount();

  useTerminalStore.setState({ activeSessionId: 'terminal-2' });
  const secondMount = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(secondMount.result.current.view?.summary.id).toBe('session-b'));
  expect(secondMount.result.current.composer.draft).toBe('');
  act(() => secondMount.result.current.setDraft('draft for B'));
  secondMount.unmount();

  useTerminalStore.setState({ activeSessionId: 'terminal-1' });
  const restored = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(restored.result.current.composer.draft).toBe('draft for A'));
  act(() => useTerminalStore.setState({ activeSessionId: 'terminal-2' }));
  await waitFor(() => expect(restored.result.current.composer.draft).toBe('draft for B'));
});

it.each(['model', 'permission'] as const)('ignores late %s failures after leaving and revisiting a session', async setting => {
  const current = view();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const agent = adapter({
    list: vi.fn(async () => ({ sessions: [current.summary] })),
    open: vi.fn(async () => current),
    selectModel: vi.fn(() => pending), setPermission: vi.fn(() => pending),
  });
  const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));
  await waitFor(() => expect(result.current.view).not.toBeNull());
  let changing!: Promise<void>;
  act(() => { changing = setting === 'model' ? result.current.selectModel(providerB) : result.current.selectPermission('fullAccess'); });
  act(() => result.current.newSession());
  act(() => result.current.openSession(current.summary));
  await waitFor(() => expect(result.current.view).not.toBeNull());
  await act(async () => { reject(Error('earlier settings error')); await changing; });
  expect(result.current.composer.lastError).toBeNull();
  expect(result.current.settingsBusy).toBe(false);
});
