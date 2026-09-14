import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSessionRecordsDialog } from '../ai-session-records-dialog';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import type { AgentSessionListItem } from '@/types/agent-session';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  cancel: vi.fn(),
  delete: vi.fn(),
  dispose: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ipc/tauri')>(),
  invokeArchiveAgentRuntimeSession: mocks.archive,
  invokeCancelAgentRuntime: mocks.cancel,
  invokeDeleteAgentRuntimeSession: mocks.delete,
  invokeListAgentRuntimeSessions: mocks.list,
}));

vi.mock('@/lib/ai/agent-session-adapter', () => ({
  createAgentSessionAdapter: () => ({ open: mocks.open, dispose: mocks.dispose }),
}));

vi.mock('../workspace/ai-conversation', () => ({
  AiConversation: ({ nodes }: { nodes: readonly unknown[] }) => (
    <div data-testid="conversation-transcript">{nodes.length} nodes</div>
  ),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: mocks.toastError, success: mocks.toastSuccess }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: (key: string, values?: Record<string, string>) => (
      values?.title ? `${key} ${values.title}` : key
    ),
  }),
}));

function record(id: string, targetId: string, title: string, createdAtUnixMs: number, options?: {
  archived?: boolean;
  ended?: boolean;
}): AgentSessionListItem {
  return {
    header: {
      sessionId: id,
      title,
      goal: title,
      taskId: `task-${id}`,
      target: { kind: 'local', targetId, sessionId: targetId, label: targetId },
      executionSurface: 'direct',
      createdAtUnixMs,
    },
    status: 'idle',
    ended: options?.ended ?? false,
    archived: options?.archived ?? false,
    eventCount: 3,
    pendingTurns: 0,
    pendingStepMessages: 0,
  } as AgentSessionListItem;
}

describe('AI conversation record management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ sessions: [] });
    mocks.cancel.mockResolvedValue({ ended: true });
    mocks.archive.mockResolvedValue({ archived: true });
    mocks.delete.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue({
      summary: { id: 'old-terminal', title: 'Old terminal conversation' },
      nodes: [{ kind: 'userMessage' }],
      status: 'idle',
      throughSeq: 3,
    } as unknown as AiSessionView);
  });

  it('lists records across terminal IDs and opens a read-only transcript', async () => {
    const oldTerminal = record('old-terminal', 'terminal-disconnected', 'Old terminal conversation', 200);
    const workbench = record('workbench', 'workbench-ai', 'Workbench conversation', 100);
    mocks.list.mockReset()
      .mockResolvedValueOnce({ sessions: [workbench], nextCursor: 'workbench' })
      .mockResolvedValueOnce({ sessions: [oldTerminal] });

    render(<AiSessionRecordsDialog onOpenChange={vi.fn()} />);

    const title = await screen.findByText('Old terminal conversation');
    expect(screen.getByText('Workbench conversation')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenNthCalledWith(1, { limit: 256 });
    expect(mocks.list).toHaveBeenNthCalledWith(2, { limit: 256, cursor: 'workbench' });

    const row = title.closest('.rounded-md')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'settings.ai.records.view' }));

    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('old-terminal'));
    expect(await screen.findByTestId('conversation-transcript')).toHaveTextContent('1 nodes');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.records.back' }));
    expect(mocks.dispose).toHaveBeenCalled();
    expect(screen.getByText('Workbench conversation')).toBeInTheDocument();
  });

  it('shows source records when viewing a continued conversation', async () => {
    const continuation = record('continued', 'terminal-new', 'Continued conversation', 300);
    mocks.list.mockResolvedValue({ sessions: [continuation] });
    mocks.open.mockImplementation(async (id: string) => ({
      summary: { id },
      snapshot: { value: { header: id === 'continued'
        ? { continuedFromSessionId: 'old-terminal' } : {} } },
      nodes: [{ kind: 'userMessage', key: `user:${id}`, sessionId: id }],
      status: 'idle', throughSeq: 3,
    } as unknown as AiSessionView));

    render(<AiSessionRecordsDialog onOpenChange={vi.fn()} />);
    const title = await screen.findByText('Continued conversation');
    fireEvent.click(within(title.closest('.rounded-md') as HTMLElement)
      .getByRole('button', { name: 'settings.ai.records.view' }));
    expect(await screen.findByTestId('conversation-transcript')).toHaveTextContent('2 nodes');
    expect(mocks.open).toHaveBeenCalledWith('old-terminal');
  });

  it('confirms and permanently deletes an active record in runtime order', async () => {
    const oldTerminal = record('old-terminal', 'terminal-disconnected', 'Old terminal conversation', 200);
    let available = [oldTerminal];
    mocks.list.mockImplementation(async () => ({ sessions: available }));
    mocks.delete.mockImplementation(async () => { available = []; });
    const onDeleted = vi.fn();
    window.addEventListener('shellspan:ai-session-deleted', onDeleted);

    render(<AiSessionRecordsDialog onOpenChange={vi.fn()} />);
    await screen.findByText('Old terminal conversation');
    fireEvent.click(screen.getByRole('button', {
      name: 'settings.ai.records.deleteNamed Old terminal conversation',
    }));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByText('settings.ai.records.deleteActiveDescription')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith({ sessionId: 'old-terminal' }));
    expect(mocks.cancel).toHaveBeenCalledWith({ sessionId: 'old-terminal' });
    expect(mocks.archive).toHaveBeenCalledWith({ sessionId: 'old-terminal' });
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.archive.mock.invocationCallOrder[0]);
    expect(mocks.archive.mock.invocationCallOrder[0]).toBeLessThan(mocks.delete.mock.invocationCallOrder[0]);
    expect(onDeleted).toHaveBeenCalledOnce();
    await screen.findByText('settings.ai.records.empty');
    window.removeEventListener('shellspan:ai-session-deleted', onDeleted);
  });

  it('deletes an archived record without cancelling it again', async () => {
    const archived = record('archived', 'terminal-old', 'Archived conversation', 100, {
      archived: true, ended: true,
    });
    mocks.list.mockResolvedValue({ sessions: [archived] });

    render(<AiSessionRecordsDialog onOpenChange={vi.fn()} />);
    await screen.findByText('Archived conversation');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.records.deleteNamed Archived conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith({ sessionId: 'archived' }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('does not archive or delete history still used by a continuation', async () => {
    const original = record('original', 'terminal-old', 'Original conversation', 100);
    const continuation = record('continued', 'terminal-new', 'Continued conversation', 200);
    mocks.list.mockResolvedValue({ sessions: [original, { ...continuation,
      header: { ...continuation.header, continuedFromSessionId: original.header.sessionId },
    }] });
    render(<AiSessionRecordsDialog onOpenChange={vi.fn()} />);
    await screen.findByText('Original conversation');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.records.deleteNamed Original conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    expect(mocks.toastError).toHaveBeenCalledWith('settings.ai.records.deleteReferenced');
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
