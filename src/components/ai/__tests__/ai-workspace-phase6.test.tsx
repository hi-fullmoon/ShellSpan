import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiQueueDock } from '@/components/ai/workspace/ai-queue-dock';
import { AiSessionBrowser } from '@/components/ai/workspace/ai-session-browser';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { createAiWorkspaceNavigationState } from '@/lib/ai/panel-route';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AiInboxItem, AiSessionSummary } from '@/lib/ai/session-adapter';

const queue: readonly AiInboxItem[] = [
  {
    id: 'item-a', clientSubmissionId: 'submission-a', lane: 'nextTurn',
    content: 'First queued task', state: 'queued', source: 'user',
  },
  {
    id: 'item-b', clientSubmissionId: 'submission-b', lane: 'nextTurn',
    content: 'Second queued task', state: 'queued', source: 'user',
  },
];

const agentSummary: AiSessionSummary = {
  id: 'agent-session-1',
  kind: 'agent',
  title: 'Original title',
  updatedAt: '2026-09-03T00:00:00.000Z',
  status: 'idle',
  scopeKey: 'terminal-1',
  archived: false,
  revision: 7,
};

beforeEach(async () => {
  cleanup();
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});

afterEach(cleanup);

describe('Phase 6 Queue Dock', () => {
  it('matches the single-row harness chrome without a redundant direction icon', () => {
    const { container } = render(<AiQueueDock items={[queue[0]]} />);
    const row = container.querySelector('.ai-queue-row');

    expect(row?.querySelectorAll(':scope > svg')).toHaveLength(1);
    expect(row?.querySelector('.ai-queue-row-content > svg')).toBeNull();
  });

  it('supports keyboard edit, remove, and complete same-lane reorder intents', async () => {
    const user = userEvent.setup();
    const update = vi.fn();
    const remove = vi.fn();
    const reorder = vi.fn();
    render(
      <AiQueueDock
        items={queue}
        onUpdate={update}
        onRemove={remove}
        onReorder={reorder}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: 'Edit queued input' })[0]);
    const input = screen.getByRole('textbox', { name: 'Queued input text' });
    await user.clear(input);
    await user.type(input, 'Updated task{Enter}');
    expect(update).toHaveBeenCalledWith(queue[0], 'Updated task');

    await user.click(screen.getAllByRole('button', { name: 'Reorder queued input' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Move down in this lane' }));
    expect(reorder).toHaveBeenCalledWith('nextTurn', ['item-b', 'item-a']);

    await user.click(screen.getAllByRole('button', { name: 'Remove queued input' })[1]);
    expect(remove).toHaveBeenCalledWith(queue[1]);
  });

  it('returns keyboard focus to the edit action on cancel and after a pending save settles', async () => {
    const user = userEvent.setup();
    const update = vi.fn();
    const { rerender } = render(<AiQueueDock items={[queue[0]]} onUpdate={update} />);
    await user.click(screen.getByRole('button', { name: 'Edit queued input' }));
    await user.type(screen.getByRole('textbox'), ' discarded{Escape}');
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit queued input' })).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit queued input' })).toHaveFocus();

    const save = (item: AiInboxItem, content: string): void => {
      update(item, content);
      rerender(<AiQueueDock items={[queue[0]]} onUpdate={save} mutation={{
        intent: { type: 'update', itemId: item.id, content }, status: 'pending', error: null, conflict: false,
      }} />);
    };
    rerender(<AiQueueDock items={[queue[0]]} onUpdate={save} />);
    await user.keyboard('{Enter}');
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Saved text{Enter}');
    expect(screen.getByRole('button', { name: 'Edit queued input' })).toBeDisabled();
    rerender(<AiQueueDock items={[{ ...queue[0], content: 'Saved text' }]} onUpdate={save} />);
    expect(screen.getByRole('button', { name: 'Edit queued input' })).toHaveFocus();
    expect(update).toHaveBeenCalledExactlyOnceWith(queue[0], 'Saved text');
  });

  it('shows pending and conflict retry without changing projected rows locally', async () => {
    const retry = vi.fn();
    const { rerender } = render(
      <AiQueueDock
        items={queue}
        mutation={{
          intent: { type: 'remove', itemId: 'item-a' },
          status: 'pending', error: null, conflict: false,
        }}
        onRetry={retry}
      />,
    );
    expect(screen.getByLabelText('Updating queued input')).toBeVisible();
    expect(screen.getByText('First queued task')).toBeVisible();

    rerender(
      <AiQueueDock
        items={queue}
        mutation={{
          intent: { type: 'remove', itemId: 'item-a' },
          status: 'failed', error: 'current revision 9', conflict: true,
        }}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('Queue changed elsewhere')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('Phase 6 Session Browser rename', () => {
  it('routes the history-page new button straight to Agent', async () => {
    const user = userEvent.setup();
    const onNewSession = vi.fn();
    render(
      <AiWorkspaceRoot
        view={null}
        scope="terminal"
        navigation={{ ...createAiWorkspaceNavigationState(), route: { kind: 'sessions' } }}
        canStartAgent
        onNewSession={onNewSession}
      />,
    );

    const newSessionButtons = screen.getAllByRole('button', { name: 'New conversation' });
    expect(newSessionButtons).toHaveLength(2);
    await user.click(newSessionButtons[0]);
    await user.click(newSessionButtons[1]);
    expect(onNewSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('keeps rename pending until the committed list projection carries the title', async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    const props = {
      loading: false,
      error: null,
      archivingId: null,
      renameError: null,
      onBack: vi.fn(),
      onNew: vi.fn(),
      onOpen: vi.fn(),
      onArchive: vi.fn(),
      onRename: rename,
    };
    const { rerender } = render(
      <AiSessionBrowser {...props} sessions={[agentSummary]} renamingId={null} />,
    );
    await user.hover(screen.getByRole('treeitem'));
    await user.click(screen.getByRole('button', { name: 'More actions for Original title' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename session' }));
    const input = screen.getByRole('textbox', { name: 'Session title' });
    await user.clear(input);
    await user.type(input, 'Committed title');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(rename).toHaveBeenCalledWith(agentSummary, 'Committed title');

    rerender(
      <AiSessionBrowser {...props} sessions={[agentSummary]} renamingId="agent-session-1" />,
    );
    expect(screen.getByRole('textbox', { name: 'Session title' })).toBeDisabled();

    rerender(
      <AiSessionBrowser
        {...props}
        sessions={[{ ...agentSummary, title: 'Committed title', revision: 8 }]}
        renamingId={null}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps only status filters, hides mode labels, and creates Agent sessions directly', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    const idleAgent: AiSessionSummary = {
      ...agentSummary, id: 'idle', title: 'Idle task', revision: undefined,
    };
    const runningAgent: AiSessionSummary = {
      ...agentSummary, id: 'shared', title: 'Running task', status: 'running',
    };
    const completedAgent: AiSessionSummary = {
      ...agentSummary, id: 'completed', title: 'Completed task', status: 'completed',
    };
    const archivedAgent: AiSessionSummary = {
      ...agentSummary, id: 'archived', title: 'Archived task', archived: true,
    };
    render(
      <AiSessionBrowser
        sessions={[idleAgent, runningAgent, completedAgent, archivedAgent]}
        activeSessionKey="agent:shared"
        loading={false}
        error={null}
        archivingId={null}
        canStartAgent
        onBack={vi.fn()}
        onNew={onNew}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('treeitem');
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.textContent?.includes('Running task'))).toHaveAttribute('aria-selected', 'true');
    expect(rows.find((row) => row.textContent?.includes('Idle task'))).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByText('Archived task')).toBeNull();
    expect(screen.getByText('Idle task').closest('button')).not.toHaveAttribute('title');

    await user.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Filter sessions' }));
    expect((await screen.findAllByRole('menuitemradio')).map((item) => item.textContent)).toEqual([
      'All',
      'Running',
      'Archived',
    ]);
    await user.keyboard('{Escape}');

    await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'completed');
    expect(screen.getAllByRole('treeitem')).toHaveLength(1);
    expect(screen.getByText('Completed task')).toBeVisible();

    await user.clear(screen.getByRole('searchbox', { name: 'Search sessions' }));
    const completedRow = screen.getByText('Completed task').closest('[role="treeitem"]');
    expect(completedRow).not.toBeNull();
    await user.hover(completedRow!);
    await user.click(screen.getByRole('button', { name: 'More actions for Completed task' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Rename session' })).toBeNull();
  });

  it('retains the rename input and exposes a revision conflict', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AiSessionBrowser
        sessions={[agentSummary]}
        loading={false}
        error={null}
        archivingId={null}
        renamingId={null}
        renameError={null}
        onBack={vi.fn()}
        onNew={vi.fn()}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    await user.hover(screen.getByRole('treeitem'));
    await user.click(screen.getByRole('button', { name: 'More actions for Original title' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename session' }));
    await user.clear(screen.getByRole('textbox', { name: 'Session title' }));
    await user.type(screen.getByRole('textbox', { name: 'Session title' }), 'Retry title');
    rerender(
      <AiSessionBrowser
        sessions={[agentSummary]}
        loading={false}
        error={null}
        archivingId={null}
        renamingId={null}
        renameError="Agent Runtime revision conflict: current revision 9"
        onBack={vi.fn()}
        onNew={vi.fn()}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    expect(screen.getByText(/current revision 9/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Session title' })).toHaveValue('Retry title');
  });
});


describe('Queue steering controls', () => {
  it('steers a single row independently of ordering and explains the step boundary', async () => {
    const user = userEvent.setup();
    const steer = vi.fn();
    const reorder = vi.fn();
    const { rerender } = render(<AiQueueDock items={[queue[0]]} running onSteer={steer} onReorder={reorder} />);
    const button = screen.getByRole('button', { name: 'Steer now' });
    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Use this input at the next step of the current task. The model or tool call in progress will finish first.');
    await user.click(button);
    expect(steer).toHaveBeenCalledWith(queue[0]);
    expect(reorder).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reorder queued input' })).toBeNull();
    rerender(<AiQueueDock items={[queue[0]]} running onSteer={steer} mutation={{ intent: { type: 'steer', itemId: queue[0].id }, status: 'pending', error: null, conflict: false }} />);
    expect(screen.getByRole('button', { name: 'Steer now' })).toBeDisabled();
    expect(screen.getByLabelText('Updating queued input')).toBeVisible();
    expect(screen.getByText(queue[0].content)).toBeVisible();
  });

  it.each([
    { item: queue[0], running: false, mutable: true },
    { item: queue[0], running: true, mutable: false },
    { item: { ...queue[0], lane: 'nextStep' as const }, running: true, mutable: true },
    { item: { ...queue[0], state: 'pending' as const }, running: true, mutable: true },
    { item: { ...queue[0], state: 'claimed' as const }, running: true, mutable: true },
    { item: { ...queue[0], source: 'runtime' as const }, running: true, mutable: true },
  ])('does not offer steer for an ineligible row: %j', ({ item, running, mutable }) => {
    render(<AiQueueDock items={[item]} running={running} mutable={mutable} onSteer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Steer now' })).toBeNull();
  });

  it('keeps a failed operation visible and retryable after the queue becomes empty', async () => {
    const retry = vi.fn();
    render(<AiQueueDock items={[]} onRetry={retry} mutation={{ intent: { type: 'steer', itemId: 'gone' }, status: 'failed', error: 'receipt unavailable', conflict: false }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('receipt unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('localizes the dedicated action and timing in Chinese', async () => {
    useAppStore.setState({ locale: 'zh-CN' });
    await initI18n('zh-CN');
    const user = userEvent.setup();
    render(<AiQueueDock items={[queue[0]]} running onSteer={vi.fn()} />);
    await user.hover(screen.getByRole('button', { name: '立即介入' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('在当前任务的下一步骤生效；正在进行的模型或工具调用会先完成。');
  });
});
