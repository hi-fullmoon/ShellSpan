import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiQueueDock } from '@/components/ai/workspace/ai-queue-dock';
import { AiSessionBrowser } from '@/components/ai/workspace/ai-session-browser';
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

    await user.click(screen.getAllByRole('button', { name: 'Move down in this lane' })[0]);
    expect(reorder).toHaveBeenCalledWith('nextTurn', ['item-b', 'item-a']);

    await user.click(screen.getAllByRole('button', { name: 'Remove queued input' })[1]);
    expect(remove).toHaveBeenCalledWith(queue[1]);
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
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
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
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
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
