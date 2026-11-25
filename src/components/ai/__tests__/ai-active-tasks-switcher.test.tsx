vi.mock('@tauri-apps/api/core', async () => ({ invoke: (await import('@/tests/llm-resolver-fixture')).fixtureResolve }));
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AiActiveTasksSwitcher,
  selectActiveWorkspaceTasks,
  shouldShowActiveTasksSwitcher,
} from '@/components/ai/workspace/ai-active-tasks-switcher';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import {
  useAiSessionController,
  type AiSessionControllerAdapter,
} from '@/components/ai/workspace/use-ai-session-controller';
import type { AiSessionSummary, AiSessionView } from '@/lib/ai/session-adapter';
import * as tauri from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentSessionEvent } from '@/types/agent-session';

function makeSummary(overrides: Partial<AiSessionSummary> & { id: string }): AiSessionSummary {
  return {
    kind: 'agent',
    title: `Task ${overrides.id}`,
    updatedAt: '2026-11-25T11:20:00.000Z',
    status: 'running',
    scopeKey: 'terminal-login:["root","8.216.9.10",22]',
    targetId: 'terminal-term-1',
    archived: false,
    ...overrides,
  };
}

function makeView(summary: AiSessionSummary): AiSessionView {
  return {
    summary,
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: summary.id,
          taskId: `task-${summary.id}`,
          goal: summary.title,
          title: summary.title,
          executionSurface: 'direct',
          createdAtUnixMs: Date.parse(summary.updatedAt),
          target: {
            kind: 'remote',
            targetId: summary.targetId ?? 'terminal-term-1',
            sessionId: (summary.targetId ?? 'terminal-term-1').replace(/^terminal-/, ''),
            host: '8.216.9.10',
            port: 22,
            username: 'root',
          },
          ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
        },
        status: summary.status,
        ended: ['completed', 'failed', 'cancelled'].includes(summary.status),
        archived: summary.archived,
        eventCount: 1,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: {
          kind: 'idle',
          status: 'none',
          summary: '',
          lastCommittedSeq: 0,
        },
      },
    },
    nodes: [],
    activityNodes: [],
    inbox: [],
    pendingApproval: null,
    status: summary.status,
    error: null,
    throughSeq: 0,
    canLoadOlder: false,
  };
}

function makeAdapter(changes: Partial<AiSessionControllerAdapter> = {}): AiSessionControllerAdapter {
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
    delete: vi.fn(async () => undefined),
    mutateInbox: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    refresh: vi.fn(async () => { throw new Error('unused refresh'); }),
    loadOlder: vi.fn(async () => []),
    loadArtifact: vi.fn(async () => { throw new Error('unused artifact'); }),
    dispose: vi.fn(),
    ...changes,
  };
}

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'zh-CN' });
  await initI18n('zh-CN');
  useTerminalStore.setState({ activeSessionId: null, sessions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('selectActiveWorkspaceTasks & shouldShowActiveTasksSwitcher', () => {
  it('filters to top-level active sessions for the current terminal and prioritizes waiting tasks', () => {
    const t1 = makeSummary({ id: 'agent-1', title: '并行只读环境与项目巡检', updatedAt: '2026-11-25T11:24:00.000Z', status: 'running' });
    const t2 = makeSummary({ id: 'agent-2', title: '资源巡检脚本规划确认', updatedAt: '2026-11-25T11:23:00.000Z', status: 'waiting' });
    const t3 = makeSummary({ id: 'agent-3', title: '本地 HTTP 服务启停验证', updatedAt: '2026-11-25T11:18:00.000Z', status: 'running' });
    const subagent = makeSummary({
      id: 'agent-child',
      parentSessionId: 'agent-1',
      subagent: { descriptorId: 'd-1', role: 'explorer', continuable: false, depth: 1 },
      status: 'running',
    });
    const completed = makeSummary({ id: 'agent-done', status: 'completed' });
    const archived = makeSummary({ id: 'agent-archived', status: 'running', archived: true });
    const otherTerminal = makeSummary({ id: 'agent-other', targetId: 'terminal-term-2', status: 'running' });

    const active = selectActiveWorkspaceTasks({
      sessions: [t1, t2, t3, subagent, completed, archived, otherTerminal],
      activeTargetIds: ['terminal-term-1'],
    });

    expect(active.map((task) => task.id)).toEqual(['agent-2', 'agent-1', 'agent-3']);
  });

  it('merges live currentView state over stale session summaries', () => {
    const stale = makeSummary({ id: 'agent-1', status: 'running', title: 'Old title' });
    const live = makeView(makeSummary({ id: 'agent-1', status: 'completed', title: 'Updated title' }));

    expect(selectActiveWorkspaceTasks({
      sessions: [stale],
      currentView: live,
      activeTargetIds: ['terminal-term-1'],
    })).toEqual([]);
  });

  it('shows switcher for multiple active tasks or a single background active task, but hides for a single viewed task', () => {
    const t1 = makeSummary({ id: 'agent-1' });
    const t2 = makeSummary({ id: 'agent-2' });

    expect(shouldShowActiveTasksSwitcher([], 'agent-1')).toBe(false);
    expect(shouldShowActiveTasksSwitcher([t1], 'agent-1')).toBe(false);
    expect(shouldShowActiveTasksSwitcher([t1], 'agent-other')).toBe(true);
    expect(shouldShowActiveTasksSwitcher([t1], null)).toBe(true);
    expect(shouldShowActiveTasksSwitcher([t1, t2], 'agent-1')).toBe(true);
  });
});

describe('AiActiveTasksSwitcher & AiWorkspaceRoot header integration', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'displays running task count in header and lets the user switch tasks in %s',
    async (locale) => {
      useAppStore.setState({ locale });
      await initI18n(locale);
      const user = userEvent.setup();
      const t1 = makeSummary({ id: 'agent-1', title: '并行只读环境与项目巡检', updatedAt: '2026-11-25T11:24:00.000Z', status: 'running' });
      const t2 = makeSummary({ id: 'agent-2', title: '资源巡检脚本规划确认', updatedAt: '2026-11-25T11:23:00.000Z', status: 'waiting' });
      const t3 = makeSummary({ id: 'agent-3', title: '本地 HTTP 服务启停验证', updatedAt: '2026-11-25T11:18:00.000Z', status: 'running' });
      const onOpenSession = vi.fn();
      const onRefreshSessions = vi.fn();

      const { container } = render(
        <AiWorkspaceRoot
          scope="terminal"
          mode="agent"
          view={makeView(t1)}
          sessions={[t1, t2, t3]}
          activeTerminalTargetIds={['terminal-term-1']}
          canStartAgent
          onNewSession={vi.fn()}
          onHistory={vi.fn()}
          onOpenSession={onOpenSession}
          onRefreshSessions={onRefreshSessions}
        />,
      );

      const header = container.querySelector<HTMLElement>('.ai-session-header')!;
      const trigger = header.querySelector<HTMLButtonElement>('[data-slot="ai-active-tasks-trigger"]')!;
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveClass('h-7', 'gap-1');
      expect(trigger).toHaveAttribute('data-attention', 'waiting');
      expect(trigger).toHaveTextContent(locale === 'zh-CN' ? '3 运行中' : '3 running');

      await user.click(trigger);
      expect(onRefreshSessions).toHaveBeenCalledOnce();

      const list = await screen.findByRole('list', {
        name: locale === 'zh-CN' ? '运行中的任务' : 'Running tasks',
      });
      const items = within(list).getAllByRole('button');
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent('资源巡检脚本规划确认');
      expect(items[1]).toHaveTextContent('并行只读环境与项目巡检');
      expect(items[1]).toHaveAttribute('aria-current', 'page');
      expect(items[2]).toHaveTextContent('本地 HTTP 服务启停验证');

      await user.click(items[0]);
      expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-2' }));
      await waitFor(() => {
        expect(screen.queryByRole('list', {
          name: locale === 'zh-CN' ? '运行中的任务' : 'Running tasks',
        })).toBeNull();
      });
    },
  );

  it('closes the popover without re-opening when clicking the current active task', async () => {
    const user = userEvent.setup();
    const t1 = makeSummary({ id: 'agent-1', title: 'Task 1', status: 'running' });
    const t2 = makeSummary({ id: 'agent-2', title: 'Task 2', status: 'running' });
    const onOpen = vi.fn();

    render(
      <AiActiveTasksSwitcher
        tasks={[t1, t2]}
        currentSessionId="agent-1"
        onOpen={onOpen}
      />,
    );

    const trigger = screen.getByRole('button');
    await user.click(trigger);
    const currentRow = await screen.findByRole('button', { name: /Task 1/ });
    await user.click(currentRow);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows the switcher on a new empty conversation when a background task is still running', () => {
    const t1 = makeSummary({ id: 'agent-1', title: 'Background inspection', status: 'running' });

    const { container } = render(
      <AiWorkspaceRoot
        scope="terminal"
        mode="agent"
        view={null}
        sessions={[t1]}
        activeTerminalTargetIds={['terminal-term-1']}
        canStartAgent
        onOpenSession={vi.fn()}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="ai-active-tasks-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveAttribute('data-attention', 'running');
    expect(trigger).toHaveTextContent('1 运行中');
  });
});

describe('useAiSessionController active sessions sync', () => {
  it('seeds sessions from terminal restore without extra list calls and updates background status live', async () => {
    useTerminalStore.setState({
      activeSessionId: 'term-1',
      sessions: [{
        sessionId: 'term-1',
        title: '8.216.9.10',
        host: '8.216.9.10',
        port: 22,
        username: 'root',
        status: 'connected',
        integrationState: 'ready',
        promptReady: true,
      }],
    });
    const t1 = makeSummary({ id: 'agent-1', title: 'Task 1', updatedAt: '2026-11-25T11:24:00.000Z', status: 'running' });
    const t2 = makeSummary({ id: 'agent-2', title: 'Task 2', updatedAt: '2026-11-25T11:23:00.000Z', status: 'running' });
    const t3 = makeSummary({ id: 'agent-3', title: 'Task 3', updatedAt: '2026-11-25T11:22:00.000Z', status: 'running' });
    const v1 = makeView(t1);
    let runtimeListener: ((event: { payload: AgentSessionEvent }) => void) | undefined;
    vi.spyOn(tauri, 'isTauriRuntime').mockReturnValue(true);
    vi.spyOn(tauri, 'listenToAgentRuntimeSession').mockImplementation(async (callback) => {
      runtimeListener = callback as (event: { payload: AgentSessionEvent }) => void;
      return () => { runtimeListener = undefined; };
    });
    const agent = makeAdapter({
      list: vi.fn(async () => ({ sessions: [t1, t2, t3] })),
      open: vi.fn(async () => v1),
      subscribe: vi.fn((_id, listener) => {
        listener(v1);
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAiSessionController({ scope: 'terminal', adapter: agent }));

    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(['agent-1', 'agent-2', 'agent-3']));
    expect(agent.list).toHaveBeenCalledOnce();
    await waitFor(() => expect(runtimeListener).toBeDefined());

    act(() => {
      runtimeListener?.({
        payload: {
          version: 5,
          sessionId: 'agent-2',
          seq: 12,
          timeUnixMs: Date.parse('2026-11-25T11:25:00.000Z'),
          type: 'agent/status',
          data: { status: 'waiting', reason: 'toolApprovalPending' },
        },
      });
    });

    expect(result.current.sessions.find((s) => s.id === 'agent-2')?.status).toBe('waiting');

    act(() => {
      runtimeListener?.({
        payload: {
          version: 5,
          sessionId: 'agent-3',
          seq: 18,
          timeUnixMs: Date.parse('2026-11-25T11:25:10.000Z'),
          type: 'session/ended',
          data: { status: 'completed' },
        },
      });
    });

    expect(result.current.sessions.find((s) => s.id === 'agent-3')?.status).toBe('completed');
    expect(agent.list).toHaveBeenCalledOnce();
  });
});
